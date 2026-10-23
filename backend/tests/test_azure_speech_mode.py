"""Speech provider selection: configuration, labels and the job flow (fake HTTP, real ffmpeg)."""

import glob
import json
import tempfile
import uuid
from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.audio.ffmpeg import AudioTools, probe_mp3
from app.config import ConfigurationError, Settings, load_settings
from app.main import create_app
from app.services import build_services
from tests.audio_helpers import make_wav, ssml_spans, ssml_text, ssml_voice
from tests.conftest import VALID_JOB, create_job, login, wait_for_terminal

TRANSLATOR_KEY = "translator-key-0123456789abcdef"
SPEECH_KEY = "speech-key-0123456789abcdef-different"
AZURE_SPEECH = {
    "speech_provider": "azure",
    "azure_speech_key": SPEECH_KEY,
    "azure_speech_region": "westus2",
}
AZURE_BOTH = {
    **AZURE_SPEECH,
    "translation_provider": "azure",
    "azure_translator_key": TRANSLATOR_KEY,
}


def vietnamese(request: httpx.Request) -> httpx.Response:
    items = json.loads(request.content)
    return httpx.Response(
        200,
        json=[{"translations": [{"text": "Dịch: " + i["Text"], "to": "vi"}]} for i in items],
    )


def speaking(request: httpx.Request) -> httpx.Response:
    text = ssml_text(request.content)
    return httpx.Response(200, content=make_wav(len(text) / 15))


# --- configuration ------------------------------------------------------------------------------


def test_speech_provider_defaults_to_mock(make_settings):
    settings = make_settings()
    assert settings.component_providers == {
        "translation": "mock",
        "speech": "mock",
        "audio": "mock",
    }


def test_azure_speech_is_reported_per_component(make_settings):
    settings = make_settings(**AZURE_SPEECH)
    assert settings.component_providers == {
        "translation": "mock",
        "speech": "azure",
        "audio": "mock",
    }
    assert make_settings(**AZURE_BOTH).component_providers == {
        "translation": "azure",
        "speech": "azure",
        "audio": "mock",
    }


@pytest.mark.parametrize(
    "overrides",
    [
        {"azure_speech_key": None},
        {"azure_speech_key": ""},
        {"azure_speech_key": "has space"},
        {"azure_speech_key": "line\nbreak"},
        {"azure_speech_region": None},
        {"azure_speech_region": ""},
        {"azure_speech_region": "West US 2"},
        {"azure_speech_region": "westus2.evil.example"},
        {"azure_speech_region": "westus2/../x"},
        {"azure_speech_region": "WESTUS2"},
        {"mock_fail_stage": "speech"},
        {"azure_speech_timeout_seconds": 1},
        {"azure_speech_max_chunk_chars": 10},
        {"azure_speech_max_chunk_chars": 100_000},
        {"azure_speech_max_requests_per_window": 0},
    ],
)
def test_azure_speech_credentials_and_limits_are_validated(make_settings, overrides):
    with pytest.raises(ValidationError):
        make_settings(**{**AZURE_SPEECH, **overrides})


def test_the_translator_key_is_never_used_for_speech(make_settings):
    with pytest.raises(ValidationError, match="AZURE_SPEECH_KEY"):
        make_settings(
            speech_provider="azure",
            azure_speech_region="westus2",
            translation_provider="azure",
            azure_translator_key=TRANSLATOR_KEY,
        )


def test_speech_credentials_are_not_required_while_speech_is_mock(make_settings):
    assert make_settings(azure_speech_region="not a region").component_providers["speech"] == "mock"


def test_other_mock_failure_stages_still_work_with_azure_speech(make_settings):
    assert make_settings(**AZURE_SPEECH, mock_fail_stage="audio").mock_fail_stage == "audio"
    assert make_settings(**AZURE_SPEECH, mock_fail_stage="translation").mock_fail_stage == (
        "translation"
    )


def test_full_azure_provider_mode_is_refused_without_duration_processing(make_settings):
    with pytest.raises(ValidationError, match="AUDIO_PROCESSOR=ffmpeg"):
        make_settings(provider_mode="azure", **AZURE_BOTH)


def test_production_still_needs_the_mock_opt_in_while_audio_processing_is_mock(make_settings):
    production = {"app_env": "production", "access_code": "x" * 32, "cookie_secure": True}
    with pytest.raises(ValidationError, match="Mock providers"):
        make_settings(**AZURE_BOTH, **production)
    settings = make_settings(**AZURE_BOTH, **production, allow_mock_providers_in_production=True)
    assert settings.component_providers["speech"] == "azure"
    with pytest.raises(ValidationError, match="MOCK_FAIL_STAGE"):
        make_settings(
            **AZURE_BOTH,
            **production,
            allow_mock_providers_in_production=True,
            mock_fail_stage="audio",
        )


def test_keys_never_appear_in_settings_text_or_configuration_errors(make_settings, monkeypatch):
    text = repr(make_settings(**AZURE_BOTH)) + str(make_settings(**AZURE_BOTH))
    assert SPEECH_KEY not in text
    assert TRANSLATOR_KEY not in text

    for name, value in {
        "SPEECH_PROVIDER": "azure",
        "AZURE_SPEECH_KEY": SPEECH_KEY,
        "AZURE_SPEECH_REGION": "West US",
        "DATABASE_URL": "postgresql://u:p@127.0.0.1:1/db",
        "ACCESS_CODE": "x" * 20,
        "APP_ENV": "test",
        "PROVIDER_MODE": "mock",
    }.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(ConfigurationError) as error:
        load_settings()
    assert SPEECH_KEY not in str(error.value)
    assert "AZURE_SPEECH_REGION" in str(error.value)


def test_startup_fails_without_ffmpeg_instead_of_falling_back(
    make_settings, monkeypatch, db_engine
):
    monkeypatch.setattr("app.services.locate_tools", lambda: None)
    with pytest.raises(ConfigurationError, match="ffmpeg"):
        build_services(make_settings(**AZURE_SPEECH))
    # The mock speech provider needs no external program.
    services = build_services(make_settings())
    services.engine.dispose()


# --- end-to-end job flow --------------------------------------------------------------------------


@pytest.fixture
def speech_client(
    make_settings: Callable[..., Settings], db_engine, audio_tools: AudioTools
) -> Iterator[Callable[..., tuple[TestClient, dict[str, list[httpx.Request]]]]]:
    clients: list[TestClient] = []

    def factory(*, speech_handler=speaking, translator_handler=vietnamese, **overrides):
        calls: dict[str, list[httpx.Request]] = {"translator": [], "speech": []}

        def translating(request: httpx.Request) -> httpx.Response:
            calls["translator"].append(request)
            return translator_handler(request)

        def synthesizing(request: httpx.Request) -> httpx.Response:
            calls["speech"].append(request)
            return speech_handler(request)

        settings = make_settings(**{**AZURE_BOTH, **overrides})
        services = build_services(
            settings,
            translation_transport=httpx.MockTransport(translating),
            speech_transport=httpx.MockTransport(synthesizing),
        )
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client, calls

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def test_meta_reports_real_translation_real_speech_and_mock_audio(speech_client):
    client, _ = speech_client()
    meta = client.get("/api/meta").json()
    assert meta["providers"] == {"translation": "azure", "speech": "azure", "audio": "mock"}
    assert meta["mock_mode"] is True  # audio processing is still a pass-through
    assert SPEECH_KEY not in json.dumps(meta)


def test_job_completes_with_real_translation_and_real_speech(speech_client, audio_tools):
    client, calls = speech_client()
    csrf = login(client)

    response = create_job(client, csrf, voice="EmmaMultilingual")
    assert response.status_code == 202
    job = wait_for_terminal(client, response.json()["id"], timeout=30)
    assert job["status"] == "completed", job

    result = client.get(f"/api/jobs/{job['id']}/result").json()
    assert result["translation"]["provider"] == "azure-translator"
    assert result["audio"]["is_fixture"] is False
    assert result["audio"]["provider"] == "azure-speech"
    assert result["audio"]["duration_adjusted"] is False
    notices = " ".join(result["notices"])
    assert "Azure Speech" in notices
    assert "has not been adjusted" in notices
    assert "fixed development fixture" not in notices

    # The speech request carries the translated text (not the English transcript) and the
    # voice the user chose.
    (speech_request,) = calls["speech"]
    assert ssml_voice(speech_request.content).get("name") == "en-US-EmmaMultilingualNeural"
    assert ssml_text(speech_request.content) == "Dịch: " + VALID_JOB["transcript"]
    languages = {language for language, _ in ssml_spans(speech_request.content)}
    assert languages == {"vi-VN", "en-US"}  # Spring Boot / Dependency Injection are English spans

    audio = client.get(result["audio"]["url"])
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/mpeg"
    assert audio.headers["cache-control"] == "private, no-store"
    path = client.app.state.services.result_store.get(uuid.UUID(job["id"]))
    assert probe_mp3(audio_tools, path.audio_path) > 0
    assert audio.content == path.audio_path.read_bytes()
    download = client.get(result["audio"]["download_url"])
    assert download.headers["content-disposition"].startswith("attachment")


def test_job_records_the_real_provider_names(speech_client, db_engine):
    client, _ = speech_client()
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf).json()["id"], timeout=30)
    with db_engine.connect() as conn:
        names = conn.exec_driver_sql(
            "SELECT translation_provider, speech_provider, audio_processor FROM jobs WHERE id = %s",
            (job["id"],),
        ).one()
    assert tuple(names) == ("azure-translator", "azure-speech", "mock-audio")


def test_mock_translation_with_real_speech_labels_each_component(speech_client):
    client, calls = speech_client(translation_provider="mock", azure_translator_key=None)
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf).json()["id"], timeout=30)
    assert job["status"] == "completed", job
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    assert result["translation"]["is_illustrative"] is True
    assert result["audio"]["provider"] == "azure-speech"
    assert calls["translator"] == []
    assert len(calls["speech"]) == 1


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "speech_auth_failed"),
        (429, "speech_quota_exceeded"),
        (503, "speech_service_error"),
    ],
)
def test_speech_errors_fail_the_job_without_retry_mock_fallback_or_partial_result(
    speech_client, status, code
):
    client, calls = speech_client(speech_handler=lambda request: httpx.Response(status))
    csrf = login(client)

    job = wait_for_terminal(client, create_job(client, csrf).json()["id"], timeout=30)

    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert len(calls["speech"]) == 1
    assert len(calls["translator"]) == 1
    result = client.get(f"/api/jobs/{job['id']}/result")
    assert result.status_code == 409
    assert result.json()["error"]["job_error_code"] == code
    assert SPEECH_KEY not in result.text


def test_job_work_files_are_removed_after_success_and_failure(speech_client):
    client, _ = speech_client()
    csrf = login(client)
    ok = wait_for_terminal(client, create_job(client, csrf).json()["id"], timeout=30)
    bad_client, _ = speech_client(speech_handler=lambda request: httpx.Response(429))
    bad_csrf = login(bad_client)
    bad = wait_for_terminal(bad_client, create_job(bad_client, bad_csrf).json()["id"], timeout=30)

    assert ok["status"] == "completed"
    assert bad["status"] == "failed"
    for job in (ok, bad):
        assert glob.glob(f"{tempfile.gettempdir()}/mydubb-job-{job['id']}-*") == []


def test_all_jobs_share_one_speech_rate_limiter(speech_client):
    client, _ = speech_client(azure_speech_max_requests_per_window=7)
    services = client.app.state.services
    assert services.speech_limiter is not None
    assert services.pipeline._speech._limiter is services.speech_limiter
