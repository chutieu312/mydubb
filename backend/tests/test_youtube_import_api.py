"""POST /api/transcripts/youtube: configuration, security, the import flow and errors.

Supadata is a fake HTTP transport; nothing reaches the network and no credential is real.
"""

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text

from app.config import Settings, load_settings
from app.main import create_app
from app.services import build_services
from app.youtube_import.base import ImportFailure
from app.youtube_import.mock import MOCK_NO_ENGLISH_VIDEO_ID
from app.youtube_import.youtube_url import parse_youtube_url
from tests.conftest import COGNITO_SETTINGS, create_job, login, sign_in

KEY = "supadata-test-key-0123456789"
SUPADATA = {"youtube_import_provider": "supadata", "supadata_api_key": KEY}
URL = "https://youtu.be/dQw4w9WgXcQ"
ENDPOINT = "/api/transcripts/youtube"
TRANSCRIPT = {
    "content": [
        {"text": "Welcome back.", "offset": 10_480, "duration": 2000, "lang": "en"},
        {"text": "Gradient descent, step by step.", "offset": 12_960, "duration": 1500},
        {"text": "Bye!", "offset": 370_999, "duration": 9000, "lang": "en"},
    ],
    "lang": "en",
    "availableLangs": ["en"],
}


def supadata_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=TRANSCRIPT)


@pytest.fixture
def import_client(
    make_settings: Callable[..., Settings], db_engine
) -> Iterator[Callable[..., tuple[TestClient, list[httpx.Request]]]]:
    clients: list[TestClient] = []

    def factory(handler=supadata_ok, **overrides):
        calls: list[httpx.Request] = []

        def recording(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return handler(request)

        settings = make_settings(**{**SUPADATA, **overrides})
        services = build_services(settings, youtube_import_transport=httpx.MockTransport(recording))
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client, calls

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def post(client: TestClient, csrf: str | None, body: object, **headers: str) -> httpx.Response:
    if csrf is not None:
        headers["X-CSRF-Token"] = csrf
    return client.post(ENDPOINT, json=body, headers=headers)


# --- configuration --------------------------------------------------------------------------------


def test_the_import_is_off_by_default_and_pasting_still_works(client, db_engine):
    meta = client.get("/api/meta").json()
    assert meta["youtube_import"] == {"enabled": False, "provider": None}
    # Pipeline reporting is unchanged by the import.
    assert set(meta["providers"]) == {"translation", "speech", "audio"}
    csrf = login(client)
    response = post(client, csrf, {"url": URL})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "youtube_import_disabled"
    assert create_job(client, csrf).status_code == 202


def test_meta_reports_the_import_provider(import_client, make_client):
    client, _ = import_client()
    assert client.get("/api/meta").json()["youtube_import"] == {
        "enabled": True,
        "provider": "supadata",
    }
    mock = make_client(youtube_import_provider="mock")
    assert mock.get("/api/meta").json()["youtube_import"] == {"enabled": True, "provider": "mock"}


def test_supadata_without_a_key_does_not_start(make_settings):
    with pytest.raises(ValidationError, match="SUPADATA_API_KEY is required"):
        make_settings(youtube_import_provider="supadata")
    with pytest.raises(ValidationError, match="SUPADATA_API_KEY is required"):
        make_settings(youtube_import_provider="supadata", supadata_api_key="")
    with pytest.raises(ValidationError, match="printable ASCII"):
        make_settings(youtube_import_provider="supadata", supadata_api_key="has space")


def test_a_key_alone_does_not_enable_the_import(make_settings):
    settings = make_settings(supadata_api_key=KEY)
    assert settings.youtube_import_provider.value == "off"


def test_the_mock_is_refused_in_production(make_settings):
    production = {"app_env": "production", "access_code": "x" * 32, "cookie_secure": True}
    production["allow_mock_providers_in_production"] = True
    with pytest.raises(ValidationError, match="YOUTUBE_IMPORT_PROVIDER=mock is not allowed"):
        make_settings(youtube_import_provider="mock", **production)
    assert make_settings(**SUPADATA, **production).youtube_import_provider.value == "supadata"


def test_the_key_never_appears_in_settings_text_or_configuration_errors(make_settings, monkeypatch):
    settings = make_settings(**SUPADATA)
    assert KEY not in repr(settings) + str(settings)
    monkeypatch.setenv("YOUTUBE_IMPORT_PROVIDER", "supadata")
    monkeypatch.setenv("SUPADATA_API_KEY", KEY)
    monkeypatch.setenv("SUPADATA_DEADLINE_SECONDS", "1")  # invalid: below the minimum
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/db")
    monkeypatch.setenv("ACCESS_CODE", "x" * 20)
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("PROVIDER_MODE", "mock")
    with pytest.raises(RuntimeError) as error:
        load_settings()
    assert KEY not in str(error.value)
    assert "SUPADATA_DEADLINE_SECONDS" in str(error.value)


# --- authentication, CSRF, origin -----------------------------------------------------------------


def test_anonymous_imports_are_refused_before_anything_is_sent(import_client):
    client, calls = import_client()
    response = post(client, None, {"url": URL})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "not_authenticated"
    # Also with a body the server would refuse: the session is checked first.
    assert post(client, None, {"url": "nonsense"}).status_code == 401
    assert calls == []


def test_csrf_is_required(import_client):
    client, calls = import_client()
    login(client)
    for csrf in (None, "wrong-token"):
        response = post(client, csrf, {"url": URL})
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "csrf_failed"
    assert calls == []


def test_cross_origin_requests_are_refused(import_client):
    client, calls = import_client()
    csrf = login(client)
    response = post(client, csrf, {"url": URL}, Origin="https://evil.example")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "origin_rejected"
    assert calls == []
    assert post(client, csrf, {"url": URL}, Origin="http://testserver").status_code == 200


def test_get_is_not_an_import(import_client):
    client, calls = import_client()
    login(client)
    assert client.get(ENDPOINT, params={"url": URL}).status_code == 405
    assert calls == []


def test_a_signed_in_cognito_user_can_import(make_settings, fake_cognito, db_engine):
    services_calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        services_calls.append(request)
        return supadata_ok(request)

    services = build_services(
        make_settings(**COGNITO_SETTINGS, **SUPADATA),
        youtube_import_transport=httpx.MockTransport(recording),
        cognito_client=fake_cognito,
    )
    with TestClient(create_app(services=services)) as importing:
        fake_cognito.add_user("lan@example.com", "Correct-horse-1")
        assert post(importing, None, {"url": URL}).status_code == 401
        csrf = sign_in(importing, "lan@example.com", "Correct-horse-1")["csrf_token"]
        response = post(importing, csrf, {"url": URL})
        assert response.status_code == 200, response.text
    assert len(services_calls) == 1


# --- validation -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtube.com.example.org/watch?v=dQw4w9WgXcQ",
        "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/playlist?list=PL9tY0BWXOZFuFEG_GtOBZ8-8wbkH-NVAr",
        "https://example.org/video.mp4",
        "dQw4w9WgXcQ",
        "",
    ],
)
def test_invalid_links_are_a_422_on_the_url_field_and_nothing_is_sent(import_client, url):
    client, calls = import_client()
    csrf = login(client)
    response = post(client, csrf, {"url": url})
    assert response.status_code == 422
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    assert [f["field"] for f in body["fields"]] == ["url"]
    assert calls == []


@pytest.mark.parametrize("body", [{}, {"url": 123}, {"url": None}, {"url": ["x"]}, [URL], URL])
def test_malformed_bodies_are_refused(import_client, body):
    client, calls = import_client()
    csrf = login(client)
    assert post(client, csrf, body).status_code == 422
    assert calls == []


# --- the import -----------------------------------------------------------------------------------


def test_an_import_returns_the_timestamped_transcript_and_creates_no_job(import_client, db_engine):
    client, calls = import_client()
    csrf = login(client)
    response = post(client, csrf, {"url": f"{URL}?si=share&t=4"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "transcript": (
            "0:10.480\nWelcome back.\n0:12.960\nGradient descent, step by step.\n6:10.999\nBye!"
        ),
        "language": "en",
        "caption_count": 3,
        "skipped_empty_captions": 0,
        "first_caption_start_ms": 10_480,
        "last_caption_start_ms": 370_999,
        # Caption starts truncated to seconds; not the end of the last caption.
        "first_sentence_start": "00:00:10",
        "last_sentence_start": "00:06:10",
        "provider": "supadata",
    }
    (request,) = calls
    assert request.url.params["url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert request.url.params["mode"] == "native"
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar() == 0


def test_the_imported_transcript_can_be_edited_and_submitted_as_a_job(import_client):
    client, _ = import_client()
    csrf = login(client)
    imported = post(client, csrf, {"url": URL}).json()
    edited = imported["transcript"].replace("Bye!", "Goodbye, everyone!")
    response = create_job(
        client,
        csrf,
        transcript=edited,
        first_sentence_start=imported["first_sentence_start"],
        last_sentence_start=imported["last_sentence_start"],
    )
    assert response.status_code == 202, response.text
    assert response.json()["target_duration_seconds"] == 360


def test_captions_without_two_different_start_seconds_suggest_no_times(import_client):
    def same_second(request: httpx.Request) -> httpx.Response:
        content = [
            {"text": "a", "offset": 4100, "duration": 1},
            {"text": "b", "offset": 4900, "duration": 1},
        ]
        return httpx.Response(200, json={**TRANSCRIPT, "content": content})

    client, _ = import_client(same_second)
    body = post(client, login(client), {"url": URL}).json()
    assert body["transcript"] == "0:04.100\na\n0:04.900\nb"
    assert body["first_sentence_start"] is None and body["last_sentence_start"] is None


def test_the_mock_provider_returns_its_fixture_or_a_missing_language(make_client):
    client = make_client(youtube_import_provider="mock")
    csrf = login(client)
    body = post(client, csrf, {"url": URL}).json()
    assert body["provider"] == "mock"
    assert body["skipped_empty_captions"] == 1
    assert body["transcript"].startswith("0:00.480\nWelcome back.")
    response = post(client, csrf, {"url": f"https://youtu.be/{MOCK_NO_ENGLISH_VIDEO_ID}"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "youtube_import_no_english_captions"


# --- errors ---------------------------------------------------------------------------------------


def respond(status: int, body: object | None = None, **headers: str):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, headers=headers)

    return handler


@pytest.mark.parametrize(
    ("handler", "status", "code"),
    [
        (respond(200, {**TRANSCRIPT, "lang": "es"}), 422, "youtube_import_no_english_captions"),
        (
            respond(206, {"error": "transcript-unavailable"}),
            422,
            "youtube_import_no_english_captions",
        ),
        (respond(403, {"error": "forbidden"}), 422, "youtube_import_video_unavailable"),
        (respond(404, {"error": "not-found"}), 422, "youtube_import_video_unavailable"),
        (respond(200, {**TRANSCRIPT, "content": []}), 422, "youtube_import_empty_captions"),
        (respond(401, {"error": "unauthorized"}), 502, "youtube_import_auth_failed"),
        (respond(402, {"error": "upgrade-required"}), 502, "youtube_import_rejected"),
        (
            respond(429, {"error": "limit-exceeded", "details": "Plan usage limit was exceeded."}),
            503,
            "youtube_import_quota_exceeded",
        ),
        (respond(429, {"error": "limit-exceeded"}), 503, "youtube_import_rate_limited"),
        (respond(500, {"error": "internal-error"}), 502, "youtube_import_service_error"),
        (
            respond(200, {"content": "plain text", "lang": "en"}),
            502,
            "youtube_import_invalid_response",
        ),
    ],
)
def test_provider_problems_become_safe_errors(import_client, handler, status, code):
    client, calls = import_client(handler)
    csrf = login(client)
    response = post(client, csrf, {"url": URL})
    assert response.status_code == status
    error = response.json()["error"]
    assert error["code"] == code
    assert set(error) == {"code", "message"}
    assert KEY not in response.text and "supadata.ai" not in response.text
    assert len(calls) == 1


def test_a_provider_401_leaves_the_session_signed_in(import_client):
    client, _ = import_client(respond(401, {"error": "unauthorized", "details": KEY}))
    csrf = login(client)
    response = post(client, csrf, {"url": URL})
    assert response.status_code == 502
    assert KEY not in response.text
    assert client.get("/api/session").status_code == 200


def test_rate_limits_and_a_full_server_say_when_to_try_again(import_client):
    client, _ = import_client(respond(429, {"error": "limit-exceeded"}))
    response = post(client, login(client), {"url": URL})
    assert response.headers["Retry-After"] == "5"


def test_a_timeout_is_a_504_and_the_import_is_not_retried(import_client):
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    client, calls = import_client(slow)
    response = post(client, login(client), {"url": URL})
    assert response.status_code == 504
    assert response.json()["error"]["code"] == "youtube_import_timeout"
    assert len(calls) == 1


def test_imports_over_the_concurrency_limit_are_refused_not_queued(import_client):
    entered = threading.Event()
    release = threading.Event()

    def blocking(request: httpx.Request) -> httpx.Response:
        entered.set()
        release.wait(10)
        return supadata_ok(request)

    client, calls = import_client(blocking, youtube_import_max_concurrent=1)
    csrf = login(client)
    with ThreadPoolExecutor(1) as pool:
        first = pool.submit(post, client, csrf, {"url": URL})
        assert entered.wait(10)
        second = post(client, csrf, {"url": URL})
        assert second.status_code == 503
        assert second.json()["error"]["code"] == "youtube_import_busy"
        assert second.headers["Retry-After"] == "10"
        release.set()
        assert first.result(timeout=10).status_code == 200
    # The refused import never reached the provider; the slot is free again afterwards.
    assert len(calls) == 1
    assert post(client, csrf, {"url": URL}).status_code == 200


def test_shutdown_stops_the_import_provider(make_settings, db_engine):
    services = build_services(
        make_settings(**SUPADATA), youtube_import_transport=httpx.MockTransport(supadata_ok)
    )
    with TestClient(create_app(services=services)):
        pass
    assert services.youtube_import is not None
    with pytest.raises(ImportFailure) as stopped:
        services.youtube_import.import_captions(parse_youtube_url(URL))
    assert stopped.value.code == "youtube_import_cancelled"
