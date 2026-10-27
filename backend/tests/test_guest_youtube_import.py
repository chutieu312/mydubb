"""Guest YouTube caption imports: the import quota (apart from the job quota), the lifecycle of one
import operation (reserve, settle once, recovery), client disconnects, and the guest content limits
on imported transcripts. Supadata is a fake HTTP transport; nothing reaches the network.
"""

import asyncio
import contextlib
import logging
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, text
from sqlalchemy.orm import sessionmaker

from app.guest import imports as guest_imports
from app.guest.imports import (
    GuestImportQuotaExceeded,
    GuestImportRunner,
    ImportNotRecorded,
    ImportsStopped,
)
from app.main import create_app
from app.maintenance import fail_stale, heartbeat, run_cleanup
from app.services import build_services
from app.youtube_import.base import ImportFailure
from tests.conftest import wait_for_terminal
from tests.test_guest_access import (
    GUEST_SETTINGS,
    IP_A,
    IP_B,
    IP_HEADER,
    POLICY,
    guest_job,
    ip_key_of,
    new_session,
    quota,
    run_concurrently,
    run_guest_job,
    start_guest,
)
from tests.test_youtube_import_api import KEY, SUPADATA, TRANSCRIPT, URL, respond, supadata_ok

ENDPOINT = "/api/transcripts/youtube"
VIDEO_ID = "dQw4w9WgXcQ"


@pytest.fixture
def guest_import_client(
    make_settings, fake_cognito, db_engine
) -> Iterator[Callable[..., tuple[TestClient, list[httpx.Request]]]]:
    """Guest access on, YouTube import through a fake Supadata transport."""
    clients: list[TestClient] = []

    def factory(handler=supadata_ok, **overrides: Any):
        calls: list[httpx.Request] = []

        def recording(request: httpx.Request):
            calls.append(request)
            return handler(request)

        settings = make_settings(**{**GUEST_SETTINGS, **SUPADATA, **overrides})
        services = build_services(
            settings,
            youtube_import_transport=httpx.MockTransport(recording),
            cognito_client=fake_cognito,
        )
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client, calls

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def guest_import(client: TestClient, csrf: str | None, ip: str = IP_A, url: str = URL):
    headers = {IP_HEADER: ip}
    if csrf is not None:
        headers["X-CSRF-Token"] = csrf
    return client.post(ENDPOINT, json={"url": url}, headers=headers)


def import_quota(client: TestClient, ip: str = IP_A) -> dict:
    response = client.get("/api/guest/session", headers={IP_HEADER: ip})
    assert response.status_code == 200, response.text
    return response.json()["imports"]


def import_rows(db_engine) -> list:
    with db_engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT id, guest_session_id, ip_key, state, runner_id FROM guest_import_quota "
                "ORDER BY reserved_at"
            )
        ).all()


def states(db_engine) -> list[str]:
    return [row.state for row in import_rows(db_engine)]


def captions(count: int, step_ms: int, words: int = 10) -> dict:
    """`count` captions of `words` words each, `step_ms` apart."""
    filler = " ".join(["gradient"] * (words - 2))
    return {
        "content": [
            {"text": f"Caption {i} {filler}.", "offset": 480 + i * step_ms, "duration": 1000}
            for i in range(count)
        ],
        "lang": "en",
    }


def blocking_provider():
    """A fake Supadata whose answer waits until `release` is set."""
    entered, release = threading.Event(), threading.Event()

    async def blocking(request: httpx.Request) -> httpx.Response:
        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        return supadata_ok(request)

    return blocking, entered, release


@contextlib.contextmanager
def import_in_flight(client: TestClient, csrf: str, release: threading.Event) -> Iterator[dict]:
    """A guest import running in another thread; its answer is in `result["r"]` afterwards. The
    provider is always released and the import awaited, even when an assertion fails."""
    result: dict = {}
    worker = threading.Thread(target=lambda: result.update(r=guest_import(client, csrf)))
    worker.start()
    try:
        yield result
    finally:
        release.set()
        worker.join(30)


# -- availability, meta and the session's quotas --------------------------------------------


def test_meta_and_the_guest_session_report_import_quotas_apart_from_jobs(guest_import_client):
    client, _ = guest_import_client()
    meta = client.get("/api/meta").json()
    assert meta["youtube_import"]["enabled"] is True
    assert (
        meta["guest_access"]["imports_per_session"],
        meta["guest_access"]["imports_per_ip"],
    ) == (
        5,
        20,
    )
    session = start_guest(client)
    assert session["imports"] == {
        "session_limit": 5,
        "session_used": 0,
        "session_in_progress": 0,
        "session_remaining": 5,
        "ip_limit": 20,
        "ip_used": 0,
        "ip_in_progress": 0,
        "ip_remaining": 20,
        "ip_retry_after_seconds": None,
    }
    assert session["quota"]["session_remaining"] == 5  # jobs, unchanged


def test_without_an_import_provider_guests_have_no_import(make_guest_client, db_engine):
    client = make_guest_client()  # YOUTUBE_IMPORT_PROVIDER=off
    session = start_guest(client)
    assert session["imports"] is None
    response = guest_import(client, session["csrf_token"])
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "youtube_import_disabled"
    assert import_rows(db_engine) == []


@pytest.fixture
def make_guest_client(make_cognito_client) -> Callable[..., TestClient]:
    return lambda **overrides: make_cognito_client(**{**GUEST_SETTINGS, **overrides})


# -- the import itself ------------------------------------------------------------------------


def test_a_guest_imports_captions_and_one_import_is_used(guest_import_client, db_engine, caplog):
    caplog.set_level(logging.DEBUG)
    client, calls = guest_import_client()
    session = start_guest(client)
    response = guest_import(client, session["csrf_token"])
    assert response.status_code == 200, response.text
    body = response.json()
    # The same answer an account gets: full captions, milliseconds, in order.
    assert body["transcript"] == (
        "0:10.480\nWelcome back.\n0:12.960\nGradient descent, step by step.\n6:10.999\nBye!"
    )
    assert (body["first_sentence_start"], body["last_sentence_start"]) == ("00:00:10", "00:06:10")
    assert len(calls) == 1
    (row,) = import_rows(db_engine)
    assert row.state == "used" and str(row.guest_session_id) == session["guest"]["id"]
    assert row.ip_key == ip_key_of(IP_A)
    imports = import_quota(client)
    assert (imports["session_used"], imports["session_remaining"], imports["ip_used"]) == (1, 4, 1)
    # An import creates no job and uses up no job.
    assert quota(client)["session_remaining"] == 5
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0
        stored = " ".join(
            str(value) for value in conn.execute(text("SELECT * FROM guest_import_quota")).one()
        )
    # The row holds no link, video or caption, and nothing sensitive reaches the logs.
    for secret in (VIDEO_ID, "Welcome back", IP_A):
        assert secret not in stored
    for secret in (VIDEO_ID, "Welcome back", IP_A, KEY, session["csrf_token"]):
        assert secret not in caplog.text


def test_import_and_audio_quotas_are_independent(guest_import_client, db_engine):
    client, _ = guest_import_client(guest_imports_per_session=2, guest_jobs_per_session=2)
    csrf = start_guest(client)["csrf_token"]
    for _ in range(2):
        assert guest_import(client, csrf).status_code == 200
    refused = guest_import(client, csrf)
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "guest_import_session_quota_exhausted"
    # No import left, both jobs still there.
    for _ in range(2):
        assert run_guest_job(client, csrf)["status"] == "completed"
    assert guest_job(client, csrf).json()["error"]["code"] == "guest_session_quota_exhausted"
    assert import_quota(client)["session_used"] == 2
    assert quota(client)["session_used"] == 2


def test_a_polled_import_is_counted_once(guest_import_client, db_engine):
    polls = {"count": 0}

    def async_job(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/transcript"):
            return httpx.Response(202, json={"jobId": "job-1"})
        polls["count"] += 1
        if polls["count"] < 3:
            return httpx.Response(200, json={"status": "active"})
        return httpx.Response(200, json={"status": "completed", **TRANSCRIPT})

    client, calls = guest_import_client(async_job, supadata_poll_interval_seconds=0.5)
    csrf = start_guest(client)["csrf_token"]
    assert guest_import(client, csrf).status_code == 200
    assert len(calls) == 4  # one start, three polls
    assert states(db_engine) == ["used"]
    assert import_quota(client)["session_used"] == 1


def test_reading_the_quota_never_imports_or_counts(guest_import_client, db_engine):
    client, calls = guest_import_client()
    start_guest(client)
    for _ in range(3):
        import_quota(client)
        client.post("/api/guest/session", headers={IP_HEADER: IP_A})
    assert calls == [] and import_rows(db_engine) == []


# -- refused before anything is sent or written -----------------------------------------------


def test_csrf_origin_and_session_are_checked_before_anything(guest_import_client, db_engine):
    client, calls = guest_import_client()
    assert guest_import(client, None).status_code == 401  # no guest session yet
    csrf = start_guest(client)["csrf_token"]
    assert guest_import(client, None).json()["error"]["code"] == "csrf_failed"
    assert guest_import(client, "wrong").status_code == 403
    cross = client.post(
        ENDPOINT,
        json={"url": URL},
        headers={"X-CSRF-Token": csrf, IP_HEADER: IP_A, "Origin": "https://evil.example"},
    )
    assert cross.json()["error"]["code"] == "origin_rejected"
    invalid = guest_import(client, csrf, url="https://example.org/video.mp4")
    assert invalid.status_code == 422
    assert calls == [] and import_rows(db_engine) == []


def test_an_unknown_network_is_refused(guest_import_client, db_engine):
    client, calls = guest_import_client()
    csrf = start_guest(client)["csrf_token"]
    response = client.post(
        ENDPOINT, json={"url": URL}, headers={"X-CSRF-Token": csrf, IP_HEADER: "1.2.3.4, 5.6.7.8"}
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "guest_network_unknown"
    assert calls == [] and import_rows(db_engine) == []


def test_a_full_server_writes_nothing(guest_import_client, db_engine):
    blocking, entered, release = blocking_provider()
    client, calls = guest_import_client(blocking, youtube_import_max_concurrent=1)
    csrf = start_guest(client)["csrf_token"]
    with import_in_flight(client, csrf, release) as result:
        assert entered.wait(10)
        busy = guest_import(client, csrf)
        assert busy.json()["error"]["code"] == "youtube_import_busy"
        assert states(db_engine) == ["reserved"]  # only the running one
    assert result["r"].status_code == 200
    assert states(db_engine) == ["used"] and len(calls) == 1


# -- quotas -----------------------------------------------------------------------------------


def test_five_successful_imports_per_session(guest_import_client, db_engine):
    client, calls = guest_import_client()
    csrf = start_guest(client)["csrf_token"]
    for _ in range(5):
        assert guest_import(client, csrf).status_code == 200
    refused = guest_import(client, csrf)
    assert refused.status_code == 429
    error = refused.json()["error"]
    assert error["code"] == "guest_import_session_quota_exhausted" and error["limit"] == 5
    assert len(calls) == 5  # the refused one never reached Supadata
    assert import_quota(client)["session_remaining"] == 0


def test_twenty_imports_per_network_shared_by_sessions(guest_import_client, db_engine):
    client, calls = guest_import_client()
    for _ in range(4):
        client.cookies.clear()
        csrf = start_guest(client)["csrf_token"]
        for _ in range(5):
            assert guest_import(client, csrf).status_code == 200
    client.cookies.clear()
    csrf = start_guest(client)["csrf_token"]
    refused = guest_import(client, csrf)
    assert refused.status_code == 429
    error = refused.json()["error"]
    assert error["code"] == "guest_import_ip_quota_exhausted" and error["limit"] == 20
    assert 86000 < int(refused.headers["Retry-After"]) <= 86400
    assert import_quota(client)["ip_remaining"] == 0
    # Another network has its own 20; and jobs of the exhausted network are untouched.
    client.cookies.clear()
    other = start_guest(client, IP_B)["csrf_token"]
    assert guest_import(client, other, IP_B).status_code == 200
    assert len(calls) == 21


def test_the_network_window_slides(guest_import_client, db_engine):
    client, _ = guest_import_client(guest_imports_per_ip=2)
    csrf = start_guest(client)["csrf_token"]
    assert guest_import(client, csrf).status_code == 200
    assert guest_import(client, csrf).status_code == 200
    assert guest_import(client, csrf).status_code == 429
    first = import_rows(db_engine)[0].id
    with db_engine.begin() as conn:
        # Just inside the window: still counted.
        conn.execute(
            text(
                "UPDATE guest_import_quota SET charged_at = now() - interval '23 hours 59 minutes' "
                "WHERE id = :id"
            ),
            {"id": first},
        )
    assert guest_import(client, csrf).status_code == 429
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE guest_import_quota SET charged_at = now() - interval '24 hours 1 minute' "
                "WHERE id = :id"
            ),
            {"id": first},
        )
    assert import_quota(client)["ip_remaining"] == 1
    assert guest_import(client, csrf).status_code == 200


# -- failures give the place back -------------------------------------------------------------


@pytest.mark.parametrize(
    ("handler", "code"),
    [
        (respond(500, {"error": "internal-error"}), "youtube_import_service_error"),
        (respond(206, {"error": "transcript-unavailable"}), "youtube_import_no_english_captions"),
        (respond(429, {"error": "limit-exceeded"}), "youtube_import_rate_limited"),
        (
            lambda request: httpx.Response(
                200, json={"content": [{"text": "10:30", "offset": 0, "duration": 1}], "lang": "en"}
            ),
            "youtube_import_not_representable",
        ),
        (
            lambda request: httpx.Response(200, content=b"not json"),
            "youtube_import_invalid_response",
        ),
    ],
)
def test_failed_imports_give_their_place_back(guest_import_client, db_engine, handler, code):
    client, calls = guest_import_client(handler)
    csrf = start_guest(client)["csrf_token"]
    response = guest_import(client, csrf)
    assert response.json()["error"]["code"] == code
    assert states(db_engine) == ["released"]
    assert import_quota(client)["session_remaining"] == 5
    assert len(calls) == 1  # never retried


def test_a_timeout_gives_the_place_back_and_is_not_retried(guest_import_client, db_engine):
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    client, calls = guest_import_client(slow)
    csrf = start_guest(client)["csrf_token"]
    assert guest_import(client, csrf).status_code == 504
    assert states(db_engine) == ["released"] and len(calls) == 1


# -- content limits: the import keeps everything, Generate refuses -----------------------------


def test_captions_over_the_word_limit_are_imported_whole_and_refused_at_generate(
    guest_import_client, db_engine
):
    long_track = captions(120, 3000)  # 1,200 words over 6 minutes
    client, _ = guest_import_client(lambda request: httpx.Response(200, json=long_track))
    csrf = start_guest(client)["csrf_token"]
    response = guest_import(client, csrf)
    assert response.status_code == 200, response.text
    imported = response.json()
    lines = imported["transcript"].split("\n")
    assert len(lines) == 240 and imported["caption_count"] == 120  # nothing cut
    assert lines[1] == long_track["content"][0]["text"] and lines[-1].startswith("Caption 119 ")
    assert lines[-2] == "5:57.480"  # milliseconds kept
    assert states(db_engine) == ["used"]  # counted although too long to generate
    job = guest_job(
        client,
        csrf,
        transcript=imported["transcript"],
        first_sentence_start=imported["first_sentence_start"],
        last_sentence_start=imported["last_sentence_start"],
        timing_mode="timed",
    )
    assert job.status_code == 422
    assert job.json()["error"]["code"] == "guest_word_limit_exceeded"
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0
        assert conn.execute(text("SELECT count(*) FROM guest_job_quota")).scalar_one() == 0


def test_captions_over_the_audio_length_are_imported_unchanged_and_refused_at_generate(
    guest_import_client, db_engine
):
    long_track = captions(30, 30_000)  # 300 words, last caption at 14:30.480
    client, _ = guest_import_client(lambda request: httpx.Response(200, json=long_track))
    csrf = start_guest(client)["csrf_token"]
    imported = guest_import(client, csrf).json()
    # The suggested times are the captions' own, never clamped to the guest limit.
    assert (imported["first_sentence_start"], imported["last_sentence_start"]) == (
        "00:00:00",
        "00:14:30",
    )
    job = guest_job(
        client,
        csrf,
        transcript=imported["transcript"],
        first_sentence_start=imported["first_sentence_start"],
        last_sentence_start=imported["last_sentence_start"],
        timing_mode="timed",
    )
    assert job.status_code == 422
    assert job.json()["error"]["code"] == "guest_duration_limit_exceeded"
    # At 2x the same captions fit (870 s / 2): the user chooses, nothing is changed for them.
    faster = guest_job(
        client,
        csrf,
        transcript=imported["transcript"],
        first_sentence_start=imported["first_sentence_start"],
        last_sentence_start=imported["last_sentence_start"],
        timing_mode="timed",
        speed=2,
    )
    assert faster.status_code == 202, faster.text
    assert states(db_engine) == ["used"]


def test_an_imported_transcript_edited_by_a_guest_runs_timed_and_plain(guest_import_client):
    client, _ = guest_import_client()
    csrf = start_guest(client)["csrf_token"]
    imported = guest_import(client, csrf).json()
    edited = imported["transcript"].replace("Bye!", "Goodbye, everyone!")
    times = {
        "first_sentence_start": imported["first_sentence_start"],
        "last_sentence_start": imported["last_sentence_start"],
    }
    timed = run_guest_job(client, csrf, transcript=edited, timing_mode="timed", **times)
    assert timed["status"] == "completed"
    result = client.get(f"/api/jobs/{timed['id']}/result").json()
    assert result["timing"]["source_first_seconds"] == 10.48
    assert result["timing"]["source_last_seconds"] == 370.999
    assert "Goodbye, everyone!" in result["translation"]["text"]
    assert "Bye!\n" not in result["translation"]["text"]
    plain = run_guest_job(client, csrf, transcript=edited, **times)
    plain_result = client.get(f"/api/jobs/{plain['id']}/result").json()
    assert plain_result["timing"] is None
    assert "Goodbye, everyone!" in plain_result["translation"]["text"]
    assert "0:10.480" not in plain_result["translation"]["text"]


# -- concurrency, settling and recovery (service level, real PostgreSQL) ----------------------


@pytest.fixture
def factory(db_engine) -> sessionmaker:
    return sessionmaker(bind=db_engine, expire_on_commit=False)


def reserve(factory, session_id: uuid.UUID, ip: str = IP_A, runner: str = "runner-1"):
    with factory.begin() as db:
        return guest_imports.reserve_import(
            db, guest_session_id=session_id, ip_key=ip_key_of(ip), policy=POLICY, runner_id=runner
        )


def reserving(session_id: uuid.UUID, ip: str = IP_A, runner: str = "runner-1"):
    """The `reserve` step a GuestImportRunner runs in its own bounded transaction."""
    return lambda db: guest_imports.reserve_import(
        db, guest_session_id=session_id, ip_key=ip_key_of(ip), policy=POLICY, runner_id=runner
    )


def test_concurrent_imports_of_one_session_never_pass_its_quota(factory, db_engine):
    session = new_session(factory)
    # Each from another network (the address can change during a session), so only the session
    # lock keeps them apart.
    results = run_concurrently(12, lambda i: reserve(factory, session, ip=f"192.0.2.{i + 1}"))
    accepted = [r for r in results if isinstance(r, uuid.UUID)]
    refused = [r for r in results if isinstance(r, GuestImportQuotaExceeded)]
    assert len(accepted) == 5 and len(refused) == 7
    assert all(r.scope == "session" for r in refused)
    assert len(import_rows(db_engine)) == 5


def test_concurrent_sessions_of_one_network_never_pass_its_quota(factory, db_engine):
    # One request per session, so only the network lock keeps them apart.
    sessions = [new_session(factory) for _ in range(28)]
    results = run_concurrently(28, lambda i: reserve(factory, sessions[i]))
    accepted = [r for r in results if isinstance(r, uuid.UUID)]
    refused = [r for r in results if isinstance(r, GuestImportQuotaExceeded)]
    assert len(accepted) == 20 and len(refused) == 8
    assert all(r.scope == "ip" for r in refused)


def test_settling_happens_once(factory, db_engine):
    session = new_session(factory)
    done, failed = reserve(factory, session), reserve(factory, session)
    with factory.begin() as db:
        assert guest_imports.settle_import(db, done, used=True)
        assert guest_imports.settle_import(db, failed, used=False)
    with factory.begin() as db:
        # Again, and against the other outcome: nothing changes.
        assert not guest_imports.settle_import(db, done, used=False)
        assert not guest_imports.settle_import(db, done, used=True)
        assert not guest_imports.settle_import(db, failed, used=True)
    assert {row.id: row.state for row in import_rows(db_engine)} == {
        done: "used",
        failed: "released",
    }


def test_recovery_releases_lost_imports_but_not_imports_running_elsewhere(factory, db_engine):
    session = new_session(factory)
    crashed = reserve(factory, session, runner="crashed-instance")
    alive = reserve(factory, session, runner="live-instance")
    too_old = reserve(factory, session, runner="stuck-instance")
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE guest_import_quota SET heartbeat_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": crashed},
        )
        # Heartbeats still coming, but reserved longer than any import can run.
        conn.execute(
            text(
                "UPDATE guest_import_quota SET reserved_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": too_old},
        )
    with factory.begin() as db:
        released = guest_imports.release_stale_imports(
            db, stale_after_seconds=90, max_age_seconds=180
        )
    assert released == 2
    assert {row.id: row.state for row in import_rows(db_engine)} == {
        crashed: "released",
        alive: "reserved",
        too_old: "released",
    }
    with factory.begin() as db:
        assert (
            guest_imports.release_stale_imports(db, stale_after_seconds=90, max_age_seconds=180)
            == 0
        )
        # The live instance's success is still counted once it ends.
        assert guest_imports.settle_import(db, alive, used=True)
        # A late success of a released import is not.
        assert not guest_imports.settle_import(db, crashed, used=True)


def test_startup_recovery_releases_imports_of_a_crashed_instance(
    factory, db_engine, guest_import_client
):
    session = new_session(factory)
    crashed = reserve(factory, session, runner="crashed-instance")
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE guest_import_quota SET heartbeat_at = now() - interval '10 minutes'")
        )
    guest_import_client()  # startup: recovery, then cleanup
    assert {row.id: row.state for row in import_rows(db_engine)} == {crashed: "released"}


def test_the_liveness_loop_keeps_running_imports_alive(guest_import_client, db_engine):
    blocking, entered, release = blocking_provider()
    client, _ = guest_import_client(blocking)
    services = client.app.state.services  # type: ignore[attr-defined]
    csrf = start_guest(client)["csrf_token"]
    with import_in_flight(client, csrf, release) as result:
        assert entered.wait(10)
        with db_engine.begin() as conn:
            conn.execute(
                text("UPDATE guest_import_quota SET heartbeat_at = now() - interval '10 minutes'")
            )
        heartbeat(services)  # this instance still runs it: refreshed
        fail_stale(services)
        assert states(db_engine) == ["reserved"]
    assert result["r"].status_code == 200
    assert states(db_engine) == ["used"]
    # Finished imports are no longer heartbeated.
    assert services.guest_imports.running_ids() == []


def test_a_success_released_meanwhile_is_not_reported(guest_import_client, db_engine):
    blocking, entered, release = blocking_provider()
    client, _ = guest_import_client(blocking)
    csrf = start_guest(client)["csrf_token"]
    with import_in_flight(client, csrf, release) as result:
        assert entered.wait(10)
        # Recovery (e.g. after a long stall of this instance) released it meanwhile.
        with db_engine.begin() as conn:
            conn.execute(
                text("UPDATE guest_import_quota SET state = 'released', settled_at = now()")
            )
    response = result["r"]
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "youtube_import_not_recorded"
    assert "transcript" not in response.json()
    assert states(db_engine) == ["released"]
    assert import_quota(client)["session_used"] == 0


def test_cleanup_keeps_what_still_counts(factory, db_engine, guest_import_client):
    session = new_session(factory)
    old, recent, running = (reserve(factory, session) for _ in range(3))
    with factory.begin() as db:
        guest_imports.settle_import(db, old, used=True)
        guest_imports.settle_import(db, recent, used=True)
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE guest_import_quota SET charged_at = now() - interval '25 hours', "
                "settled_at = now() - interval '25 hours' WHERE id = :id"
            ),
            {"id": old},
        )
        conn.execute(
            text(
                "UPDATE guest_import_quota SET charged_at = now() - interval '23 hours', "
                "settled_at = now() - interval '23 hours' WHERE id = :id"
            ),
            {"id": recent},
        )
    client, _ = guest_import_client()
    run_cleanup(client.app.state.services)  # type: ignore[attr-defined]
    # The row out of the window is gone; the one still counted and the running one stay.
    assert {row.id for row in import_rows(db_engine)} == {recent, running}


# -- the client goes away ---------------------------------------------------------------------


async def _run_and_cancel_caller(
    runner: GuestImportRunner, reserve_fn, work, cancel_when: threading.Event | asyncio.Event
):
    caller = asyncio.create_task(runner.run(reserve_fn, work))
    await cancel_when.wait()  # type: ignore[union-attr]
    caller.cancel()
    with pytest.raises(asyncio.CancelledError):
        await caller
    await runner.wait_until(time.monotonic() + 10)


@pytest.mark.parametrize("fails", [False, True])
def test_a_client_that_disconnects_during_the_import_does_not_stop_it(factory, db_engine, fails):
    session = new_session(factory)
    runner = GuestImportRunner(factory)

    async def scenario():
        started, finish = asyncio.Event(), asyncio.Event()

        async def work():
            started.set()
            await finish.wait()
            if fails:
                raise ImportFailure("youtube_import_service_error")
            return "transcript"

        caller = asyncio.create_task(runner.run(reserving(session), work))
        await started.wait()
        caller.cancel()  # the request handler goes away (client disconnected)
        with pytest.raises(asyncio.CancelledError):
            await caller
        assert states(db_engine) == ["reserved"]  # still running, not given back
        finish.set()
        await runner.wait_until(time.monotonic() + 10)

    asyncio.run(scenario())
    # A success still counts; a failure still gives the place back.
    assert states(db_engine) == (["released"] if fails else ["used"])


def test_a_client_that_disconnects_after_the_captions_arrived_is_still_charged(factory, db_engine):
    session = new_session(factory)
    runner = GuestImportRunner(factory)

    async def scenario():
        done = asyncio.Event()

        async def work():
            done.set()  # the captions are checked; the caller is cancelled before settling
            return "transcript"

        await _run_and_cancel_caller(runner, reserving(session), work, done)

    asyncio.run(scenario())
    assert states(db_engine) == ["used"]


def test_a_cancelled_http_request_still_settles_the_import(make_settings, fake_cognito, db_engine):
    """Through the real app: the request handler is cancelled mid-import (as when the client
    disconnects), the import goes on and is charged."""
    entered, release = asyncio.Event(), asyncio.Event()

    async def blocking(request: httpx.Request) -> httpx.Response:
        entered.set()
        await release.wait()
        return supadata_ok(request)

    services = build_services(
        make_settings(**{**GUEST_SETTINGS, **SUPADATA}),
        youtube_import_transport=httpx.MockTransport(blocking),
        cognito_client=fake_cognito,
    )
    app = create_app(services=services)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            started = await http.post("/api/guest/session", headers={IP_HEADER: IP_A})
            csrf = started.json()["csrf_token"]
            request = asyncio.create_task(
                http.post(
                    ENDPOINT, json={"url": URL}, headers={"X-CSRF-Token": csrf, IP_HEADER: IP_A}
                )
            )
            await asyncio.wait_for(entered.wait(), 10)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert states(db_engine) == ["reserved"]
            release.set()
            await services.guest_imports.wait_until(time.monotonic() + 10)  # type: ignore[union-attr]

    asyncio.run(scenario())
    services.youtube_import.close()  # type: ignore[union-attr]
    services.engine.dispose()
    assert states(db_engine) == ["used"]


def test_a_success_that_cannot_be_recorded_raises(factory, db_engine):
    session = new_session(factory)
    runner = GuestImportRunner(factory)
    operation: dict = {}

    def reserve_and_release(db):
        operation["id"] = reserve(factory, session)
        with factory.begin() as db:
            guest_imports.settle_import(db, operation["id"], used=False)
        return operation["id"]

    async def work():
        return "transcript"

    with pytest.raises(ImportNotRecorded):
        asyncio.run(runner.run(reserve_and_release, work))
    assert states(db_engine) == ["released"]


# -- accounts ---------------------------------------------------------------------------------


def test_accounts_import_without_any_guest_quota(guest_import_client, fake_cognito, db_engine):
    from tests.conftest import sign_in

    client, calls = guest_import_client(guest_imports_per_session=1)
    fake_cognito.add_user("lan@example.com", "correct-horse-1")
    csrf = sign_in(client, "lan@example.com", "correct-horse-1")["csrf_token"]
    for _ in range(3):
        assert (
            client.post(ENDPOINT, json={"url": URL}, headers={"X-CSRF-Token": csrf}).status_code
            == 200
        )
    assert import_rows(db_engine) == [] and len(calls) == 3


def test_a_job_completed_after_an_import_still_reports_both_counts(guest_import_client):
    client, _ = guest_import_client()
    csrf = start_guest(client)["csrf_token"]
    imported = guest_import(client, csrf).json()
    job = guest_job(
        client,
        csrf,
        transcript=imported["transcript"],
        first_sentence_start=imported["first_sentence_start"],
        last_sentence_start=imported["last_sentence_start"],
    )
    wait_for_terminal(client, job.json()["id"])
    session = client.get("/api/guest/session", headers={IP_HEADER: IP_A}).json()
    assert session["imports"]["session_used"] == 1
    assert session["quota"]["session_used"] == 1


# -- application shutdown ---------------------------------------------------------------------


def test_shutdown_gives_a_stalled_import_and_a_long_job_one_shared_budget(
    make_settings, fake_cognito, db_engine
):
    """A guest import stuck in a provider read and a long dubbing job are drained together within
    JOB_SHUTDOWN_GRACE_SECONDS (not one grace each); then the import is stopped, its slot and its
    place given back, the job interrupted, and no import statement runs after dispose."""
    grace = 2.0
    entered = threading.Event()

    async def stalled(request: httpx.Request) -> httpx.Response:
        # A provider read that never completes (only cancelling it ends it).
        entered.set()
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")

    services = build_services(
        make_settings(
            **{**GUEST_SETTINGS, **SUPADATA},
            job_shutdown_grace_seconds=grace,
            job_heartbeat_interval_seconds=1,
            mock_stage_delay_seconds=5.0,
            youtube_import_max_concurrent=1,
        ),
        youtube_import_transport=httpx.MockTransport(stalled),
        cognito_client=fake_cognito,
    )
    database = DatabaseActivity(services)

    client = TestClient(create_app(services=services))
    client.__enter__()
    result: dict = {}
    try:
        csrf = start_guest(client)["csrf_token"]
        job = guest_job(client, csrf).json()["id"]
        worker = threading.Thread(target=lambda: result.update(r=guest_import(client, csrf)))
        worker.start()
        assert entered.wait(10)
        (row,) = import_rows(db_engine)
        reserved_heartbeat = _heartbeat(db_engine, row.id)
    finally:
        started = time.monotonic()
        # In a thread, so a shutdown that never ends fails the test instead of hanging it.
        stopping = threading.Thread(target=client.__exit__, args=(None, None, None), daemon=True)
        stopping.start()
        stopping.join(grace + 10)
        elapsed = time.monotonic() - started
    assert not stopping.is_alive(), "shutdown did not finish"
    worker.join(10)

    # One budget: about `grace`, never two of them back to back.
    assert grace - 0.2 <= elapsed < grace + 1.0, elapsed
    response = result["r"]
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "youtube_import_cancelled"
    # The stopped import's place was given back before the engine went away; the heartbeat kept
    # running while it was drained.
    assert states(db_engine) == ["released"]
    assert _heartbeat(db_engine, row.id) > reserved_heartbeat
    with db_engine.connect() as conn:
        status = conn.execute(
            text("SELECT status, error_code FROM jobs WHERE id = :id"), {"id": job}
        ).one()
    assert tuple(status) == ("failed", "interrupted")
    # The admission slot is free again, and nothing of the import is left running.
    services.youtube_import.admit().release()  # type: ignore[union-attr]
    assert services.guest_imports.running_ids() == []  # type: ignore[union-attr]
    assert services.guest_imports.db_calls() == 0  # type: ignore[union-attr]
    # Import statements ran before the engines went away, none after; both engines disposed.
    time.sleep(0.5)
    assert database.import_statements_before_dispose > 0
    assert database.import_statements_after_dispose == []
    assert database.shared_disposed.is_set() and database.import_disposed.is_set()


class DatabaseActivity:
    """Records `guest_import_quota` statements on the application's and the import runner's
    engines, before and after each engine is disposed (dispose is wrapped to mark the moment)."""

    def __init__(self, services) -> None:
        self.shared_disposed = threading.Event()
        self.import_disposed = threading.Event()
        self.import_statements_before_dispose = 0
        self.import_statements_after_dispose: list[str] = []
        for engine, disposed in (
            (services.engine, self.shared_disposed),
            (services.guest_import_engine, self.import_disposed),
        ):
            self._watch(engine, disposed)

    def _watch(self, engine, disposed: threading.Event) -> None:
        @event.listens_for(engine, "before_cursor_execute")
        def record(conn, cursor, statement, parameters, context, executemany):
            if "guest_import_quota" not in statement:
                return
            if disposed.is_set():
                self.import_statements_after_dispose.append(statement)
            else:
                self.import_statements_before_dispose += 1

        dispose = engine.dispose

        def dispose_and_mark(*args, **kwargs):
            disposed.set()
            return dispose(*args, **kwargs)

        engine.dispose = dispose_and_mark


def _heartbeat(db_engine, operation_id):
    with db_engine.connect() as conn:
        return conn.execute(
            text("SELECT heartbeat_at FROM guest_import_quota WHERE id = :id"),
            {"id": operation_id},
        ).scalar_one()


def test_stop_cancels_a_stalled_import_and_refuses_further_database_work(factory, db_engine):
    session = new_session(factory)
    runner = GuestImportRunner(factory)

    async def scenario():
        started = asyncio.Event()

        async def stalled():
            started.set()
            await asyncio.sleep(3600)

        caller = asyncio.create_task(runner.run(reserving(session), stalled))
        await started.wait()
        await runner.wait_until(time.monotonic() + 0.2)  # the budget runs out
        assert states(db_engine) == ["reserved"]
        outcome = await runner.stop()
        assert (outcome.stopped, outcome.quiescent, outcome.released) == (1, True, 1)
        with pytest.raises(ImportsStopped):
            await caller
        # Nothing new reaches the database after stop.
        with pytest.raises(ImportsStopped):
            await runner.run(reserving(session), stalled)

    asyncio.run(scenario())
    assert states(db_engine) == ["released"]
    assert runner.running_ids() == []


def test_stop_waits_for_a_database_statement_already_running(factory, db_engine, monkeypatch):
    """Cancelling an import does not stop its thread: stop returns only once the statement ended."""
    session = new_session(factory)
    runner = GuestImportRunner(factory)
    in_statement, statement_done = threading.Event(), threading.Event()
    real_settle = guest_imports.settle_import

    def slow_settle(db, operation_id, *, used):
        in_statement.set()
        time.sleep(0.5)
        try:
            return real_settle(db, operation_id, used=used)
        finally:
            statement_done.set()

    monkeypatch.setattr(guest_imports, "settle_import", slow_settle)

    async def scenario():
        async def work():
            return "transcript"

        caller = asyncio.create_task(runner.run(reserving(session), work))
        while not in_statement.is_set():
            await asyncio.sleep(0.01)
        await runner.stop()
        assert statement_done.is_set()  # stop waited for it
        with pytest.raises(ImportsStopped):
            await caller

    asyncio.run(scenario())
    # The success had been written by then: it stays used (counted once, never released).
    assert states(db_engine) == ["used"]


def test_an_import_stop_could_not_release_is_recovered_after_restart(
    factory, db_engine, guest_import_client, monkeypatch
):
    session = new_session(factory)
    runner = GuestImportRunner(factory)

    def database_down(operation_ids):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(runner, "_release", database_down)

    async def scenario():
        started = asyncio.Event()

        async def stalled():
            started.set()
            await asyncio.sleep(3600)

        caller = asyncio.create_task(runner.run(reserving(session), stalled))
        await started.wait()
        await runner.stop()
        with pytest.raises(ImportsStopped):
            await caller

    asyncio.run(scenario())
    assert states(db_engine) == ["reserved"]  # left for recovery
    with db_engine.begin() as conn:
        # The stopped instance sends no heartbeat any more.
        conn.execute(
            text("UPDATE guest_import_quota SET heartbeat_at = now() - interval '10 minutes'")
        )
    guest_import_client()  # the next instance starts: recovery releases it
    assert states(db_engine) == ["released"]


def test_a_client_disconnect_is_not_a_shutdown(factory, db_engine):
    """The caller going away leaves the import running (charged on success); only stop ends it."""
    session = new_session(factory)
    runner = GuestImportRunner(factory)

    async def scenario():
        started, finish = asyncio.Event(), asyncio.Event()

        async def work():
            started.set()
            await finish.wait()
            return "transcript"

        caller = asyncio.create_task(runner.run(reserving(session), work))
        await started.wait()
        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller
        assert runner.running_ids() != []  # still running
        finish.set()
        await runner.wait_until(time.monotonic() + 10)
        assert (await runner.stop()).stopped == 0  # nothing left to stop

    asyncio.run(scenario())
    assert states(db_engine) == ["used"]


# -- shutdown against a slow database (locks held far longer than the import's timeouts) ------

SLOW_TIMEOUT = 1.0  # the runner's database timeout in these tests (production: 2 s)


def lock_waiters(db_engine, table: str) -> int:
    """Other sessions currently waiting on a lock while touching `table`."""
    with db_engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                "AND query LIKE :pattern AND pid <> pg_backend_pid()"
            ),
            {"pattern": f"%{table}%"},
        ).scalar_one()


def test_stop_while_reserve_waits_on_a_lock_longer_than_the_timeout(factory, db_engine):
    """Cancelled while `reserve` waits on the guest session's row lock, which another client
    holds for much longer than the timeout: PostgreSQL ends the wait, stop returns quiescent with
    no statement left, and nothing was written."""
    session = new_session(factory)
    runner = GuestImportRunner(factory, db_timeout_seconds=SLOW_TIMEOUT)
    with db_engine.connect() as holder:
        hold = holder.begin()
        holder.execute(
            text("SELECT id FROM guest_sessions WHERE id = :id FOR UPDATE"), {"id": session}
        )

        async def scenario():
            async def work():
                return "transcript"

            caller = asyncio.create_task(runner.run(reserving(session), work))
            while lock_waiters(db_engine, "guest_sessions") == 0:
                await asyncio.sleep(0.02)  # the reserve is blocked in the database
            started = time.monotonic()
            outcome = await runner.stop()
            elapsed = time.monotonic() - started
            with pytest.raises(ImportsStopped):
                await caller
            return outcome, elapsed

        outcome, elapsed = asyncio.run(scenario())
        # Ended by the database's lock timeout, well before the holder lets go.
        assert outcome.quiescent and runner.db_calls() == 0
        assert SLOW_TIMEOUT * 0.8 <= elapsed < runner.stop_bound_seconds, elapsed
        assert lock_waiters(db_engine, "guest_sessions") == 0
        time.sleep(SLOW_TIMEOUT)  # the holder keeps its lock past every timeout
        hold.rollback()
    assert import_rows(db_engine) == []


def test_stop_while_settle_waits_on_a_row_lock_bounds_settle_and_release(factory, db_engine):
    """The import's row is locked by another client far longer than the timeout: the cancelled
    settle ends by lock timeout, then the shutdown release waits (also bounded) and fails; the
    row stays reserved, never charged or released twice, and recovery releases it after a
    restart."""
    session = new_session(factory)
    runner = GuestImportRunner(factory, db_timeout_seconds=SLOW_TIMEOUT)
    with db_engine.connect() as holder:

        async def scenario():
            go = asyncio.Event()

            async def work():
                await go.wait()
                return "transcript"

            caller = asyncio.create_task(runner.run(reserving(session), work))
            while not runner.running_ids():
                await asyncio.sleep(0.01)
            (operation,) = runner.running_ids()
            hold = holder.begin()
            holder.execute(
                text("SELECT id FROM guest_import_quota WHERE id = :id FOR UPDATE"),
                {"id": operation},
            )
            go.set()
            while lock_waiters(db_engine, "guest_import_quota") == 0:
                await asyncio.sleep(0.02)  # settle(used) is blocked in the database
            started = time.monotonic()
            outcome = await runner.stop()
            elapsed = time.monotonic() - started
            with pytest.raises(ImportsStopped):
                await caller
            return outcome, elapsed, hold

        outcome, elapsed, hold = asyncio.run(scenario())
        assert outcome.quiescent and outcome.released == 0 and runner.db_calls() == 0
        # Both the settle and the release waited, each ended by the database within its bound.
        assert 2 * SLOW_TIMEOUT * 0.8 <= elapsed < 2 * runner.stop_bound_seconds, elapsed
        assert lock_waiters(db_engine, "guest_import_quota") == 0
        hold.rollback()
    (row,) = import_rows(db_engine)
    assert row.state == "reserved"  # neither charged nor released
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE guest_import_quota SET heartbeat_at = now() - interval '10 minutes'")
        )
    with factory.begin() as db:  # the next instance's recovery
        assert (
            guest_imports.release_stale_imports(db, stale_after_seconds=90, max_age_seconds=180)
            == 1
        )
        assert (
            guest_imports.release_stale_imports(db, stale_after_seconds=90, max_age_seconds=180)
            == 0
        )
    assert states(db_engine) == ["released"]


def test_a_step_the_database_cannot_end_leaves_the_import_engine_open(
    make_settings, fake_cognito, db_engine, monkeypatch
):
    """A step stuck outside the database (as on a dead network, past every timeout): shutdown
    still ends within its budget, does not claim the import database work is over (no release,
    the import engine is not disposed), and the late step settles the row exactly once."""
    grace = 0.5
    hang = 5.0
    real_settle = guest_imports.settle_import
    settling = threading.Event()
    finished = threading.Event()

    def stuck_settle(db, operation_id, *, used):
        settling.set()
        time.sleep(hang)
        try:
            return real_settle(db, operation_id, used=used)
        finally:
            finished.set()

    monkeypatch.setattr(guest_imports, "settle_import", stuck_settle)
    services = build_services(
        make_settings(**{**GUEST_SETTINGS, **SUPADATA}, job_shutdown_grace_seconds=grace),
        youtube_import_transport=httpx.MockTransport(supadata_ok),
        cognito_client=fake_cognito,
    )
    database = DatabaseActivity(services)
    runner = services.guest_imports
    assert runner is not None
    client = TestClient(create_app(services=services))
    client.__enter__()
    result: dict = {}
    try:
        csrf = start_guest(client)["csrf_token"]
        worker = threading.Thread(target=lambda: result.update(r=guest_import(client, csrf)))
        worker.start()
        assert settling.wait(10)
    finally:
        started = time.monotonic()
        stopping = threading.Thread(target=client.__exit__, args=(None, None, None), daemon=True)
        stopping.start()
        stopping.join(grace + 2 * runner.stop_bound_seconds + 5)
        elapsed = time.monotonic() - started
    assert not stopping.is_alive(), "shutdown did not finish"
    worker.join(10)

    # The budget: the shared grace plus at most the first stop phase (no release attempted).
    assert elapsed < grace + runner.stop_bound_seconds + 1.0, elapsed
    assert not finished.is_set()  # the stuck step was still running when shutdown returned
    assert result["r"].json()["error"]["code"] == "youtube_import_cancelled"
    assert database.shared_disposed.is_set()
    assert not database.import_disposed.is_set()  # never claimed free while a step may run
    assert finished.wait(hang + 5)
    # The late step settled the row once (used); nothing released it as well.
    assert states(db_engine) == ["used"]
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE guest_import_quota SET heartbeat_at = now() - interval '10 minutes'")
        )
    with factory_for(db_engine).begin() as db:
        assert (
            guest_imports.release_stale_imports(db, stale_after_seconds=90, max_age_seconds=180)
            == 0
        )
    assert states(db_engine) == ["used"]
    services.guest_import_engine.dispose()  # type: ignore[union-attr]


def factory_for(db_engine) -> sessionmaker:
    return sessionmaker(bind=db_engine, expire_on_commit=False)
