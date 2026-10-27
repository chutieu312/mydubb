"""Guest access ("Try as guest"): sessions, ownership, quotas, settling, recovery and the client
network, against PostgreSQL and mock providers. No test talks to Cognito, Azure or Supadata.
"""

import base64
import logging
import threading
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.audio.speed import AudioSpeed
from app.config import Settings
from app.dependencies import AUTH_COOKIE, GUEST_COOKIE
from app.guest import service as guest_service
from app.guest.client_ip import network_key, network_of
from app.guest.service import GuestPolicy, GuestQuotaExceeded
from app.jobs import service as job_service
from app.jobs.models import JobStatus
from app.transcript.timestamps import format_seconds
from tests.conftest import (
    COGNITO_SETTINGS,
    TEST_ENCRYPTION_KEY,
    VALID_JOB,
    sign_in,
    wait_for_terminal,
)

IP_HEADER = "x-test-client-ip"
IP_A = "203.0.113.10"
IP_B = "198.51.100.20"
GUEST_KEY = base64.urlsafe_b64encode(b"g" * 32).decode()
GUEST_SETTINGS: dict[str, Any] = {
    **COGNITO_SETTINGS,
    "guest_access_enabled": True,
    "guest_ip_hash_key": GUEST_KEY,
    "client_ip_header": IP_HEADER,
}
EMAIL = "lan@example.com"
PASSWORD = "correct-horse-1"


@pytest.fixture
def make_guest_client(make_cognito_client) -> Callable[..., TestClient]:
    return lambda **overrides: make_cognito_client(**{**GUEST_SETTINGS, **overrides})


@pytest.fixture
def guest_client(make_guest_client) -> TestClient:
    return make_guest_client()


def start_guest(client: TestClient, ip: str = IP_A) -> dict:
    response = client.post("/api/guest/session", headers={IP_HEADER: ip})
    assert response.status_code in (200, 201), response.text
    return response.json()


def guest_job(client: TestClient, csrf: str, ip: str = IP_A, **overrides: Any):
    return client.post(
        "/api/jobs",
        json={**VALID_JOB, **overrides},
        headers={"X-CSRF-Token": csrf, IP_HEADER: ip},
    )


def run_guest_job(client: TestClient, csrf: str, ip: str = IP_A, **overrides: Any) -> dict:
    response = guest_job(client, csrf, ip, **overrides)
    assert response.status_code == 202, response.text
    return wait_for_terminal(client, response.json()["id"])


def quota(client: TestClient, ip: str = IP_A) -> dict:
    response = client.get("/api/guest/session", headers={IP_HEADER: ip})
    assert response.status_code == 200, response.text
    return response.json()["quota"]


def quota_rows(db_engine) -> list:
    with db_engine.connect() as conn:
        return conn.execute(
            text("SELECT job_id, guest_session_id, ip_key, state FROM guest_job_quota")
        ).all()


def ip_key_of(ip: str) -> str:
    network = network_of(ip)
    assert network is not None
    return network_key(network, base64.urlsafe_b64decode(GUEST_KEY))


def words(count: int) -> str:
    return " ".join(f"word{i}" for i in range(count))


# -- configuration and meta -------------------------------------------------------------------


def test_guest_access_is_off_by_default(cognito_client, client):
    assert cognito_client.get("/api/meta").json()["guest_access"] == {"enabled": False}
    for path in ("/api/guest/session",):
        assert cognito_client.get(path).json()["error"]["code"] == "guest_access_disabled"
        response = cognito_client.post(path, headers={IP_HEADER: IP_A})
        assert response.status_code == 404
    # A guest cookie is meaningless while guest access is off.
    cognito_client.cookies.set(GUEST_COOKIE, "anything")
    assert cognito_client.get(f"/api/jobs/{uuid.uuid4()}").status_code == 401
    # Access Code mode too.
    assert client.get("/api/meta").json()["guest_access"] == {"enabled": False}


def test_meta_reports_the_limits(guest_client):
    assert guest_client.get("/api/meta").json()["guest_access"] == {
        "enabled": True,
        "jobs_per_session": 5,
        "jobs_per_ip": 20,
        "ip_window_seconds": 86400,
        "max_words": 1000,
        "max_output_seconds": 600,
        "session_ttl_seconds": 86400,
    }


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"auth_mode": "access_code", "access_code": "correct-access-code"}, "AUTH_MODE=cognito"),
        ({"guest_ip_hash_key": None}, "GUEST_IP_HASH_KEY is required"),
        ({"guest_ip_hash_key": "short"}, "GUEST_IP_HASH_KEY is required"),
        ({"guest_ip_hash_key": TEST_ENCRYPTION_KEY}, "must differ"),
        ({"guest_session_ttl_seconds": 7200, "guest_ip_window_seconds": 3600}, "must not exceed"),
        ({"app_env": "production", "client_ip_header": None}, "CLIENT_IP_HEADER"),
    ],
)
def test_configuration_is_checked_at_startup(make_settings, overrides, message):
    with pytest.raises(ValueError, match=message):
        make_settings(**{**GUEST_SETTINGS, **overrides})


# -- the guest session ------------------------------------------------------------------------


def test_starting_a_guest_session_sets_a_secure_cookie_and_stores_only_hashes(
    make_guest_client, db_engine, caplog
):
    caplog.set_level(logging.DEBUG)
    client = make_guest_client(cookie_secure=True)
    response = client.post("/api/guest/session", headers={IP_HEADER: IP_A})
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "guest" and body["csrf_token"]
    assert body["quota"]["session_remaining"] == 5 and body["quota"]["ip_remaining"] == 20
    assert body["quota"]["max_words"] == 1000
    assert body["quota"]["max_output_seconds"] == 600
    raw = response.headers["set-cookie"]
    cookie = raw.lower()
    assert cookie.startswith(f"{GUEST_COOKIE}=")
    for flag in ("httponly", "samesite=strict", "secure", "path=/"):
        assert flag in cookie
    max_age = int(cookie.split("max-age=")[1].split(";")[0])
    assert 86390 <= max_age <= 86400  # the absolute session lifetime (24 h)
    token = raw.split(f"{GUEST_COOKIE}=")[1].split(";")[0]
    assert len(token) >= 40

    with db_engine.connect() as conn:
        row = conn.execute(text("SELECT token_hash, ip_key FROM guest_sessions")).one()
        jobs = conn.execute(text("SELECT count(*) FROM jobs")).scalar_one()
    assert token not in row.token_hash and len(row.token_hash) == 64
    assert row.ip_key == ip_key_of(IP_A) and IP_A not in row.ip_key
    assert jobs == 0  # starting a session creates no job (and calls no provider)
    assert IP_A not in caplog.text and token not in caplog.text


def test_starting_again_returns_the_same_session_without_renewing_it(guest_client, db_engine):
    first = start_guest(guest_client)
    run_guest_job(guest_client, first["csrf_token"])
    again = guest_client.post("/api/guest/session", headers={IP_HEADER: IP_A})
    assert again.status_code == 200
    assert "set-cookie" not in again.headers
    body = again.json()
    assert body["guest"]["id"] == first["guest"]["id"]
    assert body["expires_at"] == first["expires_at"]
    assert body["quota"]["session_used"] == 1  # the quota is not reset
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM guest_sessions")).scalar_one() == 1


def test_a_signed_in_user_cannot_start_a_guest_session(guest_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(guest_client, EMAIL, PASSWORD)
    response = guest_client.post("/api/guest/session", headers={IP_HEADER: IP_A})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "already_signed_in"


def test_cross_origin_start_is_rejected(guest_client, db_engine):
    response = guest_client.post(
        "/api/guest/session", headers={IP_HEADER: IP_A, "Origin": "https://evil.example"}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "origin_rejected"
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM guest_sessions")).scalar_one() == 0


def test_csrf_is_required_to_create_jobs_and_end_the_session(guest_client, db_engine):
    session = start_guest(guest_client)
    no_csrf = guest_client.post("/api/jobs", json=VALID_JOB, headers={IP_HEADER: IP_A})
    assert no_csrf.status_code == 403 and no_csrf.json()["error"]["code"] == "csrf_failed"
    wrong = guest_job(guest_client, "not-the-token")
    assert wrong.status_code == 403
    assert guest_client.delete("/api/guest/session").status_code == 403
    assert quota_rows(db_engine) == []
    ok = guest_client.delete("/api/guest/session", headers={"X-CSRF-Token": session["csrf_token"]})
    assert ok.status_code == 204


def test_guest_creates_polls_reads_and_downloads_its_own_job(guest_client):
    session = start_guest(guest_client)
    job = run_guest_job(guest_client, session["csrf_token"])
    assert job["status"] == "completed"
    result = guest_client.get(f"/api/jobs/{job['id']}/result")
    assert result.status_code == 200
    audio = guest_client.get(f"/api/jobs/{job['id']}/result/audio?download=1")
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/mpeg"
    assert quota(guest_client)["session_remaining"] == 4


def test_ending_the_session_stops_access_and_moves_nothing(guest_client, db_engine):
    session = start_guest(guest_client)
    job = run_guest_job(guest_client, session["csrf_token"])
    ended = guest_client.delete(
        "/api/guest/session", headers={"X-CSRF-Token": session["csrf_token"]}
    )
    assert ended.status_code == 204
    assert GUEST_COOKIE in ended.headers["set-cookie"]
    assert guest_client.get(f"/api/jobs/{job['id']}").status_code == 401
    assert guest_client.get("/api/guest/session").status_code == 401
    with db_engine.connect() as conn:
        row = conn.execute(text("SELECT guest_session_id, user_id, session_id FROM jobs")).one()
    assert str(row.guest_session_id) == session["guest"]["id"]
    assert row.user_id is None and row.session_id is None


def test_an_expired_guest_session_is_refused(guest_client, db_engine):
    session = start_guest(guest_client)
    job = run_guest_job(guest_client, session["csrf_token"])
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE guest_sessions SET expires_at = now() - interval '1 second'"))
    assert guest_client.get(f"/api/jobs/{job['id']}").status_code == 401
    assert guest_job(guest_client, session["csrf_token"]).status_code == 401


# -- ownership and what a guest may not do ----------------------------------------------------


def test_guests_and_users_never_see_each_others_jobs(make_guest_client, fake_cognito):
    guest_a = make_guest_client()
    guest_b = make_guest_client()
    user = make_guest_client()
    job_a = run_guest_job(guest_a, start_guest(guest_a)["csrf_token"])["id"]
    start_guest(guest_b)
    fake_cognito.add_user(EMAIL, PASSWORD)
    csrf = sign_in(user, EMAIL, PASSWORD)["csrf_token"]
    created = user.post("/api/jobs", json=VALID_JOB, headers={"X-CSRF-Token": csrf})
    job_user = wait_for_terminal(user, created.json()["id"])["id"]

    for path in ("", "/result", "/result/audio"):
        assert guest_b.get(f"/api/jobs/{job_a}{path}").status_code == 404
        assert user.get(f"/api/jobs/{job_a}{path}").status_code == 404
        assert guest_a.get(f"/api/jobs/{job_user}{path}").status_code == 404
    assert guest_a.get(f"/api/jobs/{job_a}/result").status_code == 200


def test_guest_cannot_use_youtube_import_or_account_endpoints(make_guest_client):
    client = make_guest_client(youtube_import_provider="mock")
    session = start_guest(client)
    csrf = {"X-CSRF-Token": session["csrf_token"]}
    imported = client.post(
        "/api/transcripts/youtube", json={"url": "https://youtu.be/dQw4w9WgXcQ"}, headers=csrf
    )
    assert imported.status_code == 403
    assert imported.json()["error"]["code"] == "guest_not_allowed"
    # Account endpoints: a guest is not signed in.
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/logout", headers=csrf).status_code == 401
    # Access Code endpoints do not exist in Cognito mode.
    assert client.get("/api/session").status_code in (404, 405)


def test_signing_in_ends_the_guest_session_and_keeps_jobs_apart(guest_client, fake_cognito):
    session = start_guest(guest_client)
    job = run_guest_job(guest_client, session["csrf_token"])["id"]
    fake_cognito.add_user(EMAIL, PASSWORD)
    response = guest_client.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert response.status_code == 200
    cookies = response.headers.get_list("set-cookie")
    assert any(c.startswith(f"{GUEST_COOKIE}=") and "max-age=0" in c.lower() for c in cookies)
    assert any(c.startswith(f"{AUTH_COOKIE}=") for c in cookies)
    # The user does not get the guest's job.
    assert guest_client.get(f"/api/jobs/{job}").status_code == 404
    # Signing out does not fall back to the guest session: it has ended.
    csrf = response.json()["csrf_token"]
    assert guest_client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    guest_client.cookies.set(GUEST_COOKIE, "stale")
    assert guest_client.get("/api/guest/session").status_code == 401
    assert guest_client.get(f"/api/jobs/{job}").status_code == 401


def test_invitation_accounts_have_no_guest_limits(guest_client, fake_cognito, db_engine):
    fake_cognito.add_user(EMAIL, PASSWORD)
    csrf = sign_in(guest_client, EMAIL, PASSWORD)["csrf_token"]
    headers = {"X-CSRF-Token": csrf}
    for _ in range(6):
        created = guest_client.post("/api/jobs", json=VALID_JOB, headers=headers)
        assert created.status_code == 202
        assert wait_for_terminal(guest_client, created.json()["id"])["status"] == "completed"
    long = guest_client.post(
        "/api/jobs", json={**VALID_JOB, "transcript": words(1500)}, headers=headers
    )
    assert long.status_code == 202
    wait_for_terminal(guest_client, long.json()["id"])
    assert quota_rows(db_engine) == []


# -- word limit -------------------------------------------------------------------------------


def test_word_limit_counts_the_text_to_translate(guest_client, db_engine):
    csrf = start_guest(guest_client)["csrf_token"]
    assert run_guest_job(guest_client, csrf, transcript=words(1000))["status"] == "completed"

    over = guest_job(guest_client, csrf, transcript=words(1001))
    assert over.status_code == 422
    error = over.json()["error"]
    assert error["code"] == "guest_word_limit_exceeded"
    assert (error["word_count"], error["max_words"]) == (1001, 1000)
    assert error["fields"][0]["field"] == "transcript"
    assert len(quota_rows(db_engine)) == 1  # the refused job used up nothing

    # Timestamp lines and lone punctuation are not words.
    timed = "\n".join(f"0:{i:02d}\n{words(100)} —" for i in range(10))
    response = guest_job(
        guest_client,
        csrf,
        transcript=timed,
        timing_mode="timed",
        first_sentence_start="00:00:00",
        last_sentence_start="00:00:09",
    )
    assert response.status_code == 202, response.text
    plain = "\n".join(f"00:00:{i:02d}\n{words(100)}" for i in range(10))
    wait_for_terminal(guest_client, response.json()["id"])
    assert run_guest_job(guest_client, csrf, transcript=plain)["status"] == "completed"


# -- output duration limit -------------------------------------------------------------------

# Baselines (seconds) that give exactly 600 s of audio at each speed: baseline = 600 x speed.
AT_LIMIT = {0.5: 300, 0.75: 450, 1: 600, 1.25: 750, 1.5: 900, 1.75: 1050, 2: 1200}


def times(baseline: int) -> dict:
    return {"first_sentence_start": "00:00:00", "last_sentence_start": format_seconds(baseline)}


@pytest.mark.parametrize("speed", list(AT_LIMIT))
def test_output_duration_limit_at_every_speed(make_guest_client, db_engine, speed):
    client = make_guest_client()
    csrf = start_guest(client)["csrf_token"]
    baseline = AT_LIMIT[speed]

    over = guest_job(client, csrf, speed=speed, **times(baseline + 1))
    assert over.status_code == 422, over.text
    error = over.json()["error"]
    assert error["code"] == "guest_duration_limit_exceeded"
    assert error["max_output_seconds"] == 600 and error["baseline_seconds"] == baseline + 1
    assert error["output_seconds"] == pytest.approx((baseline + 1) / speed)
    assert error["output_seconds"] > 600 and error["speed"] == speed
    assert error["fields"][0]["field"] == "last_sentence_start"
    assert "10:00" in error["message"]
    assert quota_rows(db_engine) == []

    at = guest_job(client, csrf, speed=speed, **times(baseline))
    assert at.status_code == 202, at.text
    job = wait_for_terminal(client, at.json()["id"])
    # The timestamps were taken as sent, never adjusted.
    assert job["baseline_duration_seconds"] == baseline
    assert job["output_duration_seconds"] == 600


def test_five_minutes_at_half_speed_is_the_limit(guest_client):
    csrf = start_guest(guest_client)["csrf_token"]
    at = guest_job(
        guest_client,
        csrf,
        speed=0.5,
        first_sentence_start="00:01:00",
        last_sentence_start="00:06:00",
    )
    assert at.status_code == 202
    over = guest_job(
        guest_client,
        csrf,
        speed=0.5,
        first_sentence_start="00:01:00",
        last_sentence_start="00:06:01",
    )
    assert over.json()["error"]["code"] == "guest_duration_limit_exceeded"
    assert over.json()["error"]["output_seconds"] == 602


def test_a_short_transcript_with_a_ten_hour_baseline_is_refused_before_anything(
    make_guest_client, db_engine
):
    # The review case: two words, 10 h baseline at 1x passes validation and the word limit.
    client = make_guest_client(job_max_concurrency=1, job_max_queued=0)
    csrf = start_guest(client)["csrf_token"]
    response = guest_job(
        client,
        csrf,
        transcript="Hello world.",
        first_sentence_start="00:00:00",
        last_sentence_start="10:00:00",
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "guest_duration_limit_exceeded"
    # No job, no quota place, and the only executor slot is still free.
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0
    assert quota_rows(db_engine) == []
    assert run_guest_job(client, csrf)["status"] == "completed"
    # Also refused before the network check: a request without the header gets the 422.
    no_ip = client.post(
        "/api/jobs",
        json={**VALID_JOB, "last_sentence_start": "10:00:00"},
        headers={"X-CSRF-Token": csrf},
    )
    assert no_ip.json()["error"]["code"] == "guest_duration_limit_exceeded"


def test_accounts_keep_long_audio(guest_client, fake_cognito, db_engine):
    fake_cognito.add_user(EMAIL, PASSWORD)
    csrf = sign_in(guest_client, EMAIL, PASSWORD)["csrf_token"]
    response = guest_client.post(
        "/api/jobs",
        json={**VALID_JOB, "first_sentence_start": "00:00:00", "last_sentence_start": "10:00:00"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 202
    assert response.json()["output_duration_seconds"] == 36000
    wait_for_terminal(guest_client, response.json()["id"])
    assert quota_rows(db_engine) == []


def test_validation_errors_and_a_full_server_use_up_nothing(make_guest_client, db_engine):
    client = make_guest_client(
        job_max_concurrency=1, job_max_queued=0, mock_stage_delay_seconds=1.0
    )
    csrf = start_guest(client)["csrf_token"]
    bad = guest_job(client, csrf, last_sentence_start="00:00:01")
    assert bad.status_code == 422
    first = guest_job(client, csrf)
    assert first.status_code == 202
    busy = guest_job(client, csrf)
    assert busy.status_code == 503 and busy.json()["error"]["code"] == "server_at_capacity"
    assert len(quota_rows(db_engine)) == 1
    wait_for_terminal(client, first.json()["id"])
    assert quota(client)["session_remaining"] == 4


# -- quotas -----------------------------------------------------------------------------------


def test_five_completed_jobs_per_session(guest_client):
    csrf = start_guest(guest_client)["csrf_token"]
    for _ in range(5):
        assert run_guest_job(guest_client, csrf)["status"] == "completed"
    refused = guest_job(guest_client, csrf)
    assert refused.status_code == 429
    error = refused.json()["error"]
    assert error["code"] == "guest_session_quota_exhausted"
    assert "invitation" in error["message"]
    assert quota(guest_client)["session_remaining"] == 0


def test_twenty_completed_jobs_per_network_shared_by_sessions(guest_client, db_engine):
    for _ in range(4):
        guest_client.cookies.clear()
        csrf = start_guest(guest_client)["csrf_token"]
        for _ in range(5):
            assert run_guest_job(guest_client, csrf)["status"] == "completed"
    guest_client.cookies.clear()
    csrf = start_guest(guest_client)["csrf_token"]
    assert quota(guest_client)["ip_remaining"] == 0
    refused = guest_job(guest_client, csrf)
    assert refused.status_code == 429
    error = refused.json()["error"]
    assert error["code"] == "guest_ip_quota_exhausted"
    retry = int(refused.headers["retry-after"])
    assert 86000 < retry <= 86400 and error["retry_after_seconds"] == retry
    # Another network is not affected, even with the same session.
    assert run_guest_job(guest_client, csrf, ip=IP_B)["status"] == "completed"
    assert len(quota_rows(db_engine)) == 21


def test_ipv6_addresses_of_one_slash_64_share_a_quota(make_guest_client):
    client = make_guest_client(guest_jobs_per_ip=2)
    csrf = start_guest(client, ip="2001:db8:1:2::1")["csrf_token"]
    run_guest_job(client, csrf, ip="2001:db8:1:2::1")
    run_guest_job(client, csrf, ip="2001:db8:1:2:aaaa::9")
    refused = guest_job(client, csrf, ip="2001:db8:1:2:ffff:ffff:ffff:ffff")
    assert refused.json()["error"]["code"] == "guest_ip_quota_exhausted"
    assert guest_job(client, csrf, ip="2001:db8:1:3::1").status_code == 202


def test_the_network_window_slides(make_guest_client, db_engine):
    client = make_guest_client(guest_jobs_per_ip=2)
    csrf = start_guest(client)["csrf_token"]
    first = run_guest_job(client, csrf)["id"]
    run_guest_job(client, csrf)
    assert guest_job(client, csrf).status_code == 429
    # Just inside the window: still counted.
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE guest_job_quota SET charged_at = now() - interval '86399 seconds' "
                "WHERE job_id = :id"
            ),
            {"id": first},
        )
    refused = guest_job(client, csrf)
    assert refused.status_code == 429 and int(refused.headers["retry-after"]) <= 2
    # Just outside: the place is free again (the session quota is lifetime and unaffected).
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE guest_job_quota SET charged_at = now() - interval '86401 seconds' "
                "WHERE job_id = :id"
            ),
            {"id": first},
        )
    assert guest_job(client, csrf).status_code == 202
    assert quota(client)["session_used"] + quota(client)["session_in_progress"] == 3


def test_failed_jobs_give_their_place_back(make_guest_client, db_engine):
    client = make_guest_client(mock_fail_stage="translation")
    csrf = start_guest(client)["csrf_token"]
    for _ in range(6):
        assert run_guest_job(client, csrf)["status"] == "failed"
    states = {row.state for row in quota_rows(db_engine)}
    assert states == {"released"}
    assert quota(client)["session_remaining"] == 5


# -- concurrency, settling and recovery (service level, real PostgreSQL) ----------------------


POLICY = GuestPolicy(
    session_ttl_seconds=86400,
    jobs_per_session=5,
    jobs_per_ip=20,
    ip_window_seconds=86400,
    max_words=1000,
    max_output_seconds=600,
    sessions_per_ip=1000,
    sessions_global=1000,
    session_rate_window_seconds=3600,
)


@pytest.fixture
def factory(db_engine) -> sessionmaker:
    return sessionmaker(bind=db_engine, expire_on_commit=False)


def new_session(factory, ip: str = IP_A) -> uuid.UUID:
    with factory.begin() as db:
        return guest_service.start_session(db, ip_key=ip_key_of(ip), policy=POLICY).id


def reserve(factory, session_id: uuid.UUID, ip: str = IP_A, runner: str = "runner-1"):
    with factory.begin() as db:
        job = guest_service.reserve_job(
            db,
            guest_session_id=session_id,
            ip_key=ip_key_of(ip),
            policy=POLICY,
            create_job=lambda: job_service.create_job(
                db,
                session_id=None,
                guest_session_id=session_id,
                voice="AndrewMultilingual",
                first_sentence_start_seconds=0,
                last_sentence_start_seconds=10,
                audio_speed=AudioSpeed.X1,
                transcript_char_count=10,
                translation_provider="mock",
                speech_provider="mock",
                audio_processor="mock",
                runner_id=runner,
            ),
        )
        return job.id


def run_concurrently(count: int, work: Callable[[int], object]) -> list[object]:
    barrier = threading.Barrier(count)
    results: list[object] = [None] * count

    def target(i: int) -> None:
        barrier.wait()
        try:
            results[i] = work(i)
        except Exception as exc:
            results[i] = exc

    threads = [threading.Thread(target=target, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    return results


def test_concurrent_requests_of_one_session_never_pass_its_quota(factory, db_engine):
    session = new_session(factory)
    results = run_concurrently(12, lambda _: reserve(factory, session))
    accepted = [r for r in results if isinstance(r, uuid.UUID)]
    refused = [r for r in results if isinstance(r, GuestQuotaExceeded)]
    assert len(accepted) == 5 and len(refused) == 7
    assert all(r.scope == "session" for r in refused)
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 5


def test_concurrent_sessions_of_one_network_never_pass_its_quota(factory, db_engine):
    # One request per session, so only the network lock keeps them apart.
    sessions = [new_session(factory) for _ in range(28)]
    results = run_concurrently(28, lambda i: reserve(factory, sessions[i]))
    accepted = [r for r in results if isinstance(r, uuid.UUID)]
    refused = [r for r in results if isinstance(r, GuestQuotaExceeded)]
    assert len(accepted) == 20 and len(refused) == 8
    assert all(r.scope == "ip" for r in refused)
    assert len(quota_rows(db_engine)) == 20


def test_settling_is_idempotent(factory, db_engine):
    session = new_session(factory)
    done, failed = reserve(factory, session), reserve(factory, session)
    with factory.begin() as db:
        for job in (done,):
            for status in (JobStatus.TRANSLATING, JobStatus.SYNTHESIZING, JobStatus.PROCESSING):
                previous = {
                    JobStatus.TRANSLATING: JobStatus.QUEUED,
                    JobStatus.SYNTHESIZING: JobStatus.TRANSLATING,
                    JobStatus.PROCESSING: JobStatus.SYNTHESIZING,
                }[status]
                assert job_service.transition(db, job, previous, status)
        assert job_service.complete_job(db, done)
        assert job_service.mark_failed(db, failed, "speech_failed", "failed")
    states = {row.job_id: row.state for row in quota_rows(db_engine)}
    assert (states[done], states[failed]) == ("used", "released")
    with factory.begin() as db:
        # Again, and against the other outcome: nothing changes.
        assert guest_service.settle_jobs(db, [done, failed]) == 0
        assert guest_service.settle_jobs(db) == 0
        assert not job_service.mark_failed(db, done, "x", "late failure")
        assert not job_service.complete_job(db, failed)
        assert job_service.fail_interrupted_jobs(db, [done, failed]) == 0
    assert {row.job_id: row.state for row in quota_rows(db_engine)} == states


def test_recovery_releases_interrupted_jobs_but_not_jobs_running_elsewhere(factory, db_engine):
    session = new_session(factory)
    crashed = reserve(factory, session, runner="crashed-instance")
    alive = reserve(factory, session, runner="live-instance")
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id = :id"),
            {"id": crashed},
        )
    with factory.begin() as db:
        assert job_service.fail_stale_jobs(db, stale_after_seconds=90) == 1
    states = {row.job_id: row.state for row in quota_rows(db_engine)}
    assert states == {crashed: "released", alive: "reserved"}
    with factory.begin() as db:
        assert job_service.fail_stale_jobs(db, stale_after_seconds=90) == 0
    assert {row.job_id: row.state for row in quota_rows(db_engine)} == states


def test_startup_recovery_settles_after_a_crash(factory, db_engine, make_guest_client):
    session = new_session(factory)
    crashed = reserve(factory, session, runner="crashed-instance")
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE jobs SET heartbeat_at = now() - interval '10 minutes'"))
        # A job some older instance ended without settling its place.
    ended = reserve(factory, session, runner="old-code-instance")
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = :id"),
            {"id": ended},
        )
    make_guest_client()  # startup: recovery, then cleanup
    with db_engine.connect() as conn:
        status = conn.execute(
            text("SELECT status, error_code FROM jobs WHERE id = :id"), {"id": crashed}
        ).one()
    assert (status.status, status.error_code) == ("failed", "interrupted")
    states = {row.job_id: row.state for row in quota_rows(db_engine)}
    assert states == {crashed: "released", ended: "used"}


def test_cleanup_keeps_what_still_counts(factory, db_engine):
    old_session, live_session = new_session(factory), new_session(factory)
    old_job, reserved_job = reserve(factory, old_session), reserve(factory, live_session)
    with factory.begin() as db:
        job_service.mark_failed(db, old_job, "x", "failed")
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE guest_job_quota SET charged_at = now() - interval '25 hours', "
                "settled_at = now() - interval '25 hours' WHERE job_id = :id"
            ),
            {"id": old_job},
        )
        conn.execute(
            text(
                "UPDATE guest_sessions SET created_at = now() - interval '25 hours', "
                "expires_at = now() - interval '1 hour' WHERE id = :id"
            ),
            {"id": old_session},
        )
    with factory.begin() as db:
        assert guest_service.delete_stale_rows(db, POLICY) == 2
    assert [row.job_id for row in quota_rows(db_engine)] == [reserved_job]
    with db_engine.connect() as conn:
        ids = conn.execute(text("SELECT id FROM guest_sessions")).scalars().all()
        guest_of_old_job = conn.execute(
            text("SELECT guest_session_id FROM jobs WHERE id = :id"), {"id": old_job}
        ).scalar_one()
    assert ids == [live_session] and guest_of_old_job is None


def test_guest_session_starts_are_limited_per_network(make_guest_client):
    client = make_guest_client(guest_sessions_per_ip=3)
    for _ in range(3):
        client.cookies.clear()
        start_guest(client)
    client.cookies.clear()
    refused = client.post("/api/guest/session", headers={IP_HEADER: IP_A})
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "guest_sessions_exhausted"
    assert 3500 < int(refused.headers["retry-after"]) <= 3600
    assert client.post("/api/guest/session", headers={IP_HEADER: IP_B}).status_code == 201


def test_guest_session_starts_are_limited_overall(make_guest_client):
    client = make_guest_client(guest_sessions_global=2)
    for ip in (IP_A, IP_B):
        client.cookies.clear()
        start_guest(client, ip)
    client.cookies.clear()
    refused = client.post("/api/guest/session", headers={IP_HEADER: "192.0.2.1"})
    assert refused.json()["error"]["code"] == "guest_sessions_exhausted"


# -- the client network -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "network"),
    [
        ("203.0.113.10", "ipv4:203.0.113.10"),
        (" 203.0.113.10 ", "ipv4:203.0.113.10"),
        ("::ffff:203.0.113.10", "ipv4:203.0.113.10"),
        ("2001:DB8:1:2:3:4:5:6", "ipv6:2001:db8:1:2::/64"),
        ("[2001:db8:1:2::9]", "ipv6:2001:db8:1:2::/64"),
        ("2001:db8::1", "ipv6:2001:db8::/64"),
        ("", None),
        ("unknown", None),
        ("testclient", None),
        ("203.0.113.10, 198.51.100.20", None),
        ("203.0.113.10 198.51.100.20", None),
        ("203.0.113.10:443", None),
        ("fe80::1%eth0", None),
        ("999.1.1.1", None),
    ],
)
def test_network_normalization(value, network):
    assert network_of(value) == network


def test_spoofed_or_missing_proxy_headers_are_refused(guest_client, db_engine):
    csrf = start_guest(guest_client)["csrf_token"]
    base = {"X-CSRF-Token": csrf}
    cases = [
        {"X-Forwarded-For": IP_B},  # header missing; X-Forwarded-For is never read
        {IP_HEADER: f"{IP_A}, {IP_B}"},
        {IP_HEADER: "not-an-ip"},
    ]
    for headers in cases:
        response = guest_client.post("/api/jobs", json=VALID_JOB, headers={**base, **headers})
        assert response.status_code == 503, headers
        assert response.json()["error"]["code"] == "guest_network_unknown"
    duplicated = guest_client.post(
        "/api/jobs",
        json=VALID_JOB,
        headers=[("X-CSRF-Token", csrf), (IP_HEADER, IP_A), (IP_HEADER, IP_B)],
    )
    assert duplicated.status_code == 503
    # A forged X-Forwarded-For next to the real header changes nothing.
    forged = guest_client.post(
        "/api/jobs", json=VALID_JOB, headers={**base, IP_HEADER: IP_A, "X-Forwarded-For": IP_B}
    )
    assert forged.status_code == 202
    assert [row.ip_key for row in quota_rows(db_engine)] == [ip_key_of(IP_A)]
    guest_client.cookies.clear()
    assert guest_client.post("/api/guest/session").status_code == 503


def test_without_a_client_ip_header_the_peer_address_is_used(make_guest_client):
    # TestClient's peer is "testclient", not an address: refused, never a shared bucket.
    client = make_guest_client(client_ip_header=None)
    response = client.post("/api/guest/session", headers={IP_HEADER: IP_A})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "guest_network_unknown"


def test_logs_hold_no_address_token_or_transcript(guest_client, caplog):
    caplog.set_level(logging.DEBUG)
    session = start_guest(guest_client)
    run_guest_job(guest_client, session["csrf_token"], transcript="Secret guest transcript.")
    guest_job(guest_client, session["csrf_token"], transcript=words(1001))
    for secret in (IP_A, session["csrf_token"], "Secret guest transcript", ip_key_of(IP_A)):
        assert secret not in caplog.text


def test_settings_defaults_match_the_story(make_settings):
    settings: Settings = make_settings(**GUEST_SETTINGS)
    policy = GuestPolicy.from_settings(settings)
    assert (policy.jobs_per_session, policy.jobs_per_ip, policy.max_words) == (5, 20, 1000)
    assert timedelta(seconds=policy.ip_window_seconds) == timedelta(hours=24)
