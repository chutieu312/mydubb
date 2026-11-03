"""Usage & Costs under pressure: a report never waits for a connection while holding one, and a
summary keeps to its time budget, final queries included. Real routes, PostgreSQL and `pg_sleep`,
the application's pool of 5 + 5; only the pool's wait and the budget are shortened to keep tests
quick. docs/USAGE_COSTS.md, "Snapshot and limits"."""

import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.usage import queries
from tests.conftest import sign_in
from tests.test_admin_role import EMAIL, PASSWORD, _grant, _revoke
from tests.test_admin_usage import (
    JOBS,
    PERIOD,
    SUMMARY,
    app_engine,
    get_ok,
    job_url,
    service,
    statements_during,
)
from tests.test_usage_report import T, add_job


@pytest.fixture
def admin(make_cognito_client, fake_cognito, db_engine) -> TestClient:
    fake_cognito.add_user(EMAIL, PASSWORD, name="Lan")
    client = make_cognito_client()
    sign_in(client, EMAIL, PASSWORD)
    _grant(db_engine)
    return client


def wait_until_checked_in(engine: Engine) -> int:
    """Connections still out once the request has wound down (its session ends after the reply)."""
    deadline = time.monotonic() + 3
    while engine.pool.checkedout() and time.monotonic() < deadline:
        time.sleep(0.01)
    return engine.pool.checkedout()


def delay_reads(engine: Engine, seconds: float, marker: str = "FROM job"):
    """Each matching report read first waits on the server, in its own transaction: a real
    `pg_sleep` that the transaction's `statement_timeout` can cancel, as it can a slow query."""

    def before(conn, cursor, statement, parameters, context, executemany):
        if marker in statement:
            try:
                cursor.execute(f"SELECT pg_sleep({seconds})")
            except psycopg.errors.QueryCanceled as exc:
                raise OperationalError(statement, parameters, exc) from exc

    event.listen(engine, "before_cursor_execute", before)
    return lambda: event.remove(engine, "before_cursor_execute", before)


def timed_get(client: TestClient, url: str, **params):
    started = time.monotonic()
    response = client.get(url, params=params)
    return response, time.monotonic() - started


def hold_connections(engine: Engine) -> list:
    """Takes every connection the pool can still give."""
    pool = engine.pool
    free = pool.size() + pool._max_overflow - pool.checkedout()  # type: ignore[attr-defined]
    return [engine.connect() for _ in range(free)]


def assert_timed_out(response) -> None:
    assert response.status_code == 503, response.text
    assert response.json()["error"]["code"] == "usage_report_timeout"
    assert response.headers["cache-control"] == "no-store"


# -- the summary's deadline -----------------------------------------------------------------------


def test_the_budget_covers_the_final_queries(admin, db_engine, monkeypatch):
    """Four delays of 0.7 s against 2 s: the same shape as four of 8 s against 30 s."""
    add_job(db_engine, T)
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", 2.0)
    stop = delay_reads(app_engine(admin), 0.7)  # the batch, its attempts, the two final queries
    try:
        response, elapsed = timed_get(admin, SUMMARY, **PERIOD)
    finally:
        stop()
    assert_timed_out(response)
    assert elapsed < 2.7
    assert wait_until_checked_in(app_engine(admin)) == 0


def test_the_budget_covers_a_period_with_no_batch(admin, monkeypatch):
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", 1.0)
    stop = delay_reads(app_engine(admin), 0.5)  # the empty batch and the two final queries
    try:
        response, elapsed = timed_get(admin, SUMMARY, **PERIOD)
    finally:
        stop()
    assert_timed_out(response)
    assert elapsed < 1.4


def test_a_budget_already_spent_runs_no_read_on_an_empty_period(admin, monkeypatch):
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", -1.0)
    with statements_during(app_engine(admin)) as statements:
        response = admin.get(SUMMARY, params=PERIOD)
    assert_timed_out(response)
    assert [s for s in statements if "FROM job" in s] == []


@pytest.mark.parametrize("marker", ["FROM job_usage ", "FROM job_usage_attempts", "FROM jobs"])
def test_a_slow_statement_is_cancelled_at_the_time_left(marker, admin, db_engine, monkeypatch):
    """Not after the 10 s a single statement may take: the server stops it when the budget ends."""
    add_job(db_engine, T)
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", 1.0)
    stop = delay_reads(app_engine(admin), 12, marker)
    try:
        response, elapsed = timed_get(admin, SUMMARY, **PERIOD)
    finally:
        stop()
    assert_timed_out(response)
    assert elapsed < 3
    assert wait_until_checked_in(app_engine(admin)) == 0


def test_a_summary_inside_its_budget_is_unchanged(admin, db_engine, monkeypatch):
    add_job(db_engine, T, translator=1000, speech=2000)
    plain = get_ok(admin, SUMMARY, **PERIOD)
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", 20.0)
    stop = delay_reads(app_engine(admin), 0.05)
    try:
        delayed = get_ok(admin, SUMMARY, **PERIOD)
    finally:
        stop()
    assert {**delayed, "generated_at": ""} == {**plain, "generated_at": ""}
    assert service(delayed, "translator")["reference_cost"] == "0.01"
    assert service(delayed, "speech")["reference_cost"] == "0.03"


def _milliseconds(setting: str) -> float:
    if setting.endswith("ms"):
        return float(setting[:-2])
    assert setting.endswith("s")
    return float(setting[:-1]) * 1000


def test_each_read_is_limited_to_the_time_left_and_the_limit_stays_local(
    admin, db_engine, monkeypatch
):
    add_job(db_engine, T)
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", 5.0)
    engine = app_engine(admin)
    seen = []

    def before(conn, cursor, statement, parameters, context, executemany):
        if "FROM job" in statement:
            cursor.execute("SELECT current_setting('statement_timeout')")
            statement_limit = cursor.fetchone()[0]
            cursor.execute("SELECT current_setting('lock_timeout')")
            seen.append((statement_limit, cursor.fetchone()[0]))

    event.listen(engine, "before_cursor_execute", before)
    try:
        get_ok(admin, SUMMARY, **PERIOD)
    finally:
        event.remove(engine, "before_cursor_execute", before)
    limits = [_milliseconds(statement) for statement, _ in seen]
    assert len(limits) == 4  # the batch, its attempts, the two final queries
    assert all(statement == lock for statement, lock in seen)
    assert all(0 < limit <= 5000 for limit in limits)
    assert limits == sorted(limits, reverse=True)
    with engine.connect() as conn:
        assert conn.execute(text("SHOW statement_timeout")).scalar_one() == "0"
        assert conn.execute(text("SHOW lock_timeout")).scalar_one() == "0"


def test_the_limit_of_a_statement_stays_ten_seconds_with_plenty_of_budget(
    admin, db_engine, monkeypatch
):
    add_job(db_engine, T)
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", 1000.0)
    engine = app_engine(admin)
    seen = []

    def before(conn, cursor, statement, parameters, context, executemany):
        if "FROM job" in statement:
            cursor.execute("SELECT current_setting('statement_timeout')")
            seen.append(cursor.fetchone()[0])

    event.listen(engine, "before_cursor_execute", before)
    try:
        get_ok(admin, SUMMARY, **PERIOD)
    finally:
        event.remove(engine, "before_cursor_execute", before)
    assert seen == ["10s"] * 4


def test_the_budget_counts_the_wait_for_a_connection(admin, db_engine, monkeypatch):
    add_job(db_engine, T)
    engine = app_engine(admin)
    monkeypatch.setattr(queries, "SUMMARY_BUDGET_SECONDS", 0.5)
    monkeypatch.setattr(engine.pool, "_timeout", 5)
    original = queries.report_snapshot
    held = []

    def release() -> None:
        for connection in held:
            connection.close()

    @contextmanager
    def taken_first(factory):
        held.extend(hold_connections(engine))
        threading.Timer(1.0, release).start()
        with original(factory) as db:
            yield db

    monkeypatch.setattr(queries, "report_snapshot", taken_first)
    response, elapsed = timed_get(admin, SUMMARY, **PERIOD)
    assert_timed_out(response)
    assert elapsed < 3
    assert wait_until_checked_in(engine) == 0


# -- the connection pool --------------------------------------------------------------------------


@pytest.mark.parametrize("url", [SUMMARY, JOBS, job_url(uuid.uuid4())])
def test_no_connection_left_is_a_clean_timeout(url, admin, monkeypatch):
    """Other work holds the whole pool: an error about time, not a hang, and nothing left out."""
    engine = app_engine(admin)
    monkeypatch.setattr(engine.pool, "_timeout", 0.3)
    original = queries.report_snapshot
    held = []

    @contextmanager
    def taken_first(factory):
        held.extend(hold_connections(engine))
        with original(factory) as db:
            yield db

    monkeypatch.setattr(queries, "report_snapshot", taken_first)
    response = admin.get(url, params=PERIOD if url in (SUMMARY, JOBS) else None)
    for connection in held:
        connection.close()
    assert_timed_out(response)
    assert wait_until_checked_in(engine) == 0


@pytest.mark.parametrize("url", [SUMMARY, JOBS, "detail"])
def test_the_auth_connection_is_returned_before_the_report_asks_for_one(
    url, admin, db_engine, monkeypatch
):
    job_id = add_job(db_engine, T)
    engine = app_engine(admin)
    original = queries.report_snapshot
    out = []

    @contextmanager
    def probing(factory):
        out.append(engine.pool.checkedout())
        with original(factory) as db:
            yield db

    monkeypatch.setattr(queries, "report_snapshot", probing)
    target = job_url(job_id) if url == "detail" else url
    with statements_during(engine) as statements:
        get_ok(admin, target, **({} if url == "detail" else PERIOD))
    assert out == [0]
    # The role is still read from the database by this request, before the report starts.
    auth = next(i for i, s in enumerate(statements) if "FROM user_sessions" in s)
    report = next(i for i, s in enumerate(statements) if "SET TRANSACTION" in s)
    assert auth < report


@pytest.mark.parametrize("url", [SUMMARY, JOBS, "detail"])
@pytest.mark.parametrize("count", [10, 20])
def test_concurrent_reports_do_not_starve_the_pool(count, url, admin, db_engine, monkeypatch):
    """All of them past auth at once, as many as the pool's 5 + 5 and more: each gets a connection.

    A request holding its auth connection while waiting for a second one makes this a deadlock:
    ten requests take all ten connections, and all wait for an eleventh until the pool times out."""
    job_id = add_job(db_engine, T)
    engine = app_engine(admin)
    monkeypatch.setattr(engine.pool, "_timeout", 10)
    original = queries.report_snapshot
    out_when_all_arrived = []
    barrier = threading.Barrier(
        count, action=lambda: out_when_all_arrived.append(engine.pool.checkedout())
    )

    @contextmanager
    def together(factory):
        barrier.wait(timeout=15)
        with original(factory) as db:
            yield db

    monkeypatch.setattr(queries, "report_snapshot", together)
    target = job_url(job_id) if url == "detail" else url
    params = None if url == "detail" else PERIOD
    stop = delay_reads(engine, 0.05)
    try:
        with ThreadPoolExecutor(count) as executor:
            responses = list(executor.map(lambda _: admin.get(target, params=params), range(count)))
    finally:
        stop()
    assert [r.status_code for r in responses] == [200] * count, responses[0].text
    assert out_when_all_arrived == [0]
    assert wait_until_checked_in(engine) == 0


def test_every_way_out_returns_the_connections(admin, db_engine, make_cognito_client, monkeypatch):
    job_id = add_job(db_engine, T)
    engine = app_engine(admin)
    anonymous = make_cognito_client()
    bad_cursor = {**PERIOD, "cursor": "!!!"}
    for url, params, expected in (
        (SUMMARY, PERIOD, 200),
        (JOBS, PERIOD, 200),
        (job_url(job_id), None, 200),
        (job_url(uuid.uuid4()), None, 404),
        (JOBS, bad_cursor, 422),
        (job_url(job_id), {"cursor": "!!!"}, 422),
        (SUMMARY, {"since": "nonsense"}, 422),
    ):
        assert admin.get(url, params=params).status_code == expected, url
        assert wait_until_checked_in(engine) == 0, url

    # A database error inside the report.
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(queries, "STATEMENT_TIMEOUT_SECONDS", 0.2)
        with db_engine.connect() as conn:
            conn.execute(text("LOCK TABLE job_usage IN ACCESS EXCLUSIVE MODE"))
            assert admin.get(JOBS, params=PERIOD).status_code == 503
            conn.rollback()
    assert wait_until_checked_in(engine) == 0

    # Something unexpected while building the response.
    def fail(*_args, **_kwargs):
        raise RuntimeError("unexpected")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(queries, "summarize_period", fail)
        with pytest.raises(RuntimeError):
            admin.get(SUMMARY, params=PERIOD)
    assert wait_until_checked_in(engine) == 0

    # Refused callers.
    assert anonymous.get(SUMMARY).status_code == 401
    assert wait_until_checked_in(app_engine(anonymous)) == 0
    _revoke(db_engine)
    assert admin.get(SUMMARY).status_code == 403
    assert wait_until_checked_in(engine) == 0


def test_a_failure_returning_the_auth_connection_is_a_clean_error(admin, monkeypatch, caplog):
    secret = "postgresql://someuser:s3cr3t-pw@db.internal/x"
    engine = app_engine(admin)
    original = Session.commit
    reports_opened = []

    def failing(session):
        if session.in_transaction():
            raise OperationalError("COMMIT", {"p": secret}, Exception(secret))
        return original(session)

    monkeypatch.setattr(Session, "commit", failing)
    monkeypatch.setattr(queries, "report_snapshot", lambda f: reports_opened.append(f))
    with caplog.at_level(logging.INFO):
        response = admin.get(SUMMARY, params=PERIOD)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "usage_report_unavailable"
    assert reports_opened == []
    assert secret not in response.text and secret not in caplog.text
    assert wait_until_checked_in(engine) == 0
