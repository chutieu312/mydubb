"""Restart recovery, shutdown interruption, and temporary-result expiration."""

import json
import shutil
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.maintenance import run_cleanup
from tests.conftest import create_job, login, wait_for_terminal


def insert_session_and_job(db_engine, status: str) -> uuid.UUID:
    now = datetime.now(UTC)
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
                "INSERT INTO jobs (id, session_id, status, voice, first_sentence_start_seconds,"
                " last_sentence_start_seconds, target_duration_seconds, transcript_char_count,"
                " translation_provider, speech_provider, audio_processor, created_at, updated_at)"
                " VALUES (:id, :sid, :status, 'HoaiMy', 10, 370, 360, 42,"
                " 'mock-translation', 'mock-speech', 'mock-audio', :now, :now)"
            ),
            {"id": job_id, "sid": session_id, "status": status, "now": now},
        )
    return job_id


def job_row(db_engine, job_id):
    with db_engine.connect() as conn:
        return conn.execute(
            text("SELECT status, error_code FROM jobs WHERE id = :id"), {"id": job_id}
        ).one()


def test_restart_marks_interrupted_jobs_failed(make_client, db_engine):
    active = {
        s: insert_session_and_job(db_engine, s) for s in ("queued", "translating", "processing")
    }
    completed = insert_session_and_job(db_engine, "completed")

    make_client()  # app startup = restart

    for job_id in active.values():
        assert tuple(job_row(db_engine, job_id)) == ("failed", "interrupted")
    assert tuple(job_row(db_engine, completed)) == ("completed", None)


def test_shutdown_marks_this_process_unfinished_jobs_interrupted(make_settings, db_engine):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(mock_stage_delay_seconds=3.0))) as client:
        csrf = login(client)
        job_id = create_job(client, csrf).json()["id"]
    # Shutdown happened while the job was still running.
    assert tuple(job_row(db_engine, job_id)) == ("failed", "interrupted")


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
