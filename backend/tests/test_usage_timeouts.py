"""A usage write that has to wait for a lock is abandoned at the timeout: the job goes on.

Real PostgreSQL: another connection holds an ACCESS EXCLUSIVE lock on the usage tables, so every
usage statement would wait for as long as the lock is held. The shared engine has no statement or
lock timeout (only a connect timeout), so the bound must come from the usage transaction itself.
"""

import logging
import threading
import time
import uuid
from contextlib import contextmanager

from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import sessionmaker

from app.main import create_app
from app.usage.recording import UsageCollector
from tests.conftest import create_job, login, wait_for_terminal

TIMEOUT = 0.3
SAFETY_RELEASE_SECONDS = 40  # a test that would hang fails instead: the lock goes away


@contextmanager
def locked_usage_tables(engine: Engine):
    """Hold ACCESS EXCLUSIVE on both usage tables from another connection."""
    conn = engine.connect()
    transaction = conn.begin()
    conn.execute(text("LOCK TABLE job_usage, job_usage_attempts IN ACCESS EXCLUSIVE MODE"))
    released = threading.Event()

    def release() -> None:
        if not released.is_set():
            released.set()
            transaction.rollback()
            conn.close()

    safety = threading.Timer(SAFETY_RELEASE_SECONDS, release)
    safety.daemon = True
    safety.start()
    try:
        yield release
    finally:
        safety.cancel()
        release()


def lock_waiters(engine: Engine) -> int:
    with engine.connect() as conn:
        return conn.execute(
            text("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'")
        ).scalar_one()


def collector(engine: Engine, job_id: uuid.UUID) -> UsageCollector:
    return UsageCollector(
        sessionmaker(bind=engine, expire_on_commit=False),
        job_id,
        {
            "client": "web",
            "access": "invitation",
            "target_language": "vietnamese",
            "voice": "AndrewMultilingual",
            "speed_percent": 100,
            "timing_mode": "plain",
            "translation_provider": "azure-translator",
            "speech_provider": "azure-speech",
            "audio_processor": "ffmpeg-audio",
            "baseline_seconds": 60,
            "target_audio_seconds": 60,
            "source_chars": 10,
        },
        TIMEOUT,
    )


def attempt_row() -> dict:
    from datetime import UTC, datetime

    return {
        "service": "translator",
        "provider_kind": "azure",
        "operation": "translate",
        "outcome": "ok",
        "http_status": 200,
        "items": 1,
        "started_at": datetime.now(UTC),
        "elapsed_ms": 5,
        "usage_amount": 10,
        "usage_unit": "characters",
        "usage_basis": "actual",
    }


def test_begin_attempt_and_finish_each_end_at_the_timeout_and_nothing_keeps_waiting(
    db_engine, caplog
):
    caplog.set_level(logging.WARNING)
    job_id = uuid.uuid4()
    usage = collector(db_engine, job_id)
    with locked_usage_tables(db_engine) as release:
        started = time.monotonic()
        usage.begin()  # waits for the lock, then gives up
        begin_took = time.monotonic() - started
        assert TIMEOUT * 0.5 < begin_took < 5, begin_took
        assert lock_waiters(db_engine) == 0  # PostgreSQL cancelled it: no query left waiting

        started = time.monotonic()
        usage.add_attempt(attempt_row())  # writing is suspended after the first failure
        assert time.monotonic() - started < TIMEOUT
        usage.add_attempt(attempt_row())

        started = time.monotonic()
        usage.finish("completed", None)  # the last try at the pending rows and the summary
        assert time.monotonic() - started < 5
        assert lock_waiters(db_engine) == 0
        assert "usage was not written (OperationalError)" in caplog.text
        assert "usage is incomplete" in caplog.text
        release()

    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one() == 0


def test_what_could_not_be_written_is_written_and_marked_once_the_lock_is_gone(db_engine):
    job_id = uuid.uuid4()
    usage = collector(db_engine, job_id)
    with locked_usage_tables(db_engine) as release:
        usage.begin()  # times out; writing is suspended
        usage.add_attempt(attempt_row())
        usage.add_attempt(attempt_row())
        release()  # the lock goes away before the job ends
    usage.finish("completed", None)

    with db_engine.connect() as conn:
        row = conn.execute(
            text("SELECT outcome, attempts_expected, write_errors FROM job_usage")
        ).one()
        seqs = [r[0] for r in conn.execute(text("SELECT seq FROM job_usage_attempts ORDER BY seq"))]
    assert tuple(row) == ("completed", 2, 1)  # the report sees one write failed
    assert seqs == [1, 2]


def test_the_timeout_is_per_transaction_and_does_not_leak_into_the_pool(db_engine, make_settings):
    factory = sessionmaker(bind=db_engine, expire_on_commit=False)
    usage = collector(db_engine, uuid.uuid4())
    usage.begin()
    usage.add_attempt(attempt_row())
    with factory() as db:  # any later transaction on a pooled connection: unbounded as before
        assert db.execute(text("SHOW statement_timeout")).scalar_one() == "0"
        assert db.execute(text("SHOW lock_timeout")).scalar_one() == "0"
    assert make_settings().usage_write_timeout_seconds == 3.0


def test_a_blocked_usage_table_does_not_hold_the_job_or_its_slot(make_client, db_engine, caplog):
    caplog.set_level(logging.WARNING)
    client = make_client(
        usage_write_timeout_seconds=TIMEOUT, job_max_concurrency=1, job_max_queued=0
    )
    csrf = login(client)
    services = client.app.state.services
    with locked_usage_tables(db_engine):
        first = create_job(client, csrf)
        assert first.status_code == 202
        job = wait_for_terminal(client, first.json()["id"], timeout=20)
        assert job["status"] == "completed"
        assert client.get(f"/api/jobs/{job['id']}/result").status_code == 200

        deadline = time.monotonic() + 20  # the job stops being tracked once its record is done
        while services.pipeline.unfinished_job_ids() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert services.pipeline.unfinished_job_ids() == set()
        assert lock_waiters(db_engine) == 0

        # The only slot was returned: another job is accepted (not 503) and also completes.
        second = create_job(client, csrf)
        assert second.status_code == 202, second.text
        assert wait_for_terminal(client, second.json()["id"], timeout=20)["status"] == "completed"
        assert "usage is incomplete" in caplog.text or "usage was not written" in caplog.text


def test_shutdown_with_a_blocked_usage_table_waits_for_the_bounded_job_not_forever(
    make_settings, db_engine
):
    settings = make_settings(
        usage_write_timeout_seconds=TIMEOUT,
        job_shutdown_grace_seconds=30,
        mock_stage_delay_seconds=0.2,
    )
    client = TestClient(create_app(settings))
    client.__enter__()
    try:
        csrf = login(client)
        with locked_usage_tables(db_engine):
            job_id = create_job(client, csrf).json()["id"]
            started = time.monotonic()
            client.__exit__(None, None, None)  # shutdown drains the running job
            assert time.monotonic() - started < 15
            assert lock_waiters(db_engine) == 0
        with db_engine.connect() as conn:
            status = conn.execute(
                text("SELECT status FROM jobs WHERE id = :id"), {"id": uuid.UUID(job_id)}
            ).scalar_one()
        assert status == "completed"  # drained, not interrupted
    finally:
        # `__exit__` already ran on the success path; make sure the app is closed otherwise.
        if client.portal is not None:
            client.__exit__(None, None, None)


def test_without_the_server_side_limit_the_same_lock_does_hold_the_write(db_engine, monkeypatch):
    """Control: proves the lock really blocks, so the tests above pass because of the limit."""
    from app.usage import store

    monkeypatch.setattr(store, "limit_waits", lambda db, seconds: None)
    usage = collector(db_engine, uuid.uuid4())
    with locked_usage_tables(db_engine) as release:
        threading.Timer(2.0, release).start()  # the lock is let go after 2 s
        started = time.monotonic()
        usage.begin()
        waited = time.monotonic() - started
    assert waited >= 1.5, waited  # held until the lock went away, far beyond TIMEOUT
    with db_engine.connect() as conn:  # and then the write simply succeeded
        assert conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one() == 1


def test_the_worst_case_delay_of_usage_writes_is_three_timeouts(db_engine):
    """Start fails (1), the last try at the pending rows fails (2), the summary fails (3)."""
    usage = collector(db_engine, uuid.uuid4())
    with locked_usage_tables(db_engine):
        started = time.monotonic()
        usage.begin()
        usage.add_attempt(attempt_row())
        usage.finish("completed", None)
        total = time.monotonic() - started
    assert 3 * TIMEOUT * 0.8 <= total < 3 * TIMEOUT + 1.5, total


def test_a_failure_in_the_middle_of_the_job_costs_the_same_three_timeouts(db_engine):
    """Start succeeds; one attempt write fails (1); then the retry (2) and the summary (3)."""
    usage = collector(db_engine, uuid.uuid4())
    usage.begin()
    with locked_usage_tables(db_engine):
        started = time.monotonic()
        usage.add_attempt(attempt_row())
        usage.add_attempt(attempt_row())  # suspended: no further wait
        usage.finish("completed", None)
        total = time.monotonic() - started
    assert 3 * TIMEOUT * 0.8 <= total < 3 * TIMEOUT + 1.5, total
