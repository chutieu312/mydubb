import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.speech.mock import FIXTURE_MP3
from tests.conftest import create_job, login, wait_for_terminal


def field_errors(response) -> dict[str, str]:
    assert response.status_code == 422, response.text
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    return {f["field"]: f["message"] for f in body["fields"]}


@pytest.mark.parametrize("value", ["0:00:10", "00:00", "00:61:00", "10s", ""])
def test_malformed_timestamps_are_rejected(client, value):
    csrf = login(client)
    errors = field_errors(create_job(client, csrf, first_sentence_start=value))
    assert "first_sentence_start" in errors


@pytest.mark.parametrize("last", ["00:00:10", "00:00:09"])
def test_last_not_after_first_is_rejected(client, last):
    csrf = login(client)
    errors = field_errors(create_job(client, csrf, last_sentence_start=last))
    assert "later than" in errors["last_sentence_start"]


@pytest.mark.parametrize("transcript", ["", "   \n  ", "00:00:01\n00:00:02"])
def test_empty_transcripts_are_rejected(client, transcript):
    csrf = login(client)
    errors = field_errors(create_job(client, csrf, transcript=transcript))
    assert "transcript" in errors


@pytest.mark.parametrize("voice", ["HoaiMy", "NamMinh"])
def test_approved_voices_are_accepted(client, voice):
    csrf = login(client)
    response = create_job(client, csrf, voice=voice)
    assert response.status_code == 202
    assert response.json()["voice"] == voice


@pytest.mark.parametrize("voice", ["hoaimy", "vi-VN-HoaiMyNeural", "en-US-JennyNeural", ""])
def test_other_voices_are_rejected(client, voice):
    csrf = login(client)
    assert "voice" in field_errors(create_job(client, csrf, voice=voice))


def test_backend_calculates_target_duration(client):
    csrf = login(client)
    body = create_job(client, csrf).json()
    assert body["target_duration_seconds"] == 360
    assert body["target_duration"] == "00:06:00"


def test_mock_success_workflow_completes_end_to_end(client, db_engine):
    csrf = login(client)
    created = create_job(client, csrf)
    assert created.status_code == 202
    assert created.headers["location"] == f"/api/jobs/{created.json()['id']}"
    assert created.json()["status"] == "queued"
    job_id = created.json()["id"]

    final = wait_for_terminal(client, job_id)
    assert final["status"] == "completed"
    assert final["error"] is None
    assert final["result_expires_at"] is not None

    result = client.get(f"/api/jobs/{job_id}/result")
    assert result.status_code == 200
    body = result.json()
    assert body["translation"]["is_illustrative"] is True
    assert "NOT a real Vietnamese translation" in body["translation"]["text"]
    assert body["audio"]["is_fixture"] is True
    assert body["audio"]["duration_adjusted"] is False
    assert any("NOT generated from your transcript" in n for n in body["notices"])

    audio = client.get(body["audio"]["url"])
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/mpeg"
    assert audio.content == FIXTURE_MP3.read_bytes()
    assert audio.headers["content-disposition"].startswith("inline")

    download = client.get(body["audio"]["download_url"])
    assert download.headers["content-disposition"].startswith("attachment")

    # Transcript and translation content are never written to the database.
    with db_engine.connect() as conn:
        row = conn.execute(text("SELECT * FROM jobs WHERE id = :id"), {"id": job_id}).mappings()
        stored = " ".join(str(v) for v in row.one().values())
    assert "Dependency Injection" not in stored


def test_job_creation_returns_promptly_while_processing_continues(make_client):
    client = make_client(mock_stage_delay_seconds=1.0)
    csrf = login(client)
    started = time.monotonic()
    created = create_job(client, csrf)
    assert created.status_code == 202
    assert time.monotonic() - started < 1.0

    seen = {created.json()["status"]}
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        status = client.get(f"/api/jobs/{created.json()['id']}").json()["status"]
        seen.add(status)
        if status == "completed":
            break
        time.sleep(0.1)
    assert {"translating", "synthesizing", "processing", "completed"} <= seen


def test_result_is_not_available_before_completion(make_client):
    client = make_client(mock_stage_delay_seconds=2.0)
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    response = client.get(f"/api/jobs/{job_id}/result")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "result_not_ready"


@pytest.mark.parametrize(
    ("stage", "code"),
    [
        ("translation", "translation_failed"),
        ("speech", "speech_failed"),
        ("audio", "audio_processing_failed"),
        ("unexpected", "internal_error"),
    ],
)
def test_mock_failures_persist_failed_state_with_safe_errors(make_client, db_engine, stage, code):
    client = make_client(mock_fail_stage=stage)
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]

    final = wait_for_terminal(client, job_id)
    assert final["status"] == "failed"
    assert final["error"]["code"] == code
    # No stack traces or exception internals leak to users.
    assert "Traceback" not in final["error"]["message"]
    assert "RuntimeError" not in final["error"]["message"]

    with db_engine.connect() as conn:
        status, error_code = conn.execute(
            text("SELECT status, error_code FROM jobs WHERE id = :id"), {"id": job_id}
        ).one()
    assert (status, error_code) == ("failed", code)

    result = client.get(f"/api/jobs/{job_id}/result")
    assert result.status_code == 409
    assert result.json()["error"]["code"] == "job_failed"


def test_one_session_cannot_access_another_sessions_jobs(client):
    owner_csrf = login(client)
    job_id = create_job(client, owner_csrf).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"

    other = TestClient(client.app)  # separate cookie jar => separate session
    login(other)
    for path in (
        f"/api/jobs/{job_id}",
        f"/api/jobs/{job_id}/result",
        f"/api/jobs/{job_id}/result/audio",
    ):
        response = other.get(path)
        assert response.status_code == 404, path
        assert response.json()["error"]["code"] == "job_not_found"

    # The owner still has access.
    assert client.get(f"/api/jobs/{job_id}/result").status_code == 200


def test_unknown_job_id_returns_not_found(client):
    login(client)
    response = client.get("/api/jobs/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


def test_server_reports_capacity_instead_of_queueing_unboundedly(make_client):
    client = make_client(job_max_concurrency=1, job_max_queued=0, mock_stage_delay_seconds=1.0)
    csrf = login(client)
    first = create_job(client, csrf)
    assert first.status_code == 202

    busy = create_job(client, csrf)
    assert busy.status_code == 503
    assert busy.json()["error"]["code"] == "server_at_capacity"
    assert "retry-after" in busy.headers

    assert wait_for_terminal(client, first.json()["id"])["status"] == "completed"
    assert create_job(client, csrf).status_code == 202


def test_request_body_size_guard(make_client):
    client = make_client(max_request_body_bytes=2048)
    csrf = login(client)
    response = create_job(client, csrf, transcript="word " * 1000)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"


def test_timestamp_like_spoken_content_reaches_the_pipeline_intact(client):
    csrf = login(client)
    transcript = "10:30 is our meeting time.\n16:30 is the aspect ratio."
    job_id = create_job(client, csrf, transcript=transcript).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"

    text = client.get(f"/api/jobs/{job_id}/result").json()["translation"]["text"]
    assert "(VI mock) 10:30 is our meeting time." in text
    assert text.rstrip().endswith("(VI mock) 16:30 is the aspect ratio.")
