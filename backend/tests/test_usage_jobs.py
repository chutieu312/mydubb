"""Per-job usage through the real pipeline and API (mock providers, or fake Azure HTTP).

Recording must describe the job without changing it: the same results, statuses and error codes
as before, and a failing usage write never turns a good job into a failed one.
"""

import json
import logging
import uuid
from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from app.auth.principal import Principal, UserProfile
from app.jobs.router import _usage_context
from app.main import create_app
from app.services import build_services
from app.usage import store
from app.usage.metering import speech_billable
from tests.conftest import VALID_JOB, create_job, login, wait_for_terminal
from tests.test_target_language_jobs import (
    IMPORTED,
    MANDARIN,
    audio_client,  # noqa: F401  (fixture)
    break_voice,
)
from tests.test_timed_jobs import ELEVEN_SECONDS, YOUTUBE

KEY = "usage-integration-key-0123456789"
SECRET_TEXT = "Spring Boot uses Dependency Injection"


def summary(engine: Engine, job_id: str) -> dict:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT * FROM job_usage WHERE job_id = :id"), {"id": uuid.UUID(job_id)}
        ).mappings()
        return dict(next(iter(row)))


def attempts(engine: Engine, job_id: str) -> list[dict]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT * FROM job_usage_attempts WHERE job_id = :id ORDER BY seq"),
            {"id": uuid.UUID(job_id)},
        ).mappings()
        return [dict(row) for row in rows]


def finished(client: TestClient, response, engine: Engine) -> dict:
    assert response.status_code == 202, response.text
    body = wait_for_terminal(client, response.json()["id"])
    return body


def test_a_mock_job_is_recorded_as_mock_and_never_as_billed_usage(client, db_engine):
    csrf = login(client)
    response = create_job(client, csrf, target_language="japanese", speed=1.5)
    job = finished(client, response, db_engine)
    assert job["status"] == "completed"

    row = summary(db_engine, job["id"])
    assert row["outcome"] == "completed" and row["finished_at"] is not None
    assert (row["client"], row["access"]) == ("web", "access_code")
    assert (row["target_language"], row["voice"], row["speed_percent"]) == (
        "japanese",
        "AndrewMultilingual",
        150,
    )
    assert row["timing_mode"] == "plain"
    assert (row["translation_provider"], row["speech_provider"]) == (
        "mock-translation",
        "mock-speech",
    )
    assert row["baseline_seconds"] == 360 and float(row["target_audio_seconds"]) == 240.0
    assert row["source_chars"] == len(VALID_JOB["transcript"])
    assert row["audio_ms"] is not None and row["mp3_bytes"] > 0
    assert row["final_audio_seconds"] is None  # a mock does not adjust or measure the duration
    assert row["attempts_expected"] == 2 and row["write_errors"] == 0

    rows = attempts(db_engine, job["id"])
    assert [(r["service"], r["provider_kind"], r["usage_basis"]) for r in rows] == [
        ("translator", "mock", "none"),
        ("speech", "mock", "none"),
    ]
    assert all(r["usage_amount"] is None for r in rows)  # a mock has no billable amount


def test_the_job_result_is_the_same_with_recording_off(make_client, db_engine):
    results = []
    for enabled in (True, False):
        client = make_client(usage_recording_enabled=enabled)
        csrf = login(client)
        job = finished(client, create_job(client, csrf), db_engine)
        results.append(client.get(f"/api/jobs/{job['id']}/result").json())
        with db_engine.connect() as conn:
            stored = conn.execute(
                text("SELECT count(*) FROM job_usage WHERE job_id = :id"),
                {"id": uuid.UUID(job["id"])},
            ).scalar_one()
        assert stored == int(enabled)
    for result in results:
        for key in ("job_id", "expires_at"):
            result.pop(key)
        result["audio"].pop("url"), result["audio"].pop("download_url")
    assert results[0] == results[1]


def test_a_timed_job_records_its_mode_and_blocks(client, db_engine):
    csrf = login(client)
    body = {"transcript": YOUTUBE, "timing_mode": "timed", **ELEVEN_SECONDS}
    job = finished(client, create_job(client, csrf, **body), db_engine)
    assert job["status"] == "completed"
    row = summary(db_engine, job["id"])
    assert row["timing_mode"] == "timed" and row["blocks"] > 0


def test_a_failing_stage_keeps_what_was_collected_before_it(make_client, db_engine):
    client = make_client(mock_fail_stage="speech")
    csrf = login(client)
    job = finished(client, create_job(client, csrf), db_engine)
    assert (job["status"], job["error"]["code"]) == ("failed", "speech_failed")

    row = summary(db_engine, job["id"])
    assert (row["outcome"], row["error_code"]) == ("failed", "speech_failed")
    rows = attempts(db_engine, job["id"])
    assert [(r["service"], r["outcome"]) for r in rows] == [
        ("translator", "ok"),
        ("speech", "failed"),
    ]
    assert rows[1]["error_code"] == "speech_failed"


def test_an_unexpected_error_is_recorded_as_failed(make_client, db_engine):
    client = make_client(mock_fail_stage="unexpected")
    csrf = login(client)
    job = finished(client, create_job(client, csrf), db_engine)
    assert job["status"] == "failed"
    row = summary(db_engine, job["id"])
    assert (row["outcome"], row["error_code"]) == ("failed", "internal_error")
    (attempt,) = attempts(db_engine, job["id"])
    assert (attempt["outcome"], attempt["error_code"]) == ("failed", "RuntimeError")


@pytest.fixture
def azure_translation_client(make_settings, db_engine) -> Callable[..., TestClient]:
    clients: list[TestClient] = []

    def factory(handler, **overrides) -> TestClient:
        settings = make_settings(
            translation_provider="azure", azure_translator_key=KEY, **overrides
        )
        services = build_services(settings, translation_transport=httpx.MockTransport(handler))
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def vietnamese(metered: str | None):
    def handler(request: httpx.Request) -> httpx.Response:
        items = json.loads(request.content)
        headers = {"X-metered-usage": metered} if metered is not None else {}
        return httpx.Response(
            200,
            json=[{"translations": [{"text": i["Text"], "to": "vi"}]} for i in items],
            headers=headers,
        )

    return handler


def test_azure_translation_usage_is_the_metered_header_and_is_real(
    azure_translation_client, db_engine
):
    client = azure_translation_client(vietnamese("321"))
    csrf = login(client)
    job = finished(client, create_job(client, csrf), db_engine)
    assert job["status"] == "completed"
    translator, speech = attempts(db_engine, job["id"])
    assert (translator["provider_kind"], translator["usage_basis"]) == ("azure", "actual")
    assert translator["usage_amount"] == 321 and translator["http_status"] == 200
    assert speech["provider_kind"] == "mock"  # speech is still a mock in this test
    assert summary(db_engine, job["id"])["translation_provider"] == "azure-translator"


def test_a_translator_answer_without_the_header_is_unknown_and_the_job_still_completes(
    azure_translation_client, db_engine
):
    client = azure_translation_client(vietnamese(None))
    csrf = login(client)
    job = finished(client, create_job(client, csrf), db_engine)
    assert job["status"] == "completed"
    translator = attempts(db_engine, job["id"])[0]
    assert translator["usage_amount"] is None and translator["usage_basis"] == "unknown"


def test_a_translator_error_fails_the_job_and_is_recorded_not_assumed_free(
    azure_translation_client, db_engine
):
    client = azure_translation_client(lambda request: httpx.Response(429, json={}))
    csrf = login(client)
    job = finished(client, create_job(client, csrf), db_engine)
    assert job["error"]["code"] == "translation_quota_exceeded"
    (attempt,) = attempts(db_engine, job["id"])
    assert (attempt["outcome"], attempt["http_status"], attempt["usage_basis"]) == (
        "http_error",
        429,
        "unknown",
    )
    assert summary(db_engine, job["id"])["error_code"] == "translation_quota_exceeded"


# --- a failing usage write never fails the job ---------------------------------------------------


def test_usage_write_errors_do_not_fail_a_good_job_and_leave_a_safe_warning(
    client, db_engine, monkeypatch, caplog
):
    def broken(*args, **kwargs):
        raise RuntimeError(f"connection details for {SECRET_TEXT}")

    monkeypatch.setattr(store, "upsert_summary", broken)
    monkeypatch.setattr(store, "insert_attempts", broken)
    caplog.set_level(logging.WARNING)
    csrf = login(client)
    job = finished(client, create_job(client, csrf), db_engine)
    assert job["status"] == "completed"
    assert client.get(f"/api/jobs/{job['id']}/result").status_code == 200

    log = caplog.text
    assert "usage was not written (RuntimeError)" in log
    assert "usage is incomplete" in log
    assert SECRET_TEXT not in log  # the exception text can quote SQL parameters
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one() == 0


def test_a_summary_write_that_fails_only_at_the_start_is_completed_at_the_end(
    client, db_engine, monkeypatch
):
    real = store.upsert_summary
    state = {"calls": 0}

    def first_fails(db, job_id, values):
        state["calls"] += 1
        if state["calls"] == 1:
            raise RuntimeError("blip")
        return real(db, job_id, values)

    monkeypatch.setattr(store, "upsert_summary", first_fails)
    csrf = login(client)
    job = finished(client, create_job(client, csrf), db_engine)
    row = summary(db_engine, job["id"])
    # The attempts that arrived while writing was suspended were stored at the end, and the
    # report can see that one write failed.
    assert row["write_errors"] == 1 and row["outcome"] == "completed"
    assert len(attempts(db_engine, job["id"])) == row["attempts_expected"] == 2


# --- who asked ------------------------------------------------------------------------------------


def principal(**kwargs) -> Principal:
    from datetime import UTC, datetime

    return Principal(
        session_id=uuid.uuid4(), csrf_token="x", expires_at=datetime.now(UTC), **kwargs
    )


def test_the_usage_context_has_labels_only():
    user = UserProfile(id=uuid.uuid4(), email="a@example.com", display_name="A")
    assert _usage_context(principal()).__dict__ == {"client": "web", "access": "access_code"}
    assert _usage_context(principal(user=user)).__dict__ == {
        "client": "web",
        "access": "invitation",
    }
    assert _usage_context(principal(user=user, bearer=True)).__dict__ == {
        "client": "extension",
        "access": "invitation",
    }
    assert _usage_context(principal(guest=True)).__dict__ == {"client": "web", "access": "guest"}
    assert "a@example.com" not in repr(_usage_context(principal(user=user)))


# --- real speech audio: fake Azure over real FFmpeg (skipped where FFmpeg is missing) -------------


def test_a_real_plain_job_records_each_request_once_with_the_measured_audio(
    audio_client,  # noqa: F811
    db_engine,
):
    client, translations, speeches = audio_client()
    csrf = login(client)
    job = wait_for_terminal(
        client, create_job(client, csrf, target_language=MANDARIN, speed=1.5).json()["id"], 60
    )
    assert job["status"] == "completed", job

    row = summary(db_engine, job["id"])
    assert (row["translation_provider"], row["speech_provider"]) == (
        "azure-translator",
        "azure-speech",
    )
    assert row["target_language"] == MANDARIN and row["audio_processor"] == "ffmpeg-audio"
    # The final MP3 was measured: baseline 360 s at 1.5x is exactly 240 s.
    assert (
        float(row["final_audio_seconds"]) == 240.0 and float(row["target_audio_seconds"]) == 240.0
    )
    downloaded = client.get(f"/api/jobs/{job['id']}/result/audio").content
    assert row["mp3_bytes"] == len(downloaded) > 0 and row["audio_ms"] > 0

    rows = attempts(db_engine, job["id"])
    translator = [r for r in rows if r["service"] == "translator"]
    spoken = [r for r in rows if r["service"] == "speech"]
    # Exactly the requests the fake services received: nothing added to measure, none twice.
    assert len(translator) == len(translations) and len(spoken) == len(speeches) > 0
    assert row["attempts_expected"] == len(rows) and row["write_errors"] == 0
    assert {r["provider_kind"] for r in rows} == {"azure"}
    # The estimate is computed from the SSML that really went out (Han characters count twice).
    expected = sorted(speech_billable(r.content.decode())[1] for r in speeches)
    assert sorted(r["usage_amount"] for r in spoken) == expected
    assert {r["usage_basis"] for r in spoken} == {"estimated"}
    assert any(
        speech_billable(r.content.decode())[1] > speech_billable(r.content.decode())[0]
        for r in speeches
    )


def test_a_real_timed_job_counts_a_multi_block_request_as_one_attempt(
    audio_client,  # noqa: F811
    db_engine,
):
    client, _translations, speeches = audio_client(speech=break_voice())
    csrf = login(client)
    body = {
        "transcript": IMPORTED,
        "timing_mode": "timed",
        "target_language": MANDARIN,
        **ELEVEN_SECONDS,
    }
    job = wait_for_terminal(client, create_job(client, csrf, **body).json()["id"], 60)
    assert job["status"] == "completed", job

    row = summary(db_engine, job["id"])
    assert row["timing_mode"] == "timed" and row["blocks"] == 3
    spoken = [r for r in attempts(db_engine, job["id"]) if r["service"] == "speech"]
    assert len(spoken) == len(speeches)
    assert sum(r["items"] for r in spoken) >= 3  # several blocks inside the requests
    assert max(r["items"] for r in spoken) > 1  # at least one request holds more than one block
    assert float(row["final_audio_seconds"]) == 11.0
