"""The Usage & Costs API: who may read it, its filters and pages, that its figures are the report's,
its snapshot and limits, and what it never returns. Real routes (auth first), PostgreSQL, the fake
user pool and mock providers. docs/USAGE_COSTS.md, "The Usage & Costs page"."""

import csv
import io
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text
from sqlalchemy.exc import InternalError, OperationalError, ProgrammingError
from sqlalchemy.orm import sessionmaker

from app.admin import usage as admin_usage
from app.db import session_scope
from app.dependencies import AUTH_COOKIE
from app.usage import queries, store
from app.usage.models import JobUsage
from app.usage.pricing import load_price_book
from app.usage.report import Filters, build_report, write_job_csv
from tests.conftest import create_job, sign_in, wait_for_terminal
from tests.test_admin_role import (
    EMAIL,
    EXT_ID,
    OTHER_EMAIL,
    PASSWORD,
    _connect_extension,
    _grant,
    _revoke,
    _run_tool,
)
from tests.test_guest_access import GUEST_SETTINGS, start_guest
from tests.test_job_liveness import new_job
from tests.test_usage_report import T, add_job, attempt_values, summary_values

SUMMARY = "/api/admin/usage/summary"
JOBS = "/api/admin/usage/jobs"
PERIOD = {"since": "2026-10-10T00:00:00Z", "until": "2026-10-11T00:00:00Z"}


def job_url(job_id: uuid.UUID | str) -> str:
    return f"{JOBS}/{job_id}"


@pytest.fixture
def web(make_cognito_client, fake_cognito) -> TestClient:
    fake_cognito.add_user(EMAIL, PASSWORD, name="Lan")
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    return make_cognito_client(extension_ids=[EXT_ID])


@pytest.fixture
def admin(web, db_engine) -> TestClient:
    sign_in(web, EMAIL, PASSWORD)
    _grant(db_engine)
    return web


def get_ok(client: TestClient, url: str, **params) -> dict:
    response = client.get(url, params=params)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def field_error(response) -> tuple[str, str]:
    assert response.status_code == 422, response.text
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    return body["fields"][0]["field"], body["fields"][0]["message"]


def add_rows(engine: Engine, job_id: uuid.UUID, started: datetime, *attempts: dict, **summary):
    with session_scope(sessionmaker(bind=engine)) as db:
        store.upsert_summary(db, job_id, summary_values(started, **summary))
        store.insert_attempts(db, [{"job_id": job_id, **a} for a in attempts])
    return job_id


def mock_attempt(seq: int, service: str, started: datetime = T) -> dict:
    return attempt_values(
        seq,
        service,
        None,
        started,
        provider_kind="mock",
        usage_basis="none",
        outcome="ok",
        sent_amount=900,
        usage_method="mock-not-billed",
    )


def statements_during(engine: Engine):
    """Every statement the app's engine runs while the returned context is open."""

    class Recorder:
        def __enter__(self):
            self.statements = []
            event.listen(engine, "before_cursor_execute", self._record)
            return self.statements

        def _record(self, conn, cursor, statement, parameters, context, executemany):
            self.statements.append(statement)

        def __exit__(self, *_):
            event.remove(engine, "before_cursor_execute", self._record)

    return Recorder()


def app_engine(client: TestClient) -> Engine:
    return client.app.state.services.engine  # type: ignore[attr-defined]


def report_statements(statements: list[str]) -> list[str]:
    return [s for s in statements if "job_usage" in s or "TRANSACTION" in s]


# -- who may read it ------------------------------------------------------------------------------


ALL_URLS = [SUMMARY, JOBS, job_url(uuid.uuid4())]


@pytest.mark.parametrize("url", ALL_URLS)
def test_an_administrator_reads_and_nobody_else(url, web, make_cognito_client, db_engine):
    # Nobody signed in.
    anonymous = make_cognito_client()
    assert anonymous.get(url).status_code == 401

    # An ordinary user, in the same session that is an administrator later.
    sign_in(web, EMAIL, PASSWORD)
    refused = web.get(url)
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "admin_required"

    _grant(db_engine)
    assert web.get(url).status_code in (200, 404)  # 404: that job has no usage record

    # The next request after a revocation is refused, and the user stays signed in.
    _revoke(db_engine)
    assert web.get(url).status_code == 403
    assert web.get("/api/auth/me").status_code == 200


@pytest.mark.parametrize("url", ALL_URLS)
def test_a_guest_is_refused(url, make_cognito_client, db_engine):
    guest = make_cognito_client(**GUEST_SETTINGS)
    start_guest(guest)
    assert guest.get(url).status_code == 401


def test_a_disabled_expired_or_revoked_session_is_refused(admin, db_engine):
    assert admin.get(SUMMARY).status_code == 200
    token = admin.cookies[AUTH_COOKIE]

    _run_tool(db_engine, "revoke-sessions", EMAIL)
    assert admin.get(SUMMARY).status_code == 401

    admin.cookies.clear()
    sign_in(admin, EMAIL, PASSWORD)
    assert admin.get(SUMMARY).status_code == 200
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE user_sessions SET expires_at = now()"))
    assert admin.get(SUMMARY).status_code == 401

    admin.cookies.clear()
    sign_in(admin, EMAIL, PASSWORD)
    _run_tool(db_engine, "disable", EMAIL)
    assert admin.get(SUMMARY).status_code == 401
    admin.cookies.set(AUTH_COOKIE, token)
    assert admin.get(SUMMARY).status_code == 401


def test_the_extension_token_never_reads_it_even_next_to_an_admin_cookie(
    admin, make_cognito_client, db_engine
):
    ext = make_cognito_client(extension_ids=[EXT_ID])
    csrf = admin.get("/api/auth/me").json()["csrf_token"]
    token = _connect_extension(admin, ext, csrf)
    bearer = {"Authorization": f"Bearer {token}"}
    for url in (SUMMARY, JOBS, job_url(uuid.uuid4())):
        assert ext.get(url, headers=bearer).status_code == 401
        # Any Authorization header refuses the request, whatever cookie comes with it.
        assert admin.get(url, headers=bearer).status_code == 401
        assert admin.get(url, headers={"Authorization": "Basic abc"}).status_code == 401
    assert admin.get(SUMMARY).status_code == 200


def test_it_does_not_exist_in_access_code_mode(make_client):
    client = make_client()
    assert client.get(SUMMARY).status_code == 404


def test_a_refused_request_runs_no_report_query_and_validates_nothing(
    web, make_cognito_client, db_engine
):
    anonymous = make_cognito_client()
    sign_in(web, EMAIL, PASSWORD)
    bad = {"since": "nonsense", "language": "klingon", "job_id": "x", "limit": "0"}
    for client, expected in ((anonymous, 401), (web, 403)):
        for url in (SUMMARY, JOBS):
            with statements_during(app_engine(client)) as statements:
                # Auth comes first: a refused caller learns nothing about the parameters.
                assert client.get(url, params=bad).status_code == expected
            assert report_statements(statements) == []


# -- what it never returns ------------------------------------------------------------------------


SERVICE_KEYS = {
    "service", "requests", "mock_requests", "actual_requests", "actual_characters",
    "estimated_requests", "estimated_characters", "unknown_requests", "unknown_sent_characters",
    "none_requests", "outcomes", "unpriced_characters", "reference_cost",
}  # fmt: skip
ROW_KEYS = {
    "job_id", "started_at", "finished_at", "language", "voice", "speed_percent", "timing_mode",
    "status", "outcome", "error_code", "providers", "complete", "reasons", "services",
    "reference_cost", "baseline_seconds", "target_audio_seconds", "final_audio_seconds",
    "audio_processing_ms", "mp3_bytes",
}  # fmt: skip
ATTEMPT_KEYS = {
    "seq", "service", "provider_kind", "outcome", "http_status", "error_code", "started_at",
    "elapsed_ms", "usage_amount", "usage_unit", "usage_basis", "usage_method", "reference_cost",
    "no_cost_reason",
}  # fmt: skip


def test_responses_are_exactly_the_allowed_fields(admin, db_engine):
    job_id = add_job(db_engine)
    summary = get_ok(admin, SUMMARY, **PERIOD)
    assert set(summary) == {
        "generated_at", "filters", "first_usage_at", "jobs_total", "statuses", "complete",
        "incomplete", "reasons", "jobs_with_mock", "jobs_without_usage", "services",
        "reference_cost",
    }  # fmt: skip
    assert set(summary["services"][0]) == SERVICE_KEYS
    assert set(summary["reference_cost"]) == {
        "currency", "known_total", "partial", "partial_reasons", "lines",
    }  # fmt: skip
    assert set(summary["reference_cost"]["lines"][0]) == {
        "service", "sku", "meter", "region", "unit", "price", "currency", "effective_from",
        "checked_on", "source", "characters", "amount",
    }  # fmt: skip

    listing = get_ok(admin, JOBS, **PERIOD)
    assert set(listing) == {"generated_at", "filters", "jobs", "next_cursor"}
    assert set(listing["jobs"][0]) == ROW_KEYS

    detail = get_ok(admin, job_url(job_id))
    assert set(detail) == {
        "generated_at", "job", "method_version", "attempts_total", "attempts", "next_cursor",
    }  # fmt: skip
    assert set(detail["attempts"][0]) == ATTEMPT_KEYS


def test_nothing_sensitive_of_a_real_job_is_returned_and_its_content_stays_closed(
    admin, make_cognito_client, db_engine
):
    other = make_cognito_client()
    transcript = "A very private lecture about Spring Boot and JSON."
    csrf = sign_in(other, OTHER_EMAIL, PASSWORD)["csrf_token"]
    job_id = create_job(other, csrf, transcript=transcript).json()["id"]
    wait_for_terminal(other, job_id)
    since = datetime.now(UTC) - timedelta(hours=1)
    period = {"since": since.isoformat(), "until": (since + timedelta(hours=2)).isoformat()}

    with db_engine.connect() as conn:
        user_id, session_id = conn.execute(
            text("SELECT user_id::text, id::text FROM user_sessions LIMIT 1")
        ).one()
    bodies = (
        admin.get(SUMMARY, params=period).text
        + admin.get(JOBS, params=period).text
        + admin.get(job_url(job_id)).text
    )
    assert job_id in bodies
    for secret in (
        transcript,
        "Spring Boot",
        OTHER_EMAIL,
        EMAIL,
        user_id,
        session_id,
        admin.cookies[AUTH_COOKIE],
        "csrf",
        "speak",  # SSML
        "127.0.0.1",
        "password",
    ):
        assert secret not in bodies

    # The id gives the usage figures only: the job's own endpoints stay closed to the admin.
    assert admin.get(f"/api/jobs/{job_id}").status_code == 404
    assert admin.get(f"/api/jobs/{job_id}/result").status_code == 404
    assert admin.get(f"/api/jobs/{job_id}/result/audio").status_code == 404


def test_an_error_code_that_is_not_a_plain_label_is_not_shown(admin, db_engine):
    job_id = add_rows(
        db_engine,
        uuid.uuid4(),
        T,
        attempt_values(1, "translator", None, T, error_code="bad key sk-1: see https://x"),
        attempt_values(2, "speech", None, T, error_code="ConnectTimeout"),
        error_code="translation_timeout",
    )
    detail = get_ok(admin, job_url(job_id))
    assert [a["error_code"] for a in detail["attempts"]] == ["other", "ConnectTimeout"]
    assert detail["job"]["error_code"] == "translation_timeout"


def test_error_responses_are_not_cached_either(admin, web, make_cognito_client, monkeypatch):
    anonymous = make_cognito_client()
    responses = [
        anonymous.get(SUMMARY),  # 401
        admin.get(SUMMARY, params={"since": "nonsense"}),  # 422
        admin.get(JOBS, params={"limit": 0}),  # 422
        admin.get(job_url(uuid.uuid4())),  # 404
        admin.get(job_url("not-a-uuid")),  # 422
    ]
    assert [r.status_code for r in responses] == [401, 422, 422, 404, 422]
    for response in responses:
        assert response.headers["cache-control"] == "no-store"
        assert "error" in response.json()


# -- filters --------------------------------------------------------------------------------------


def listed(client: TestClient, **params) -> list[str]:
    return [j["job_id"] for j in get_ok(client, JOBS, **params)["jobs"]]


def test_the_period_is_half_open_on_started_at_in_utc(admin, db_engine):
    inside = add_job(db_engine, T)
    at_until = add_job(db_engine, T + timedelta(days=1))
    before = add_job(db_engine, T - timedelta(microseconds=1))
    period = {"since": T.isoformat(), "until": (T + timedelta(days=1)).isoformat()}
    assert listed(admin, **period) == [str(inside)]
    assert get_ok(admin, SUMMARY, **period)["jobs_total"] == 1
    assert str(at_until) in listed(
        admin, since=(T + timedelta(days=1)).isoformat(), until="2026-10-12"
    )
    assert str(before) in listed(admin, since="2026-10-09", until=T.isoformat())


def test_no_zone_means_utc_and_an_offset_is_converted(admin, db_engine):
    job_id = add_job(db_engine, T)  # 12:00 UTC
    # 19:00 at +07:00 is 12:00 UTC: inclusive as `since`, exclusive as `until`.
    assert listed(admin, since="2026-10-10T19:00:00+07:00", until="2026-10-11") == [str(job_id)]
    assert listed(admin, since="2026-10-10", until="2026-10-10T19:00:00+07:00") == []
    body = get_ok(admin, JOBS, since="2026-10-10T12:00", until="2026-10-10T12:00:01")
    assert [j["job_id"] for j in body["jobs"]] == [str(job_id)]
    assert body["filters"]["since"] == "2026-10-10T12:00:00Z"
    assert body["filters"]["until"] == "2026-10-10T12:00:01Z"


def test_the_default_is_the_last_seven_days(admin, db_engine):
    now = datetime.now(UTC)
    recent = add_job(db_engine, now - timedelta(days=6, hours=23))
    add_job(db_engine, now - timedelta(days=7, minutes=5))
    body = get_ok(admin, JOBS)
    assert [j["job_id"] for j in body["jobs"]] == [str(recent)]
    since = datetime.fromisoformat(body["filters"]["since"])
    until = datetime.fromisoformat(body["filters"]["until"])
    assert until - since == timedelta(days=7)
    # One side given: the other is filled in, and what was used is reported.
    only_until = get_ok(admin, SUMMARY, until="2026-10-08")["filters"]
    assert only_until["since"] == "2026-10-01T00:00:00Z"


@pytest.mark.parametrize("url", [SUMMARY, JOBS])
def test_the_period_limit_is_refused_not_clamped(url, admin):
    assert admin.get(url, params={"since": "2026-10-01", "until": "2026-11-01"}).status_code == 200
    field, message = field_error(
        admin.get(url, params={"since": "2026-10-01", "until": "2026-11-01T00:00:01"})
    )
    assert field == "until" and "31 days" in message
    # Only `since`: from then until now, under the same limit.
    assert field_error(admin.get(url, params={"since": "2020-01-01"}))[0] == "until"


@pytest.mark.parametrize(
    ("params", "field"),
    [
        ({"since": "yesterday"}, "since"),
        ({"until": "2026-13-45"}, "until"),
        ({"since": ""}, "since"),
        ({"since": "0001-01-01T00:00:00+14:00"}, "since"),  # would overflow the conversion to UTC
        ({"since": "x" * 65}, "since"),
        ({"since": "2026-10-02", "until": "2026-10-01"}, "since"),
        ({"since": "2026-10-01", "until": "2026-10-01"}, "since"),
        ({"language": "klingon"}, "language"),
        ({"language": ""}, "language"),
        ({"job_id": "not-a-uuid"}, "job_id"),
        ({"limit": 0}, "limit"),
        ({"limit": 101}, "limit"),
        ({"limit": "many"}, "limit"),
        ({"cursor": "x" * 513}, "cursor"),
    ],
)
def test_invalid_filters_are_refused(params, field, admin):
    url = JOBS if {"limit", "cursor"} & set(params) else SUMMARY
    assert field_error(admin.get(url, params=params))[0] == field


def test_language_and_job_id_filters(admin, db_engine):
    vi = add_job(db_engine, T)
    ja = add_job(db_engine, T + timedelta(minutes=1), target_language="japanese")
    assert listed(admin, **PERIOD, language="japanese") == [str(ja)]
    assert listed(admin, **PERIOD, job_id=str(vi)) == [str(vi)]
    assert listed(admin, **PERIOD, job_id=str(vi), language="japanese") == []
    body = get_ok(admin, SUMMARY, **PERIOD, job_id=str(ja))
    assert body["jobs_total"] == 1 and body["filters"]["job_id"] == str(ja)
    # A job id is matched inside the period; its detail is not tied to any period.
    assert listed(admin, since="2026-09-01", until="2026-09-02", job_id=str(vi)) == []
    assert get_ok(admin, job_url(vi))["job"]["job_id"] == str(vi)


# -- pages ----------------------------------------------------------------------------------------


def all_pages(client: TestClient, url: str, key: str, **params) -> list[list[dict]]:
    pages, cursor = [], None
    while True:
        body = get_ok(client, url, **params, **({"cursor": cursor} if cursor else {}))
        pages.append(body[key])
        cursor = body["next_cursor"]
        if cursor is None:
            return pages


def test_job_pages_are_ordered_and_lose_or_repeat_nothing(admin, db_engine):
    # Several jobs in the same microsecond: the id decides, in both directions of the cursor.
    ids = [add_job(db_engine, T) for _ in range(5)]
    ids += [add_job(db_engine, T + timedelta(minutes=n)) for n in range(1, 6)]
    pages = all_pages(admin, JOBS, "jobs", **PERIOD, limit=3)
    assert [len(p) for p in pages] == [3, 3, 3, 1]
    rows = [(j["started_at"], j["job_id"]) for p in pages for j in p]
    assert len({r[1] for r in rows}) == 10 and {r[1] for r in rows} == {str(i) for i in ids}
    expected_ties = sorted((str(i) for i in ids[:5]), reverse=True)
    assert [r[1] for r in rows[5:]] == expected_ties
    assert [r[0] for r in rows] == sorted((r[0] for r in rows), reverse=True)


def test_a_page_that_ends_exactly_on_the_last_job_has_no_next_page(admin, db_engine):
    for n in range(4):
        add_job(db_engine, T + timedelta(minutes=n))
    assert [len(p) for p in all_pages(admin, JOBS, "jobs", **PERIOD, limit=2)] == [2, 2]
    assert get_ok(admin, JOBS, **PERIOD, limit=4)["next_cursor"] is None


def test_the_default_and_largest_page_sizes(admin, db_engine):
    for n in range(101):
        add_job(db_engine, T + timedelta(seconds=n), translator=None, speech=None)
    assert len(get_ok(admin, JOBS, **PERIOD)["jobs"]) == 25
    assert len(get_ok(admin, JOBS, **PERIOD, limit=100)["jobs"]) == 100


def test_a_new_job_does_not_shift_the_pages(admin, db_engine):
    ids = [add_job(db_engine, T + timedelta(minutes=n)) for n in range(4)]
    first = get_ok(admin, JOBS, **PERIOD, limit=2)
    add_job(db_engine, T + timedelta(minutes=10))
    second = get_ok(admin, JOBS, **PERIOD, limit=2, cursor=first["next_cursor"])
    assert [j["job_id"] for j in first["jobs"]] == [str(ids[3]), str(ids[2])]
    assert [j["job_id"] for j in second["jobs"]] == [str(ids[1]), str(ids[0])]


def test_a_cursor_works_only_with_its_filters(admin, db_engine):
    add_job(db_engine, T)
    add_job(db_engine, T + timedelta(minutes=1))
    cursor = get_ok(admin, JOBS, **PERIOD, limit=1)["next_cursor"]
    assert get_ok(admin, JOBS, **PERIOD, cursor=cursor)["jobs"]
    # A different page size is fine; different filters are not.
    assert get_ok(admin, JOBS, **PERIOD, limit=5, cursor=cursor)["jobs"]
    for other in (
        {"since": "2026-10-10T00:00:01Z", "until": PERIOD["until"]},
        {**PERIOD, "language": "japanese"},
        {**PERIOD, "job_id": str(uuid.uuid4())},
    ):
        field, message = field_error(admin.get(JOBS, params={**other, "cursor": cursor}))
        assert field == "cursor" and "other filters" in message
    # Without an explicit period, "now" moves: the cursor of a default period is refused too.
    default_cursor = None
    add_job(db_engine, datetime.now(UTC) - timedelta(hours=1))
    add_job(db_engine, datetime.now(UTC) - timedelta(hours=2))
    default_cursor = get_ok(admin, JOBS, limit=1)["next_cursor"]
    assert field_error(admin.get(JOBS, params={"cursor": default_cursor}))[0] == "cursor"


@pytest.mark.parametrize(
    "cursor",
    [
        "!!!",
        "e30",  # {}
        "W10",  # []
        "bm90IGpzb24",  # "not json"
        "eyJzIjoxLCJqIjoyLCJmIjozfQ",  # wrong types
        "eyJzIjoibm9wZSIsImoiOiJub3BlIiwiZiI6Im5vcGUifQ",  # not a time or an id
    ],
)
def test_a_broken_cursor_is_refused(cursor, admin):
    field, message = field_error(admin.get(JOBS, params={**PERIOD, "cursor": cursor}))
    assert field == "cursor" and "not valid" in message


def test_attempt_pages_lose_or_repeat_nothing_and_the_job_figures_cover_them_all(admin, db_engine):
    attempts = [attempt_values(1, "translator", 1000, T)]
    attempts += [attempt_values(n, "speech", 100, T) for n in range(2, 8)]
    job_id = add_rows(db_engine, uuid.uuid4(), T, *attempts, attempts_expected=7)
    url = job_url(job_id)
    pages = all_pages(admin, url, "attempts", limit=3)
    assert [[a["seq"] for a in page] for page in pages] == [[1, 2, 3], [4, 5, 6], [7]]

    # The same figures on every page: never computed from the attempts shown.
    first = get_ok(admin, url, limit=3)
    last = get_ok(admin, url, limit=3, cursor=get_ok(admin, url, limit=6)["next_cursor"])
    assert first["job"] == last["job"]
    assert first["attempts_total"] == last["attempts_total"] == 7
    speech = first["job"]["services"][1]
    assert speech["estimated_characters"] == 600 and first["job"]["complete"] is True
    assert get_ok(admin, url)["attempts_total"] == 7


def test_attempt_cursor_belongs_to_its_job(admin, db_engine):
    attempts = [attempt_values(n, "speech", 100, T) for n in range(1, 4)]
    one = add_rows(db_engine, uuid.uuid4(), T, *attempts)
    two = add_rows(db_engine, uuid.uuid4(), T, *attempts)
    cursor = get_ok(admin, job_url(one), limit=1)["next_cursor"]
    field, message = field_error(admin.get(job_url(two), params={"cursor": cursor}))
    assert field == "cursor" and "other filters" in message
    for bad in ("e30", "eyJqIjoiYSIsInEiOnRydWV9", "!!!"):
        assert field_error(admin.get(job_url(one), params={"cursor": bad}))[0] == "cursor"
    # A jobs-list cursor is not an attempts cursor, and the other way round.
    add_job(db_engine, T)
    list_cursor = get_ok(admin, JOBS, **PERIOD, limit=1)["next_cursor"]
    assert field_error(admin.get(job_url(one), params={"cursor": list_cursor}))[0] == "cursor"
    assert field_error(admin.get(JOBS, params={**PERIOD, "cursor": cursor}))[0] == "cursor"
    assert field_error(admin.get(job_url(one), params={"limit": 101}))[0] == "limit"


# -- the figures are the report's -----------------------------------------------------------------


def every_case(engine: Engine) -> dict[str, uuid.UUID]:
    """One job per case the report has to tell apart."""
    jobs = {"plain": add_job(engine, T, translator=333_333, speech=5)}
    jobs["speech_timeout"] = add_job(engine, T + timedelta(minutes=1), translator=500, speech=None)
    jobs["failed"] = add_rows(
        engine,
        uuid.uuid4(),
        T + timedelta(minutes=2),
        attempt_values(1, "translator", None, T, http_status=429, outcome="http_error"),
        outcome="failed",
        error_code="translation_failed",
        final_audio_seconds=None,
        attempts_expected=1,
    )
    jobs["cancelled"] = add_rows(
        engine,
        uuid.uuid4(),
        T + timedelta(minutes=3),
        attempt_values(1, "translator", 700, T),
        attempt_values(2, "speech", 0, T, usage_basis="none", outcome="cancelled"),
        attempts_expected=2,
    )
    jobs["mock"] = add_rows(
        engine,
        uuid.uuid4(),
        T + timedelta(minutes=4),
        mock_attempt(1, "translator"),
        mock_attempt(2, "speech"),
        translation_provider="mock-translation",
        speech_provider="mock-speech",
    )
    jobs["mixed"] = add_rows(
        engine,
        uuid.uuid4(),
        T + timedelta(minutes=5),
        attempt_values(1, "translator", 1000, T),
        mock_attempt(2, "speech"),
        speech_provider="mock-speech",
    )
    jobs["crashed"] = add_rows(
        engine,
        uuid.uuid4(),
        T + timedelta(minutes=6),
        attempt_values(1, "translator", 1000, T),
        finished_at=None,
        outcome=None,
        attempts_expected=None,
        final_audio_seconds=None,
    )
    jobs["lost_rows"] = add_rows(
        engine,
        uuid.uuid4(),
        T + timedelta(minutes=7),
        attempt_values(1, "translator", 100, T),
        attempt_values(3, "speech", 200, T),
        attempts_expected=3,
        write_errors=1,
    )
    jobs["no_attempts"] = add_rows(
        engine, uuid.uuid4(), T + timedelta(minutes=8), attempts_expected=0
    )
    jobs["unpriced"] = add_rows(
        engine,
        uuid.uuid4(),
        T + timedelta(minutes=9),
        # Before the first translator price (2025-05-01): known usage with no reference price.
        attempt_values(1, "translator", 4000, datetime(2025, 4, 30, tzinfo=UTC)),
        attempt_values(2, "speech", 1000, T),
    )
    return jobs


def service(summary: dict, name: str) -> dict:
    return next(s for s in summary["services"] if s["service"] == name)


def test_the_api_and_the_command_line_report_say_the_same(admin, db_engine):
    every_case(db_engine)
    filters = Filters(
        since=datetime(2026, 10, 10, tzinfo=UTC), until=datetime(2026, 10, 11, tzinfo=UTC)
    )
    with sessionmaker(bind=db_engine)() as db:
        report = build_report(db, filters)
    totals = report.totals()
    prices = report.prices
    summary = get_ok(admin, SUMMARY, **PERIOD)

    assert summary["jobs_total"] == len(report.jobs) == 10
    assert summary["complete"] == sum(j.complete for j in report.jobs)
    assert summary["incomplete"] == sum(not j.complete for j in report.jobs)
    reasons = {r for j in report.jobs for r in j.reasons}
    assert set(summary["reasons"]) == reasons
    for reason in reasons:
        assert summary["reasons"][reason] == sum(reason in j.reasons for j in report.jobs)
    statuses = {j.status for j in report.jobs}
    assert set(summary["statuses"]) == statuses
    assert summary["jobs_without_usage"] == report.jobs_without_usage
    assert summary["first_usage_at"].rstrip("Z") == (
        report.first_usage_at.astimezone(UTC).isoformat().replace("+00:00", "")
    )
    assert summary["jobs_with_mock"] == sum(j.providers in ("mock", "mixed") for j in report.jobs)
    known_total = Decimal(0)
    for name in ("translator", "speech"):
        got = service(summary, name)
        assert got["requests"] == totals.requests[name]
        assert got["mock_requests"] == totals.mock_requests[name]
        assert got["actual_characters"] == totals.characters(name, "actual")
        assert got["estimated_characters"] == totals.characters(name, "estimated")
        assert got["unknown_requests"] == totals.unknown_requests[name]
        assert got["unknown_sent_characters"] == totals.unknown_sent[name]
        assert got["unpriced_characters"] == totals.unpriced(name)
        assert Decimal(got["reference_cost"]) == totals.cost(name, prices)
        known_total += totals.cost(name, prices)
        assert {(o): n for (s, o), n in totals.outcomes.items() if s == name} == got["outcomes"]
    assert Decimal(summary["reference_cost"]["known_total"]) == known_total

    # Row by row, with the CSV the command writes.
    out = io.StringIO()
    write_job_csv(report, out)
    csv_rows = {row["job_id"]: row for row in csv.DictReader(io.StringIO(out.getvalue()))}
    api_rows = {
        j["job_id"]: j for p in all_pages(admin, JOBS, "jobs", **PERIOD, limit=4) for j in p
    }
    assert set(api_rows) == set(csv_rows)
    for job_id, row in csv_rows.items():
        got = api_rows[job_id]
        translator, speech = got["services"]
        assert got["status"] == row["status"]
        assert got["outcome"] == (row["outcome"] or None)
        assert got["error_code"] == (row["error_code"] or None)
        assert got["language"] == row["language"]
        assert got["voice"] == row["voice"]
        assert got["timing_mode"] == row["timing_mode"]
        assert got["providers"] == row["providers"]
        assert got["complete"] == (row["complete"] == "yes")
        assert ";".join(got["reasons"]) == row["reasons"]
        assert translator["requests"] == int(row["translator_requests"])
        assert translator["actual_characters"] == int(row["translator_chars_actual"])
        assert translator["unknown_requests"] == int(row["translator_unknown_requests"])
        assert speech["requests"] == int(row["speech_requests"])
        assert speech["estimated_characters"] == int(row["speech_chars_estimated"])
        assert speech["unknown_requests"] == int(row["speech_unknown_requests"])
        # The same exact digits.
        assert translator["reference_cost"] == row["ref_cost_translator"]
        assert speech["reference_cost"] == row["ref_cost_speech"]
        assert got["reference_cost"]["known_total"] == row["ref_cost_known"]


def test_each_case_keeps_its_own_label(admin, db_engine):
    jobs = every_case(db_engine)
    rows = {j["job_id"]: j for p in all_pages(admin, JOBS, "jobs", **PERIOD, limit=100) for j in p}

    def row(name: str) -> dict:
        return rows[str(jobs[name])]

    assert row("plain")["complete"] is True and row("plain")["reference_cost"]["partial"] is False
    # Exact, not rounded and not a float.
    assert row("plain")["services"][0]["reference_cost"] == "3.33333"
    assert row("plain")["services"][1]["reference_cost"] == "0.000075"
    assert row("plain")["reference_cost"]["known_total"] == "3.333405"
    assert row("plain")["providers"] == "real"

    # An unknown request is never 0, and the cost says it is a lower bound.
    timed_out = row("speech_timeout")
    assert timed_out["reasons"] == ["usage_unknown"]
    assert timed_out["services"][1]["unknown_requests"] == 1
    assert timed_out["services"][1]["estimated_characters"] == 0
    assert timed_out["reference_cost"]["partial"] is True
    assert "unknown_usage" in timed_out["reference_cost"]["partial_reasons"]

    failed = row("failed")
    assert failed["status"] == "failed" and failed["error_code"] == "translation_failed"
    assert failed["services"][0]["unknown_requests"] == 1
    assert failed["final_audio_seconds"] is None

    # `none` is not `unknown`, and not missing either.
    cancelled = row("cancelled")
    assert cancelled["services"][1]["none_requests"] == 1
    assert cancelled["services"][1]["unknown_requests"] == 0
    assert cancelled["complete"] is True

    mock = row("mock")
    assert mock["providers"] == "mock" and mock["complete"] is True
    assert mock["services"][0]["mock_requests"] == 1 and mock["services"][0]["requests"] == 0
    assert mock["reference_cost"]["known_total"] == "0" and mock["reference_cost"]["lines"] == []

    # A mixed job keeps the usage of its real provider.
    mixed = row("mixed")
    assert mixed["providers"] == "mixed"
    assert mixed["services"][0]["actual_characters"] == 1000
    assert mixed["services"][1]["mock_requests"] == 1
    assert mixed["reference_cost"]["known_total"] == "0.01"

    assert row("crashed")["reasons"] == ["no_ending_recorded"]
    assert row("crashed")["status"] == "unknown" and row("crashed")["finished_at"] is None
    assert row("crashed")["reference_cost"]["partial_reasons"] == ["incomplete_jobs"]
    assert row("lost_rows")["reasons"] == ["attempts_missing", "write_errors"]
    assert row("no_attempts")["reasons"] == ["no_translator_attempt", "no_speech_attempt"]

    # Known usage with no price for its date is not priced at the nearest one, and it shows.
    unpriced = row("unpriced")
    assert unpriced["services"][0]["unpriced_characters"] == 4000
    assert unpriced["services"][0]["reference_cost"] == "0"
    assert unpriced["reference_cost"]["partial_reasons"] == ["unpriced_usage"]

    # What is not known stays null, never 0.
    assert row("plain")["audio_processing_ms"] is None and row("plain")["mp3_bytes"] is None
    assert row("plain")["target_audio_seconds"] == "60.000"


def test_attempts_say_why_they_have_no_reference_cost(admin, db_engine):
    jobs = every_case(db_engine)

    def attempts(name: str) -> list[dict]:
        return get_ok(admin, job_url(jobs[name]))["attempts"]

    plain = attempts("plain")
    assert plain[0]["usage_basis"] == "actual" and plain[0]["reference_cost"] == "3.33333"
    assert plain[0]["no_cost_reason"] is None and plain[0]["usage_method"] == "m"
    assert attempts("failed")[0]["no_cost_reason"] == "unknown_usage"
    assert attempts("failed")[0]["usage_amount"] is None
    assert attempts("failed")[0]["http_status"] == 429
    assert attempts("cancelled")[1]["no_cost_reason"] == "none"
    assert attempts("mock")[0]["no_cost_reason"] == "mock"
    assert attempts("unpriced")[0]["no_cost_reason"] == "no_reference_price"
    assert attempts("unpriced")[0]["reference_cost"] is None


def test_summary_marks_everything_that_keeps_the_cost_from_being_a_total(admin, db_engine):
    every_case(db_engine)
    summary = get_ok(admin, SUMMARY, **PERIOD)
    cost = summary["reference_cost"]
    assert cost["partial"] is True
    assert set(cost["partial_reasons"]) == {"unknown_usage", "unpriced_usage", "incomplete_jobs"}
    assert service(summary, "translator")["unpriced_characters"] == 4000
    assert summary["jobs_with_mock"] == 2
    # Characters of the two services are never added together.
    assert "total_characters" not in json.dumps(summary)


def test_a_clean_period_is_not_marked_partial(admin, db_engine):
    add_job(db_engine, T)
    cost = get_ok(admin, SUMMARY, **PERIOD)["reference_cost"]
    assert cost["partial"] is False and cost["partial_reasons"] == []
    assert [line["service"] for line in cost["lines"]] == ["translator", "speech"]
    translator = cost["lines"][0]
    assert translator["currency"] == "USD" and translator["sku"] == "S1"
    assert translator["region"] == "westus2" and translator["price"] == "10.00"
    assert translator["effective_from"] == "2025-05-01" and translator["checked_on"]
    assert translator["source"].startswith("https://")


def test_several_prices_in_a_period_are_separate_lines(admin, db_engine, tmp_path, monkeypatch):
    path = tmp_path / "prices.json"
    entry = {
        "service": "translator",
        "sku": "S1",
        "meter": "m",
        "region": "r",
        "unit": "1M characters",
        "checked_on": "2026-10-01",
        "source": "https://example.test/prices",
    }
    speech = {**entry, "service": "speech", "price": "15.00", "effective_from": "2024-01-01"}
    path.write_text(
        json.dumps(
            {
                "schema": 1,
                "currency": "USD",
                "prices": [
                    {**entry, "price": "10.00", "effective_from": "2024-01-01"},
                    {**entry, "price": "20.00", "effective_from": "2026-10-11"},
                    speech,
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(admin_usage, "default_price_book", lambda: load_price_book(path))
    add_rows(
        db_engine,
        uuid.uuid4(),
        T,
        attempt_values(1, "translator", 1000, T),  # the old price, on the attempt's own date
        attempts_expected=1,
    )
    later = datetime(2026, 10, 11, 1, tzinfo=UTC)
    add_rows(
        db_engine,
        uuid.uuid4(),
        later,
        attempt_values(1, "translator", 1000, later),  # the new price
        attempts_expected=1,
    )
    cost = get_ok(admin, SUMMARY, since="2026-10-10", until="2026-10-12")["reference_cost"]
    lines = [(x["price"], x["effective_from"], x["characters"], x["amount"]) for x in cost["lines"]]
    assert lines == [
        ("10.00", "2024-01-01", 1000, "0.01"),
        ("20.00", "2026-10-11", 1000, "0.02"),
    ]
    assert cost["known_total"] == "0.03"


def test_a_summary_is_the_whole_period_in_any_batch_size(admin, db_engine, monkeypatch):
    for n in range(12):
        add_job(db_engine, T + timedelta(seconds=n // 2), translator=1000, speech=2000)
    whole = get_ok(admin, SUMMARY, **PERIOD)
    # A size that divides the number of jobs exactly, one that does not, and one job at a time.
    for size in (12, 6, 5, 1):
        monkeypatch.setattr(queries, "SUMMARY_BATCH_JOBS", size)
        assert {**get_ok(admin, SUMMARY, **PERIOD), "generated_at": ""} == {
            **whole,
            "generated_at": "",
        }
    assert whole["jobs_total"] == 12
    assert service(whole, "translator")["actual_characters"] == 12_000
    assert service(whole, "speech")["estimated_characters"] == 24_000
    # Bigger than a page of jobs.
    assert len(get_ok(admin, JOBS, **PERIOD, limit=5)["jobs"]) == 5


def test_jobs_without_a_usage_record_and_the_empty_cases(admin, db_engine):
    empty = get_ok(admin, SUMMARY, **PERIOD)
    assert empty["jobs_total"] == 0 and empty["first_usage_at"] is None
    assert service(empty, "translator")["requests"] == 0
    assert empty["reference_cost"]["known_total"] == "0"
    assert get_ok(admin, JOBS, **PERIOD)["jobs"] == []

    services = admin.app.state.services  # type: ignore[attr-defined]
    old = new_job(services)  # a job row without a usage row, like one from before recording
    now = datetime.now(UTC)
    around = {
        "since": (now - timedelta(hours=1)).isoformat(),
        "until": (now + timedelta(hours=1)).isoformat(),
    }
    summary = get_ok(admin, SUMMARY, **around)
    assert summary["jobs_without_usage"] == 1 and summary["jobs_total"] == 0
    assert "jobs_without_usage" in summary["reference_cost"]["partial_reasons"]

    # It has no record to open: the same answer as an id nobody knows.
    for job_id in (old.job_id, uuid.uuid4()):
        missing = admin.get(job_url(job_id))
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "job_usage_not_found"

    # The oldest record in the database is reported whatever the filters are.
    add_job(db_engine, T)
    elsewhere = get_ok(admin, SUMMARY, since="2026-10-20", until="2026-10-21")
    assert elsewhere["jobs_total"] == 0
    assert elsewhere["first_usage_at"] == "2026-10-10T12:00:00Z"


def test_usage_is_read_after_the_job_row_is_gone(admin, db_engine):
    job_id = add_job(db_engine, T, outcome="failed", error_code="speech_timeout")
    detail = get_ok(admin, job_url(job_id))
    # No job row in this data set: the status is the recorded outcome.
    assert detail["job"]["status"] == "failed" and detail["job"]["error_code"] == "speech_timeout"
    assert detail["attempts_total"] == 2


# -- one snapshot, its limits and its end ---------------------------------------------------------


def _commit_when(engine: Engine, marker: str, write) -> callable:
    fired = []

    def before(conn, cursor, statement, parameters, context, executemany):
        if marker in statement and not fired:
            fired.append(True)
            write()

    event.listen(engine, "before_cursor_execute", before)
    return lambda: event.remove(engine, "before_cursor_execute", before)


@pytest.mark.parametrize("url", [SUMMARY, JOBS])
def test_usage_written_meanwhile_is_in_no_query_of_the_response(url, admin, db_engine):
    """A commit between the response's queries: its job and attempt appear in neither."""
    existing = add_job(db_engine, T)
    new_id = uuid.uuid4()

    def write() -> None:
        with session_scope(sessionmaker(bind=db_engine)) as db:
            store.upsert_summary(db, new_id, summary_values(T + timedelta(hours=1)))
            store.insert_attempts(
                db,
                [
                    {"job_id": new_id, **attempt_values(1, "translator", 77, T)},
                    {"job_id": existing, **attempt_values(3, "speech", 55, T)},
                ],
            )

    stop = _commit_when(app_engine(admin), "FROM job_usage_attempts", write)
    try:
        body = get_ok(admin, url, **PERIOD)
    finally:
        stop()
    if url == SUMMARY:
        assert body["jobs_total"] == 1
        assert service(body, "speech")["estimated_characters"] == 2000
    else:
        assert [j["job_id"] for j in body["jobs"]] == [str(existing)]
        assert body["jobs"][0]["services"][1]["estimated_characters"] == 2000
    # The next response sees what was committed; its own time is reported.
    assert get_ok(admin, SUMMARY, **PERIOD)["jobs_total"] == 2
    assert body["generated_at"].endswith("Z")


def test_the_job_detail_is_one_snapshot_too(admin, db_engine):
    job_id = add_job(db_engine, T)

    def write() -> None:
        with session_scope(sessionmaker(bind=db_engine)) as db:
            store.insert_attempts(db, [{"job_id": job_id, **attempt_values(3, "speech", 55, T)}])

    stop = _commit_when(app_engine(admin), "FROM job_usage_attempts", write)
    try:
        detail = get_ok(admin, job_url(job_id))
    finally:
        stop()
    assert detail["attempts_total"] == len(detail["attempts"]) == 2
    assert get_ok(admin, job_url(job_id))["attempts_total"] == 3


@pytest.mark.parametrize("url", [SUMMARY, JOBS, "detail"])
def test_reports_run_read_only_with_local_timeouts_that_do_not_leak(url, admin, db_engine):
    """Through the real route: after the auth queries, on a session that has not queried."""
    job_id = add_job(db_engine, T)
    engine = app_engine(admin)
    seen = {}

    def before(conn, cursor, statement, parameters, context, executemany):
        if "FROM job_usage_attempts" in statement:
            for setting in (
                "transaction_isolation",
                "transaction_read_only",
                "statement_timeout",
                "lock_timeout",
            ):
                cursor.execute(f"SHOW {setting}")
                seen[setting] = cursor.fetchone()[0]

    event.listen(engine, "before_cursor_execute", before)
    try:
        get_ok(
            admin,
            job_url(job_id) if url == "detail" else url,
            **({} if url == "detail" else PERIOD),
        )
    finally:
        event.remove(engine, "before_cursor_execute", before)
    assert seen == {
        "transaction_isolation": "repeatable read",
        "transaction_read_only": "on",
        "statement_timeout": "10s",
        "lock_timeout": "10s",
    }
    # The pooled connections are back to the application's settings.
    for _ in range(3):
        with engine.connect() as conn:
            assert conn.execute(text("SHOW statement_timeout")).scalar_one() == "0"
            assert conn.execute(text("SHOW lock_timeout")).scalar_one() == "0"
            assert conn.execute(text("SHOW transaction_read_only")).scalar_one() == "off"
            assert conn.execute(text("SHOW transaction_isolation")).scalar_one() == "read committed"


def test_the_snapshot_refuses_writes_and_ends_cleanly(admin, db_engine):
    add_job(db_engine, T)
    services = admin.app.state.services  # type: ignore[attr-defined]
    with (
        queries.report_snapshot(services.session_factory) as db,
        pytest.raises((InternalError, ProgrammingError)),
    ):
        db.execute(text("DELETE FROM job_usage"))
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one() == 1
    # Reading changes nothing either.
    before = get_ok(admin, SUMMARY, **PERIOD)
    with db_engine.connect() as conn:
        roles = conn.execute(text("SELECT role FROM users")).scalars().all()
    assert roles == ["admin"]
    assert {**get_ok(admin, SUMMARY, **PERIOD), "generated_at": ""} == {
        **before,
        "generated_at": "",
    }
    # All connections are returned to the pool.
    assert services.engine.pool.checkedout() == 0


def test_a_blocked_query_is_an_error_not_an_empty_report(admin, db_engine, monkeypatch, caplog):
    add_job(db_engine, T)
    monkeypatch.setattr(queries, "STATEMENT_TIMEOUT_SECONDS", 0.2)
    with db_engine.connect() as conn:
        conn.execute(text("LOCK TABLE job_usage IN ACCESS EXCLUSIVE MODE"))
        with caplog.at_level(logging.WARNING):
            for url in (SUMMARY, JOBS):
                response = admin.get(url, params=PERIOD)
                assert response.status_code == 503, response.text
                assert response.json()["error"]["code"] == "usage_report_timeout"
                assert response.headers["cache-control"] == "no-store"
                assert "job_usage" not in response.text
        conn.rollback()
    assert "job_usage" not in caplog.text and "SELECT" not in caplog.text
    # Nothing lingers: the next request works, and its pool is free.
    assert get_ok(admin, SUMMARY, **PERIOD)["jobs_total"] == 1
    assert app_engine(admin).pool.checkedout() == 0


def test_a_summary_over_its_budget_is_an_error(admin, db_engine, monkeypatch):
    add_job(db_engine, T)
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", -1.0)
    response = admin.get(SUMMARY, params=PERIOD)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "usage_report_timeout"
    assert app_engine(admin).pool.checkedout() == 0


def test_a_database_failure_says_nothing_about_the_database(admin, monkeypatch, caplog):
    secret = "postgresql://someuser:s3cr3t-pw@db.internal/x"

    def fail(*_args, **_kwargs):
        raise OperationalError("SELECT secret_column", {"p": secret}, Exception(secret))

    monkeypatch.setattr(queries, "summarize_period", fail)
    with caplog.at_level(logging.INFO):
        response = admin.get(SUMMARY, params=PERIOD)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "usage_report_unavailable"
    assert secret not in response.text and "secret_column" not in response.text
    assert secret not in caplog.text and "secret_column" not in caplog.text
    assert "OperationalError" in caplog.text


# -- bounded reads --------------------------------------------------------------------------------


@pytest.fixture
def many_jobs(db_engine) -> list[uuid.UUID]:
    """500 jobs of 3 attempts each."""
    ids = [uuid.uuid4() for _ in range(500)]
    with session_scope(sessionmaker(bind=db_engine)) as db:
        for n, job_id in enumerate(ids):
            started = T + timedelta(seconds=n)
            store.upsert_summary(db, job_id, summary_values(started, attempts_expected=3))
        store.insert_attempts(
            db,
            [
                {"job_id": job_id, **attempt_values(seq, service_name, 100, T)}
                for job_id in ids
                for seq, service_name in ((1, "translator"), (2, "speech"), (3, "speech"))
            ],
        )
    return ids


def _loads_of(model):
    counter = {"n": 0}

    def on_load(target, context):
        counter["n"] += 1

    event.listen(model, "load", on_load)
    return counter, lambda: event.remove(model, "load", on_load)


def test_a_page_reads_a_page_whatever_the_period_holds(admin, many_jobs):
    engine = app_engine(admin)
    loaded, stop = _loads_of(JobUsage)
    try:
        with statements_during(engine) as statements:
            body = get_ok(admin, JOBS, **PERIOD, limit=25)
    finally:
        stop()
    assert len(body["jobs"]) == 25
    # One row more than the page to know if there is a next one, not the 500 of the period.
    assert loaded["n"] == 26
    reads = [s for s in statements if "job_usage" in s]
    assert len(reads) == 2  # the page and its attempts: no query per job
    assert "LIMIT" in reads[0]
    # Deeper pages cost the same (a position, not OFFSET).
    cursor = body["next_cursor"]
    with statements_during(engine) as statements:
        get_ok(admin, JOBS, **PERIOD, limit=25, cursor=cursor)
    assert len([s for s in statements if "job_usage" in s]) == 2
    assert not any("OFFSET" in s for s in statements)


def test_a_summary_holds_one_batch_at_a_time(admin, many_jobs, monkeypatch):
    monkeypatch.setattr(queries, "SUMMARY_BATCH_JOBS", 50)
    held = []
    original = queries._with_attempts

    def spying(db, rows):
        held.append(len(db.identity_map))
        return original(db, rows)

    monkeypatch.setattr(queries, "_with_attempts", spying)
    with statements_during(app_engine(admin)) as statements:
        summary = get_ok(admin, SUMMARY, **PERIOD)
    assert summary["jobs_total"] == 500
    assert service(summary, "speech")["estimated_characters"] == 500 * 200
    # On reaching each batch the session holds that batch's jobs and nothing of the previous one.
    assert len(held) == 10 and max(held) == 50
    reads = [s for s in statements if "job_usage" in s]
    # Two per batch (jobs, attempts), one more empty read to end, oldest record, jobs without usage.
    assert len(reads) <= 10 * 2 + 3
    assert not any(
        "job_usage" in s
        and "LIMIT" not in s
        and "attempts" not in s
        and "min(" not in s
        and "NOT (EXISTS" not in s
        for s in reads
    )


def test_a_job_detail_reads_one_job(admin, many_jobs):
    with statements_during(app_engine(admin)) as statements:
        detail = get_ok(admin, job_url(many_jobs[0]), limit=2)
    assert len(detail["attempts"]) == 2 and detail["attempts_total"] == 3
    assert len([s for s in statements if "job_usage" in s]) == 3


def test_the_page_makes_no_outside_call(admin, db_engine, monkeypatch, fake_cognito):
    """Opening the report does not touch the user pool or any provider."""
    add_job(db_engine, T)

    def refuse(*_args, **_kwargs):
        raise AssertionError("no outside call")

    for name in ("initiate_password_auth", "forgot_password", "confirm_forgot_password"):
        monkeypatch.setattr(fake_cognito, name, refuse)
    # Azure and Supadata are reached with httpx; the test client uses its own transport.
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)
    get_ok(admin, SUMMARY, **PERIOD)
    get_ok(admin, JOBS, **PERIOD)
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0
