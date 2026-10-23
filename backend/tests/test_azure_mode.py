"""Azure translation + mock speech/audio: configuration, labels and the job flow (fake HTTP)."""

import json
from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings, load_settings
from app.main import create_app
from app.services import build_services
from app.translation.mock import ILLUSTRATIVE_NOTICE
from tests.conftest import VALID_JOB, create_job, login, wait_for_terminal

KEY = "integration-test-key-0123456789"
AZURE = {"translation_provider": "azure", "azure_translator_key": KEY}


def vietnamese(request: httpx.Request) -> httpx.Response:
    items = json.loads(request.content)
    return httpx.Response(
        200,
        json=[{"translations": [{"text": "Dịch: " + i["Text"], "to": "vi"}]} for i in items],
    )


@pytest.fixture
def azure_client(
    make_settings: Callable[..., Settings], db_engine
) -> Iterator[Callable[..., tuple[TestClient, list[httpx.Request]]]]:
    clients: list[TestClient] = []

    def factory(handler=vietnamese, **overrides):
        calls: list[httpx.Request] = []

        def recording(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return handler(request)

        settings = make_settings(**{**AZURE, **overrides})
        services = build_services(settings, translation_transport=httpx.MockTransport(recording))
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client, calls

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


# --- configuration ------------------------------------------------------------------------------


def test_default_configuration_is_all_mock(client):
    meta = client.get("/api/meta").json()
    assert meta["mock_mode"] is True
    assert meta["providers"] == {"translation": "mock", "speech": "mock", "audio": "mock"}


def test_azure_translation_with_mock_speech_and_audio_is_reported_per_component(azure_client):
    client, _ = azure_client()
    meta = client.get("/api/meta").json()
    assert meta["provider_mode"] == "mock"
    assert meta["mock_mode"] is True  # speech and audio are still mock
    assert meta["providers"] == {"translation": "azure", "speech": "mock", "audio": "mock"}
    assert KEY not in json.dumps(meta)


@pytest.mark.parametrize(
    "overrides",
    [
        {"azure_translator_key": None},
        {"azure_translator_key": ""},
        {"azure_translator_key": "has space"},
        {"azure_translator_key": "k\nnewline"},
        {"azure_translator_region": "west us"},
        {"azure_translator_endpoint": "http://api.cognitive.microsofttranslator.com"},
        {"azure_translator_endpoint": "https://user:pw@api.cognitive.microsofttranslator.com"},
        {"azure_translator_endpoint": "https://api.cognitive.microsofttranslator.com/x?a=b"},
        {"azure_translator_endpoint": "not a url"},
        {"mock_fail_stage": "translation"},
        {"mock_fail_stage": "unexpected"},
        {"azure_translator_timeout_seconds": 0},
        {"azure_translator_max_request_chars": 50_001},
    ],
)
def test_azure_translation_credentials_are_validated(make_settings, overrides):
    with pytest.raises(ValidationError):
        make_settings(**{**AZURE, **overrides})


def test_azure_credentials_are_not_required_while_translation_is_mock(make_settings):
    settings = make_settings(azure_translator_endpoint="http://invalid")
    assert settings.component_providers["translation"] == "mock"


def test_other_mock_failure_stages_still_work_with_azure_translation(make_settings):
    assert make_settings(**AZURE, mock_fail_stage="speech").mock_fail_stage == "speech"


def test_provider_mode_azure_is_refused_while_speech_and_audio_are_mock(make_settings):
    with pytest.raises(ValidationError, match="SPEECH_PROVIDER=azure, AUDIO_PROCESSOR=ffmpeg"):
        make_settings(provider_mode="azure", **AZURE)


def test_production_with_azure_translation_still_needs_the_mock_opt_in(make_settings):
    production = {"app_env": "production", "access_code": "x" * 32, "cookie_secure": True}
    with pytest.raises(ValidationError, match="Mock providers"):
        make_settings(**AZURE, **production)
    settings = make_settings(**AZURE, **production, allow_mock_providers_in_production=True)
    assert settings.component_providers["translation"] == "azure"


def test_the_key_never_appears_in_settings_text_or_configuration_errors(make_settings, monkeypatch):
    assert KEY not in repr(make_settings(**AZURE)) + str(make_settings(**AZURE))

    monkeypatch.setenv("TRANSLATION_PROVIDER", "azure")
    monkeypatch.setenv("AZURE_TRANSLATOR_KEY", KEY)
    monkeypatch.setenv("AZURE_TRANSLATOR_ENDPOINT", "http://insecure.example")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/db")
    monkeypatch.setenv("ACCESS_CODE", "x" * 20)
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("PROVIDER_MODE", "mock")
    with pytest.raises(RuntimeError) as error:
        load_settings()
    assert KEY not in str(error.value)
    assert "AZURE_TRANSLATOR_ENDPOINT" in str(error.value)


# --- end-to-end job flow --------------------------------------------------------------------------


def test_job_completes_with_real_translation_and_mock_audio(azure_client):
    client, calls = azure_client()
    csrf = login(client)

    response = create_job(client, csrf)
    assert response.status_code == 202
    job = wait_for_terminal(client, response.json()["id"])
    assert job["status"] == "completed", job

    result = client.get(f"/api/jobs/{job['id']}/result").json()
    assert result["translation"]["provider"] == "azure-translator"
    assert result["translation"]["is_illustrative"] is False
    assert result["translation"]["text"] == "Dịch: " + VALID_JOB["transcript"]
    assert result["audio"]["is_fixture"] is True
    assert result["audio"]["duration_adjusted"] is False
    notices = " ".join(result["notices"])
    assert "Azure Translator" in notices
    assert "glossary" in notices
    assert "fixed development fixture" in notices
    assert ILLUSTRATIVE_NOTICE not in result["notices"]
    assert "illustrative mock" not in notices

    assert len(calls) == 1
    sent = json.loads(calls[0].content)[0]["Text"]
    assert 'class="notranslate">Spring Boot<' in sent
    assert 'class="notranslate">Dependency Injection<' in sent


def test_mock_jobs_keep_their_existing_labels(client):
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf).json()["id"])
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    assert result["translation"]["provider"] == "mock-translation"
    assert result["translation"]["is_illustrative"] is True
    assert any("illustrative mock content" in n for n in result["notices"])
    assert not any("Azure" in n for n in result["notices"])


def test_job_records_the_translation_provider_name(azure_client, db_engine):
    client, _ = azure_client()
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf).json()["id"])
    with db_engine.connect() as conn:
        names = conn.exec_driver_sql(
            "SELECT translation_provider, speech_provider, audio_processor FROM jobs WHERE id = %s",
            (job["id"],),
        ).one()
    assert tuple(names) == ("azure-translator", "mock-speech", "mock-audio")


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "translation_auth_failed"),
        (429, "translation_quota_exceeded"),
        (503, "translation_service_error"),
    ],
)
def test_provider_errors_fail_the_job_without_retry_mock_fallback_or_partial_result(
    azure_client, status, code
):
    client, calls = azure_client(lambda request: httpx.Response(status, json={"error": {}}))
    csrf = login(client)

    job = wait_for_terminal(client, create_job(client, csrf).json()["id"])

    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert len(calls) == 1
    result = client.get(f"/api/jobs/{job['id']}/result")
    assert result.status_code == 409
    assert result.json()["error"]["job_error_code"] == code
    assert "(VI mock)" not in result.text


def test_a_provider_timeout_fails_the_job_with_a_clear_error(azure_client):
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow")

    client, calls = azure_client(slow)
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf).json()["id"])
    assert job["error"]["code"] == "translation_timeout"
    assert "submit again" in job["error"]["message"]
    assert len(calls) == 1


def test_damaged_terms_fail_the_job(azure_client):
    def lossy(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"translations": [{"text": "Mất thuật ngữ", "to": "vi"}]}])

    client, _ = azure_client(lossy)
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf).json()["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "translation_terms_not_preserved"
