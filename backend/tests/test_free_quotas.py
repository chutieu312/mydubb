"""Free plan quotas, the shared non-administrator cap and the administrator exemption
(app/quotas, docs/API.md "Usage limits"). Fake Cognito, mock pipeline, fake Supadata transport,
disposable PostgreSQL: nothing reaches a real provider.
"""

import threading
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Engine, text
from sqlalchemy.orm import sessionmaker

from app.audio.speed import AudioSpeed
from app.auth.principal import Principal, UserProfile
from app.config import Settings
from app.main import create_app
from app.maintenance import run_cleanup
from app.quotas import service as quotas
from app.quotas.service import (
    AccountQuotaExhausted,
    QuotaKind,
    UsageCapReached,
    UsageCaps,
    resets_at,
    utc_day,
)
from app.services import build_services
from tests.conftest import COGNITO_SETTINGS, VALID_JOB, sign_in, wait_for_terminal
from tests.test_extension_auth import EXT_ID, _bearer, _connect
from tests.test_guest_access import GUEST_SETTINGS, IP_A, IP_HEADER, guest_job, start_guest
from tests.test_guest_youtube_import import captions, guest_import, import_quota
from tests.test_youtube_import_api import SUPADATA, URL, respond, supadata_ok

EMAIL = "lan@example.com"
OTHER_EMAIL = "minh@example.com"
PASSWORD = "correct-horse-1"
IMPORT = "/api/transcripts/youtube"
BASE: dict[str, Any] = {
    **COGNITO_SETTINGS,
    **SUPADATA,
    "extension_ids": [EXT_ID],
    # Capacity is not what these tests are about (except where they say so).
    "job_max_concurrency": 4,
    "job_max_queued": 200,
}
CAPS = {
    "usage_caps_enabled": True,
    "usage_cap_generates_per_day": 3,
    "usage_cap_youtube_imports_per_day": 2,
}


@pytest.fixture
def make_app(
    make_settings: Callable[..., Settings], fake_cognito, db_engine
) -> Iterator[Callable[..., TestClient]]:
    """An app instance (its own services, like another server instance) on the shared database."""
    fake_cognito.add_user(EMAIL, PASSWORD, name="Lan")
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    clients: list[TestClient] = []

    def factory(handler: Callable = supadata_ok, **overrides: Any) -> TestClient:
        settings = make_settings(**{**BASE, **overrides})
        services = build_services(
            settings,
            youtube_import_transport=httpx.MockTransport(handler),
            cognito_client=fake_cognito,
        )
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def web_session(client: TestClient, email: str = EMAIL) -> str:
    return sign_in(client, email, PASSWORD)["csrf_token"]


def generate(client: TestClient, csrf: str, **overrides: Any) -> httpx.Response:
    return client.post("/api/jobs", json={**VALID_JOB, **overrides}, headers={"X-CSRF-Token": csrf})


def import_(client: TestClient, csrf: str) -> httpx.Response:
    return client.post(IMPORT, json={"url": URL}, headers={"X-CSRF-Token": csrf})


def usage(client: TestClient) -> dict:
    response = client.get("/api/account/usage")
    assert response.status_code == 200, response.text
    return response.json()


def counters(db_engine: Engine) -> dict[tuple[str, str], int]:
    """Today's counters as {(subject, kind): count}; subjects of accounts read as their email."""
    with db_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT coalesce(u.email, c.subject), c.kind, c.count FROM usage_counters c "
                "LEFT JOIN users u ON c.subject = 'user:' || u.id::text"
            )
        ).all()
    return {(subject, kind): count for subject, kind, count in rows}


def set_role(db_engine: Engine, role: str, email: str = EMAIL) -> None:
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE users SET role = :r WHERE email_normalized = :e"), {"r": role, "e": email}
        )


def error_code(response: httpx.Response) -> str:
    return response.json()["error"]["code"]


def accepted(responses: list) -> int:
    return sum(
        1 for r in responses if isinstance(r, httpx.Response) and r.status_code in (200, 202)
    )


def run_concurrently(count: int, work: Callable[[int], object]) -> list[object]:
    barrier = threading.Barrier(count)
    results: list[object] = [None] * count

    def target(i: int) -> None:
        barrier.wait()
        try:
            results[i] = work(i)
        except Exception as exc:  # reported to the test as a result
            results[i] = exc

    threads = [threading.Thread(target=target, args=(i,)) for i in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    return results


# -- the Free quotas ---------------------------------------------------------------------------


def test_twenty_jobs_and_five_imports_a_day_counted_apart(make_app, db_engine):
    client = make_app()
    csrf = web_session(client)
    fresh = usage(client)
    assert fresh["plan"] == "free" and fresh["exempt"] is False
    assert fresh["generate"] == {"used": 0, "limit": 20, "remaining": 20}
    assert fresh["youtube_import"] == {"used": 0, "limit": 5, "remaining": 5}
    assert (fresh["max_words"], fresh["max_output_seconds"]) == (1000, 600)

    for _ in range(5):
        assert import_(client, csrf).status_code == 200
    refused = import_(client, csrf)
    assert refused.status_code == 429
    assert error_code(refused) == "daily_import_quota_exhausted"
    # The imports used up nothing of the jobs.
    assert usage(client)["generate"]["remaining"] == 20

    for _ in range(20):
        assert generate(client, csrf).status_code == 202
    refused = generate(client, csrf)
    assert refused.status_code == 429
    body = refused.json()["error"]
    assert body["code"] == "daily_generate_quota_exhausted"
    assert (body["plan"], body["limit"]) == ("free", 20)
    assert body["resets_at"].endswith("+00:00") and "T00:00:00" in body["resets_at"]
    assert int(refused.headers["Retry-After"]) == body["retry_after_seconds"] > 0
    assert "after 00:00 UTC" in body["message"]

    assert counters(db_engine) == {(EMAIL, "generate"): 20, (EMAIL, "youtube_import"): 5}
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 20
    # Another account has its own quotas.
    other = make_app()
    other_csrf = web_session(other, OTHER_EMAIL)
    assert generate(other, other_csrf).status_code == 202
    assert import_(other, other_csrf).status_code == 200


def test_sign_ins_devices_extension_and_restarts_share_one_quota(make_app, db_engine):
    """Web sessions on two instances and the extension's bearer token, all at once."""
    web_a, web_b, ext = make_app(), make_app(), make_app()
    csrf_a, csrf_b = web_session(web_a), web_session(web_b)
    token = _connect(make_app(), ext)["access_token"]

    def work(i: int) -> httpx.Response:
        if i % 3 == 0:
            return generate(web_a, csrf_a)
        if i % 3 == 1:
            return generate(web_b, csrf_b)
        return ext.post("/api/jobs", json=VALID_JOB, headers=_bearer(token))

    results = run_concurrently(30, work)
    assert accepted(results) == 20
    refusals = [r for r in results if isinstance(r, httpx.Response) and r.status_code == 429]
    assert len(refusals) == 10
    assert {error_code(r) for r in refusals} == {"daily_generate_quota_exhausted"}
    assert counters(db_engine)[(EMAIL, "generate")] == 20

    # A new sign-in on a restarted instance still sees the day's count.
    restarted = make_app()
    csrf = web_session(restarted)
    assert usage(restarted)["generate"] == {"used": 20, "limit": 20, "remaining": 0}
    assert error_code(generate(restarted, csrf)) == "daily_generate_quota_exhausted"


def test_concurrent_admissions_of_one_account_never_pass_its_quota(db_engine):
    """Straight against PostgreSQL: one transaction per thread, all at once."""
    factory = sessionmaker(db_engine)
    user_id = uuid.uuid4()
    principal = account_principal(user_id)

    def admit_one(_: int) -> str:
        with factory() as db:
            try:
                quotas.admit(db, principal, QuotaKind.GENERATE, None)
                db.commit()
                return "ok"
            except AccountQuotaExhausted:
                db.rollback()
                return "refused"

    results = run_concurrently(32, admit_one)
    assert results.count("ok") == 20 and results.count("refused") == 12
    with db_engine.connect() as conn:
        count = conn.execute(text("SELECT count FROM usage_counters")).scalar_one()
    assert count == 20


def account_principal(user_id: uuid.UUID, *, exempt: bool = False) -> Principal:
    return Principal(
        session_id=uuid.uuid4(),
        csrf_token="x",
        expires_at=datetime.now(UTC),
        user=UserProfile(id=user_id, email="x@example.com", display_name=None),
        quota_exempt=exempt,
    )


# -- the UTC day --------------------------------------------------------------------------------


def test_the_day_is_the_utc_date_and_resets_at_midnight():
    late = datetime(2026, 11, 8, 23, 59, 59, 999_999, tzinfo=UTC)
    assert utc_day(late) == date(2026, 11, 8)
    assert utc_day(late + timedelta(microseconds=1)) == date(2026, 11, 9)
    # 16:30 in Ho Chi Minh City (UTC+7) is still 09:30 UTC of the same day.
    from zoneinfo import ZoneInfo

    assert utc_day(datetime(2026, 11, 9, 6, 30, tzinfo=ZoneInfo("Asia/Ho_Chi_Minh"))) == date(
        2026, 11, 8
    )
    assert resets_at(date(2026, 11, 8)) == datetime(2026, 11, 9, tzinfo=UTC)


def test_quota_resets_at_midnight_utc_and_a_job_counts_on_its_admission_day(
    make_app, db_engine, monkeypatch
):
    clock = {"now": datetime(2026, 11, 8, 23, 59, 58, tzinfo=UTC)}
    monkeypatch.setattr(quotas, "current_time", lambda db: clock["now"])
    client = make_app(mock_stage_delay_seconds=0.3)
    csrf = web_session(client)
    for _ in range(19):
        assert generate(client, csrf).status_code == 202
    # The 20th is accepted at 23:59:59 and finishes after midnight.
    clock["now"] = datetime(2026, 11, 8, 23, 59, 59, 900_000, tzinfo=UTC)
    last = generate(client, csrf)
    assert last.status_code == 202
    assert error_code(generate(client, csrf)) == "daily_generate_quota_exhausted"
    clock["now"] = datetime(2026, 11, 9, 0, 0, 0, tzinfo=UTC)
    assert wait_for_terminal(client, last.json()["id"])["status"] == "completed"

    # The new day starts from zero; the job that ended after midnight stays on its own day.
    today = usage(client)
    assert today["day"] == "2026-11-09"
    assert today["resets_at"] == "2026-11-10T00:00:00Z"
    assert today["generate"]["used"] == 0
    assert generate(client, csrf).status_code == 202
    with db_engine.connect() as conn:
        days = dict(conn.execute(text("SELECT day, count FROM usage_counters")).all())
    assert days == {date(2026, 11, 8): 20, date(2026, 11, 9): 1}


# -- what counts ---------------------------------------------------------------------------------


def test_an_accepted_job_that_fails_still_counts(make_app, db_engine):
    client = make_app(mock_fail_stage="speech")
    csrf = web_session(client)
    job = generate(client, csrf).json()
    assert wait_for_terminal(client, job["id"])["status"] == "failed"
    assert usage(client)["generate"]["used"] == 1


@pytest.mark.parametrize(
    "handler",
    [respond(500, {"error": "boom"}), respond(206, {"error": "transcript-unavailable"})],
)
def test_an_accepted_import_whose_provider_fails_still_counts(make_app, handler):
    client = make_app(handler)
    csrf = web_session(client)
    assert import_(client, csrf).status_code >= 400
    assert usage(client)["youtube_import"]["used"] == 1


def test_refusals_before_admission_count_nothing(make_app, db_engine):
    client = make_app(job_max_concurrency=1, job_max_queued=0, mock_stage_delay_seconds=1)
    csrf = web_session(client)
    # Validation, the plan's per-job limits, a missing session and CSRF.
    assert generate(client, csrf, first_sentence_start="00:09:00").status_code == 422
    assert error_code(generate(client, csrf, transcript="word " * 1001)) == (
        "plan_word_limit_exceeded"
    )
    assert generate(client, "wrong").status_code == 403
    assert make_app().post("/api/jobs", json=VALID_JOB).status_code == 401
    # Capacity: the server is busy before admission.
    running = generate(client, csrf)
    assert running.status_code == 202
    busy = generate(client, csrf)
    assert busy.status_code == 503 and error_code(busy) == "server_at_capacity"
    assert counters(db_engine) == {(EMAIL, "generate"): 1}
    # Polling, the result and the audio count nothing.
    job_id = running.json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert client.get(f"/api/jobs/{job_id}/result").status_code == 200
    assert client.get(f"/api/jobs/{job_id}/result/audio").status_code == 200
    assert counters(db_engine) == {(EMAIL, "generate"): 1}


def test_a_busy_import_counts_nothing_and_gives_its_slot_back(make_app):
    entered, release = threading.Event(), threading.Event()

    async def blocking(request: httpx.Request) -> httpx.Response:
        import asyncio

        entered.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        return supadata_ok(request)

    client = make_app(blocking, youtube_import_max_concurrent=1)
    csrf = web_session(client)
    result: dict = {}
    worker = threading.Thread(target=lambda: result.update(r=import_(client, csrf)))
    worker.start()
    try:
        assert entered.wait(10)
        busy = import_(client, csrf)
        assert busy.status_code == 503 and error_code(busy) == "youtube_import_busy"
    finally:
        release.set()
        worker.join(10)
    assert result["r"].status_code == 200
    assert usage(client)["youtube_import"]["used"] == 1


# -- the plan's per-job limits -----------------------------------------------------------------


def test_the_word_limit_is_1000_words_without_timestamps(make_app):
    client = make_app()
    csrf = web_session(client)
    at_limit = "\n".join(f"0:{i:02d}\n{'gradient ' * 20}" for i in range(50))  # 50 x 20 words
    assert generate(client, csrf, transcript=at_limit).status_code == 202
    over = generate(client, csrf, transcript="word " * 1001)
    assert over.status_code == 422
    body = over.json()["error"]
    assert body["code"] == "plan_word_limit_exceeded"
    assert (body["word_count"], body["max_words"]) == (1001, 1000)
    assert body["fields"][0]["field"] == "transcript"
    assert usage(client)["generate"]["used"] == 1


@pytest.mark.parametrize("speed", [s.number for s in AudioSpeed])
def test_the_audio_limit_is_600_seconds_after_speed(make_app, speed):
    client = make_app()
    csrf = web_session(client)
    baseline = round(600 * speed)  # every supported speed gives whole seconds here
    first = 10

    def clock(seconds: int) -> str:
        return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"

    fits = generate(
        client,
        csrf,
        speed=speed,
        first_sentence_start=clock(first),
        last_sentence_start=clock(first + baseline),
    )
    assert fits.status_code == 202, fits.text
    over = generate(
        client,
        csrf,
        speed=speed,
        first_sentence_start=clock(first),
        last_sentence_start=clock(first + baseline + 1),
    )
    assert over.status_code == 422
    body = over.json()["error"]
    assert body["code"] == "plan_duration_limit_exceeded"
    assert body["max_output_seconds"] == 600 and body["output_seconds"] > 600
    assert body["baseline_seconds"] == baseline + 1
    assert usage(client)["generate"]["used"] == 1


def test_a_long_import_is_kept_whole_and_still_counts(make_app):
    long_track = captions(300, 1234, words=10)  # 3,000 words over about 6 minutes
    client = make_app(respond(200, long_track))
    csrf = web_session(client)
    imported = import_(client, csrf)
    assert imported.status_code == 200
    transcript = imported.json()["transcript"]
    lines = transcript.splitlines()
    assert len(lines) == 600  # a time line and a text line per caption, none dropped
    # Milliseconds kept: 480 ms, and 480 + 299 x 1,234 ms for the last caption.
    assert lines[0] == "0:00.480" and lines[-2] == "6:09.446"
    assert [line for line in lines[1::2]] == [c["text"] for c in long_track["content"]]
    assert usage(client)["youtube_import"]["used"] == 1
    # Too long to generate on the Free plan: refused before admission, nothing changed.
    refused = generate(client, csrf, transcript=transcript)
    assert error_code(refused) == "plan_word_limit_exceeded"
    assert usage(client)["generate"]["used"] == 0


# -- administrators ------------------------------------------------------------------------------


def test_an_administrator_is_exempt_on_the_web_and_with_the_extension(make_app, db_engine):
    web, ext = make_app(), make_app()
    csrf = web_session(web)
    token = _connect(make_app(), ext)["access_token"]
    set_role(db_engine, "admin")
    assert usage(web)["exempt"] is True
    assert usage(web)["generate"]["limit"] is None

    for i in range(22):
        response = (
            generate(web, csrf)
            if i % 2
            else ext.post("/api/jobs", json=VALID_JOB, headers=_bearer(token))
        )
        assert response.status_code == 202, response.text
    for _ in range(6):
        assert import_(web, csrf).status_code == 200
    # Free's per-job limits do not apply either.
    assert generate(web, csrf, transcript="word " * 1500).status_code == 202
    long = {"first_sentence_start": "00:00:00", "last_sentence_start": "00:30:00"}
    assert generate(web, csrf, **long).status_code == 202
    # Still recorded, so it shows in the account's usage.
    assert counters(db_engine) == {(EMAIL, "generate"): 24, (EMAIL, "youtube_import"): 6}
    assert usage(web)["generate"] == {"used": 24, "limit": None, "remaining": None}
    # The extension token never reaches administration.
    assert ext.get("/api/admin/session", headers=_bearer(token)).status_code == 401
    assert web.get("/api/admin/session").status_code == 200


def test_revoking_the_role_takes_effect_on_the_next_admission(make_app, db_engine):
    web, ext = make_app(), make_app()
    csrf = web_session(web)
    token = _connect(make_app(), ext)["access_token"]
    set_role(db_engine, "admin")
    for _ in range(21):
        assert generate(web, csrf).status_code == 202
    set_role(db_engine, "user")
    # The day's 21 admissions already count against Free's 20.
    assert error_code(generate(web, csrf)) == "daily_generate_quota_exhausted"
    bearer = ext.post("/api/jobs", json=VALID_JOB, headers=_bearer(token))
    assert error_code(bearer) == "daily_generate_quota_exhausted"
    assert error_code(generate(web, csrf, transcript="word " * 1001)) == (
        "plan_word_limit_exceeded"
    )
    assert usage(web)["exempt"] is False


def test_an_administrator_is_still_bound_by_capacity(make_app, db_engine):
    client = make_app(job_max_concurrency=1, job_max_queued=0, mock_stage_delay_seconds=1)
    csrf = web_session(client)
    set_role(db_engine, "admin")
    assert generate(client, csrf).status_code == 202
    busy = generate(client, csrf)
    assert busy.status_code == 503 and error_code(busy) == "server_at_capacity"
    assert counters(db_engine) == {(EMAIL, "generate"): 1}


def test_the_role_and_plan_of_the_request_body_are_ignored(make_app, db_engine):
    client = make_app()
    csrf = web_session(client)
    for _ in range(20):
        assert generate(client, csrf).status_code == 202
    sneaky = generate(client, csrf, role="admin", plan="max", user_id=str(uuid.uuid4()))
    assert error_code(sneaky) == "daily_generate_quota_exhausted"


# -- the shared cap ------------------------------------------------------------------------------


def test_caps_are_off_by_default_and_need_both_numbers(make_settings):
    assert UsageCaps.from_settings(make_settings()) is None
    with pytest.raises(ValidationError, match="USAGE_CAP_YOUTUBE_IMPORTS_PER_DAY"):
        make_settings(usage_caps_enabled=True, usage_cap_generates_per_day=10)
    with pytest.raises(ValidationError, match="USAGE_CAP_GENERATES_PER_DAY"):
        make_settings(usage_caps_enabled=True, usage_cap_youtube_imports_per_day=3)
    for bad in (0, -1, "many"):
        with pytest.raises(ValidationError):
            make_settings(**{**CAPS, "usage_cap_generates_per_day": bad})
    caps = UsageCaps.from_settings(make_settings(**CAPS))
    assert caps == UsageCaps(generates_per_day=3, youtube_imports_per_day=2)


def test_the_generate_cap_is_shared_and_a_refusal_counts_nowhere_else(make_app, db_engine):
    lan_app, minh_app = make_app(**CAPS), make_app(**CAPS)
    lan, minh = web_session(lan_app), web_session(minh_app, OTHER_EMAIL)
    assert generate(lan_app, lan).status_code == 202
    assert generate(lan_app, lan).status_code == 202
    assert generate(minh_app, minh).status_code == 202
    refused = generate(minh_app, minh)
    assert refused.status_code == 503
    body = refused.json()["error"]
    assert body["code"] == "generate_daily_cap_reached"
    assert "shared by all users" in body["message"]
    assert int(refused.headers["Retry-After"]) == body["retry_after_seconds"]
    # The refused admission left the account's count as it was; no job row was written.
    assert counters(db_engine) == {
        (EMAIL, "generate"): 2,
        (OTHER_EMAIL, "generate"): 1,
        ("global", "generate"): 3,
    }
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 3
    # Imports have their own cap.
    assert import_(minh_app, minh).status_code == 200
    assert import_(lan_app, lan).status_code == 200
    capped = import_(lan_app, lan)
    assert capped.status_code == 503 and error_code(capped) == "import_daily_cap_reached"
    assert counters(db_engine)[(EMAIL, "youtube_import")] == 1
    # Administrators are not capped and do not use up the cap.
    set_role(db_engine, "admin")
    assert generate(lan_app, lan).status_code == 202
    assert import_(lan_app, lan).status_code == 200
    assert counters(db_engine)[("global", "generate")] == 3


def test_at_the_cap_sign_in_results_audio_and_accepted_jobs_go_on(make_app, db_engine):
    client = make_app(**CAPS, mock_stage_delay_seconds=0.3)
    csrf = web_session(client)
    jobs = [generate(client, csrf).json()["id"] for _ in range(3)]
    assert error_code(generate(client, csrf)) == "generate_daily_cap_reached"
    for job_id in jobs:  # accepted before the cap was reached: they finish
        assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert client.get(f"/api/jobs/{jobs[0]}/result").status_code == 200
    assert client.get(f"/api/jobs/{jobs[0]}/result/audio").status_code == 200
    again = make_app(**CAPS)
    web_session(again)  # signing in still works
    assert usage(again)["generate"]["used"] == 3


def test_guests_are_capped_and_keep_their_own_give_back(make_app, db_engine):
    guest_app = make_app(**{**GUEST_SETTINGS, **CAPS}, mock_fail_stage="speech")
    guest = start_guest(guest_app)
    failed = guest_job(guest_app, guest["csrf_token"])
    assert failed.status_code == 202
    assert wait_for_terminal(guest_app, failed.json()["id"])["status"] == "failed"
    session = guest_app.get("/api/guest/session", headers={IP_HEADER: IP_A}).json()["quota"]
    # The guest's own quota gave the failed job's place back; the shared cap did not.
    assert session["session_used"] == 0 and session["session_remaining"] == 5
    assert counters(db_engine) == {("global", "generate"): 1}

    account = make_app(**CAPS)
    csrf = web_session(account)
    assert generate(account, csrf).status_code == 202
    assert generate(account, csrf).status_code == 202
    capped = guest_job(guest_app, guest["csrf_token"])
    assert capped.status_code == 503 and error_code(capped) == "generate_daily_cap_reached"
    # The refusal also undid the guest's job row and quota place.
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM guest_job_quota")).scalar_one() == 1
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 3


def test_guest_imports_are_capped_and_a_refusal_writes_no_place(make_app, db_engine):
    guest_app = make_app(**{**GUEST_SETTINGS, **CAPS})
    guest = start_guest(guest_app)
    account = make_app(**CAPS)
    csrf = web_session(account)
    assert import_(account, csrf).status_code == 200
    assert guest_import(guest_app, guest["csrf_token"]).status_code == 200
    capped = guest_import(guest_app, guest["csrf_token"])
    assert capped.status_code == 503 and error_code(capped) == "import_daily_cap_reached"
    assert import_quota(guest_app)["session_used"] == 1
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM guest_import_quota")).scalar_one() == 1


def test_access_code_sessions_are_capped(make_client, db_engine):
    from tests.conftest import login

    client = make_client(**CAPS, job_max_queued=50)
    csrf = login(client)
    for _ in range(3):
        assert generate(client, csrf).status_code == 202
    assert error_code(generate(client, csrf)) == "generate_daily_cap_reached"
    assert counters(db_engine) == {("global", "generate"): 3}


def test_the_cap_refusal_comes_after_the_account_quota(db_engine):
    """A refused shared cap rolls back the account's count in the same transaction."""
    factory = sessionmaker(db_engine)
    caps = UsageCaps(generates_per_day=1, youtube_imports_per_day=1)
    first, second = account_principal(uuid.uuid4()), account_principal(uuid.uuid4())
    with factory() as db:
        quotas.admit(db, first, QuotaKind.GENERATE, caps)
        db.commit()
    with factory() as db, pytest.raises(UsageCapReached):
        quotas.admit(db, second, QuotaKind.GENERATE, caps)
    with db_engine.connect() as conn:
        subjects = conn.execute(text("SELECT subject FROM usage_counters ORDER BY 1")).scalars()
        assert list(subjects) == ["global", f"user:{first.user.id}"]  # type: ignore[union-attr]


# -- storage -------------------------------------------------------------------------------------


def test_cleanup_keeps_recent_days_only(make_app, db_engine):
    client = make_app()
    old, recent = date.today() - timedelta(days=40), date.today() - timedelta(days=3)
    with db_engine.begin() as conn:
        for day in (old, recent):
            conn.execute(
                text(
                    "INSERT INTO usage_counters (subject, kind, day, count, updated_at) "
                    "VALUES ('global', 'generate', :d, 5, now())"
                ),
                {"d": day},
            )
    run_cleanup(client.app.state.services)
    with db_engine.connect() as conn:
        days = conn.execute(text("SELECT day FROM usage_counters")).scalars().all()
    assert days == [recent]


def test_models_match_the_migration(db_engine):
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    from app.db import Base

    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn, opts={"compare_type": True})
        diffs = compare_metadata(context, Base.metadata)
    assert [d for d in diffs if "usage_counters" in repr(d) or "plan" in repr(d)] == []


def test_the_plan_is_checked_by_the_database_and_defaults_to_free(make_app, db_engine):
    client = make_app()
    web_session(client)
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT plan FROM users")).scalar_one() == "free"
    with pytest.raises(Exception, match="ck_users_plan_valid"), db_engine.begin() as conn:
        conn.execute(text("UPDATE users SET plan = 'max'"))


def test_the_migration_makes_every_existing_account_free_and_keeps_roles(engine, database_url):
    """0020 -> 0021_free_quotas on accounts written before it (an administrator, a user); then
    down and up again."""
    from alembic import command
    from sqlalchemy import inspect

    from tests.conftest import alembic_config

    config = alembic_config(database_url)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE jobs, users, usage_counters CASCADE"))
    command.downgrade(config, "0020")
    try:
        assert "usage_counters" not in inspect(engine).get_table_names()
        with engine.begin() as conn:
            for sub, email, role in (("s-1", "a@example.com", "admin"), ("s-2", "b@x.org", "user")):
                # Columns as the 0020-era code writes them (no plan).
                conn.execute(
                    text(
                        "INSERT INTO users (id, cognito_issuer, cognito_sub, email, "
                        "email_normalized, role, created_at, updated_at) VALUES (:id, 'issuer', "
                        ":sub, :e, :e, :role, now(), now())"
                    ),
                    {"id": uuid.uuid4(), "sub": sub, "e": email, "role": role},
                )
        command.upgrade(config, "head")
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT email, role, plan FROM users ORDER BY email")).all()
        assert [tuple(r) for r in rows] == [
            ("a@example.com", "admin", "free"),
            ("b@x.org", "user", "free"),
        ]
        # Older code keeps inserting users without naming the plan.
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, cognito_issuer, cognito_sub, email, email_normalized, "
                    "created_at, updated_at) VALUES (:id, 'issuer', 's-3', 'c@x.org', 'c@x.org', "
                    "now(), now())"
                ),
                {"id": uuid.uuid4()},
            )
        command.downgrade(config, "0020")
        assert "plan" not in {c["name"] for c in inspect(engine).get_columns("users")}
    finally:
        command.upgrade(config, "head")
    with engine.connect() as conn:
        assert (
            conn.execute(text("SELECT count(*) FROM users WHERE plan = 'free'")).scalar_one() == 3
        )
        assert conn.execute(
            text("SELECT role FROM users WHERE email = 'a@example.com'")
        ).scalar() == ("admin")
