"""Restart recovery, shutdown interruption, and temporary-result expiration."""

import json
import shutil
import time
import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import create_app
from app.maintenance import run_cleanup
from tests.conftest import create_job, login, wait_for_terminal


def insert_session_and_job(
    db_engine,
    status: str,
    *,
    last_seen_seconds_ago: float = 0,
    runner_id: str | None = "another-instance",
    with_heartbeat: bool = True,
) -> uuid.UUID:
    now = datetime.now(UTC)
    last_seen = now - timedelta(seconds=last_seen_seconds_ago)
    session_id, job_id = uuid.uuid4(), uuid.uuid4()
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO access_sessions (id, token_hash, csrf_token, created_at, expires_at)"
                " VALUES (:id, :hash, 'csrf', :now, :exp)"
            ),
            {"id": session_id, "hash": uuid.uuid4().hex, "now": now, "exp": now + timedelta(1)},
        )
        conn.execute(
            text(
                "INSERT INTO jobs (id, session_id, status, runner_id, heartbeat_at, voice,"
                " first_sentence_start_seconds, last_sentence_start_seconds,"
                " target_duration_seconds, transcript_char_count, translation_provider,"
                " speech_provider, audio_processor, created_at, updated_at)"
                " VALUES (:id, :sid, :status, :runner, :heartbeat, 'HoaiMy', 10, 370, 360, 42,"
                " 'mock-translation', 'mock-speech', 'mock-audio', :seen, :seen)"
            ),
            {
                "id": job_id,
                "sid": session_id,
                "status": status,
                "runner": runner_id,
                "heartbeat": last_seen if with_heartbeat else None,
                "seen": last_seen,
            },
        )
    return job_id


def job_row(db_engine, job_id):
    with db_engine.connect() as conn:
        return conn.execute(
            text("SELECT status, error_code FROM jobs WHERE id = :id"), {"id": job_id}
        ).one()


ACTIVE = ("queued", "translating", "synthesizing", "processing")


def test_restart_fails_jobs_whose_instance_stopped_sending_heartbeats(make_client, db_engine):
    stale = {s: insert_session_and_job(db_engine, s, last_seen_seconds_ago=600) for s in ACTIVE}
    # Written by code without heartbeats: falls back to updated_at.
    legacy = insert_session_and_job(
        db_engine, "translating", last_seen_seconds_ago=600, runner_id=None, with_heartbeat=False
    )
    completed = insert_session_and_job(db_engine, "completed", last_seen_seconds_ago=600)

    make_client()  # app startup = restart

    for job_id in [*stale.values(), legacy]:
        assert tuple(job_row(db_engine, job_id)) == ("failed", "interrupted")
    assert tuple(job_row(db_engine, completed)) == ("completed", None)


def test_restart_leaves_jobs_of_a_live_instance_alone(make_client, db_engine):
    """Overlapping deploy: the old instance is still running and heartbeating its jobs."""
    live = {s: insert_session_and_job(db_engine, s, last_seen_seconds_ago=5) for s in ACTIVE}

    make_client()  # the new instance starts

    for status, job_id in live.items():
        assert tuple(job_row(db_engine, job_id)) == (status, None)


def test_jobs_are_failed_once_their_heartbeat_goes_stale(make_client, db_engine):
    """A crashed instance's jobs are detected later by the periodic liveness check."""
    client = make_client(job_heartbeat_interval_seconds=1, job_stale_after_seconds=3)
    job_id = insert_session_and_job(db_engine, "processing", last_seen_seconds_ago=0)
    assert tuple(job_row(db_engine, job_id)) == ("processing", None)

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and job_row(db_engine, job_id)[0] != "failed":
        time.sleep(0.2)
    assert tuple(job_row(db_engine, job_id)) == ("failed", "interrupted")
    assert client.get("/api/health").status_code == 200


def test_overlapping_instance_does_not_interrupt_running_job(make_client, db_engine):
    old = make_client(
        mock_stage_delay_seconds=1.0, job_heartbeat_interval_seconds=1, job_stale_after_seconds=3
    )
    csrf = login(old)
    job_id = create_job(old, csrf).json()["id"]

    # A new instance starts against the same database while the job runs on the old one.
    new = make_client(job_heartbeat_interval_seconds=1, job_stale_after_seconds=3)
    assert new.get("/api/health").status_code == 200

    # Status is read from the shared database through either instance.
    assert wait_for_terminal(old, job_id)["status"] == "completed"
    assert tuple(job_row(db_engine, job_id)) == ("completed", None)


def test_own_jobs_keep_a_fresh_heartbeat(make_client, db_engine):
    client = make_client(
        mock_stage_delay_seconds=2.0, job_heartbeat_interval_seconds=1, job_stale_after_seconds=3
    )
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    with db_engine.connect() as conn:
        runner, first = conn.execute(
            text("SELECT runner_id, heartbeat_at FROM jobs WHERE id = :id"), {"id": job_id}
        ).one()
    assert runner == client.app.state.services.instance_id

    time.sleep(1.5)
    with db_engine.connect() as conn:
        later = conn.execute(
            text("SELECT heartbeat_at FROM jobs WHERE id = :id"), {"id": job_id}
        ).scalar_one()
    assert later > first


def test_shutdown_lets_running_jobs_finish_within_grace(make_settings, db_engine):
    settings = make_settings(mock_stage_delay_seconds=0.5, job_shutdown_grace_seconds=10)
    with TestClient(create_app(settings)) as client:
        csrf = login(client)
        job_id = create_job(client, csrf).json()["id"]
        wait_for_status(client, job_id, "translating")
    # Shutdown waited for the job instead of interrupting it.
    assert tuple(job_row(db_engine, job_id)) == ("completed", None)


def test_shutdown_interrupts_jobs_that_outlive_the_grace_period(make_settings, db_engine):
    settings = make_settings(mock_stage_delay_seconds=3.0, job_shutdown_grace_seconds=0.5)
    with TestClient(create_app(settings)) as client:
        csrf = login(client)
        job_id = create_job(client, csrf).json()["id"]
        wait_for_status(client, job_id, "translating")
    assert tuple(job_row(db_engine, job_id)) == ("failed", "interrupted")


def wait_for_status(client, job_id: str, status: str, timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if client.get(f"/api/jobs/{job_id}").json()["status"] == status:
            return
        time.sleep(0.05)
    raise AssertionError(f"job never reached {status}")


def complete_job(client) -> tuple[str, dict]:
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    return job_id, client.get(f"/api/jobs/{job_id}").json()


def test_result_removed_from_disk_returns_explicit_expiration(client, tmp_path):
    job_id, _ = complete_job(client)
    # Simulates a restart on an ephemeral disk (e.g. Render redeploy).
    shutil.rmtree(tmp_path / "results" / job_id)

    for path in (f"/api/jobs/{job_id}/result", f"/api/jobs/{job_id}/result/audio"):
        response = client.get(path)
        assert response.status_code == 410
        assert response.json()["error"]["code"] == "result_expired"
    # Job metadata remains readable and still reports completion.
    assert client.get(f"/api/jobs/{job_id}").json()["status"] == "completed"


def test_cleanup_removes_expired_results(client, tmp_path):
    job_id, _ = complete_job(client)
    meta_path = tmp_path / "results" / job_id / "meta.json"
    meta = json.loads(meta_path.read_text())
    meta["expires_at"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    meta_path.write_text(json.dumps(meta))

    run_cleanup(client.app.state.services)

    assert not (tmp_path / "results" / job_id).exists()
    response = client.get(f"/api/jobs/{job_id}/result")
    assert response.status_code == 410
    assert response.json()["error"]["code"] == "result_expired"


def test_cleanup_deletes_stale_sessions_but_keeps_job_metadata(client, db_engine):
    job_id, _ = complete_job(client)
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE access_sessions SET expires_at = :t"),
            {"t": datetime.now(UTC) - timedelta(seconds=1)},
        )
    run_cleanup(client.app.state.services)
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM access_sessions")).scalar() == 0
        owner = conn.execute(
            text("SELECT session_id FROM jobs WHERE id = :id"), {"id": job_id}
        ).scalar()
    assert owner is None
    assert tuple(job_row(db_engine, job_id)) == ("completed", None)
