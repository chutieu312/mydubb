"""Test fixtures.

Database tests run against a real PostgreSQL database given by TEST_DATABASE_URL.
The suite drops and recreates the `public` schema of that database, so never point it
at a database whose data matters.
"""

import base64
import os
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text

from app.audio.ffmpeg import AudioTools, locate_tools
from app.config import Settings, to_sqlalchemy_url
from app.main import create_app
from app.services import build_services
from tests.fake_cognito import FakeCognito

BACKEND_DIR = Path(__file__).resolve().parent.parent
ACCESS_CODE = "correct-access-code"
TEST_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()
COGNITO_SETTINGS: dict[str, Any] = {
    "auth_mode": "cognito",
    "access_code": None,
    "cognito_region": "us-west-2",
    "cognito_user_pool_id": "us-west-2_TestPool1",
    "cognito_client_id": "testclientid123",
    "auth_token_encryption_key": TEST_ENCRYPTION_KEY,
}

VALID_JOB = {
    "transcript": "Spring Boot uses Dependency Injection to automatically manage objects.",
    "first_sentence_start": "00:00:10",
    "last_sentence_start": "00:06:10",
    "voice": "AndrewMultilingual",
}


def _test_database_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.fail(
            "TEST_DATABASE_URL is not set. Database tests require PostgreSQL "
            "(e.g. postgresql://mydubb:mydubb_local@127.0.0.1:5432/mydubb_test).",
            pytrace=False,
        )
    return url


def alembic_config(database_url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.attributes["database_url"] = database_url
    return config


@pytest.fixture(scope="session")
def database_url() -> str:
    return _test_database_url()


@pytest.fixture(scope="session")
def engine(database_url: str) -> Iterator[Engine]:
    eng = create_engine(to_sqlalchemy_url(database_url))
    with eng.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    command.upgrade(alembic_config(database_url), "head")
    yield eng
    eng.dispose()


@pytest.fixture
def db_engine(engine: Engine) -> Engine:
    """A migrated database with empty tables."""
    with engine.begin() as conn:
        conn.execute(
            text(
                "TRUNCATE jobs, access_sessions, glossary_candidates, users, user_sessions, "
                "password_reset_attempts, "
                "auth_challenges, password_reset_events"
            )
        )
    return engine


@pytest.fixture
def make_settings(database_url: str, tmp_path: Path) -> Callable[..., Settings]:
    def factory(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "app_env": "test",
            "database_url": database_url,
            "access_code": ACCESS_CODE,
            "provider_mode": "mock",
            "cookie_secure": False,  # TestClient talks plain HTTP
            "result_storage_dir": tmp_path / "results",
            "cleanup_interval_seconds": 3600,
            # Tests that need shutdown draining set this explicitly.
            "job_shutdown_grace_seconds": 0,
        }
        values.update(overrides)
        return Settings(_env_file=None, **values)  # type: ignore[call-arg]

    return factory


@pytest.fixture
def make_client(
    db_engine: Engine, make_settings: Callable[..., Settings]
) -> Iterator[Callable[..., TestClient]]:
    """Start app instances (running lifespan startup/shutdown) with settings overrides."""
    clients: list[TestClient] = []

    def factory(**overrides: Any) -> TestClient:
        client = TestClient(create_app(make_settings(**overrides)))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client()


@pytest.fixture
def fake_cognito() -> FakeCognito:
    return FakeCognito()


@pytest.fixture
def make_cognito_client(
    db_engine: Engine, make_settings: Callable[..., Settings], fake_cognito: FakeCognito
) -> Iterator[Callable[..., TestClient]]:
    """App instances in AUTH_MODE=cognito sharing one fake user pool and the test database."""
    clients: list[TestClient] = []

    def factory(**overrides: Any) -> TestClient:
        settings = make_settings(**{**COGNITO_SETTINGS, **overrides})
        client = TestClient(
            create_app(services=build_services(settings, cognito_client=fake_cognito))
        )
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


@pytest.fixture
def cognito_client(make_cognito_client: Callable[..., TestClient]) -> TestClient:
    return make_cognito_client()


def sign_in(client: TestClient, email: str, password: str) -> dict:
    """Sign in a verified, confirmed user; returns the `authenticated` body."""
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "authenticated", body
    return body


def login(client: TestClient, code: str = ACCESS_CODE) -> str:
    response = client.post("/api/session", json={"access_code": code})
    assert response.status_code == 200, response.text
    return response.json()["csrf_token"]


def create_job(client: TestClient, csrf: str, **overrides: Any):
    return client.post("/api/jobs", json={**VALID_JOB, **overrides}, headers={"X-CSRF-Token": csrf})


def wait_for_terminal(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(f"/api/jobs/{job_id}").json()
        if body["status"] in ("completed", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Job {job_id} did not reach a terminal state")


@pytest.fixture(scope="session")
def audio_tools() -> AudioTools:
    """Real ffmpeg/ffprobe. CI must have them (a missing tool fails there instead of skipping)."""
    tools = locate_tools()
    if tools is None:
        message = "ffmpeg and ffprobe are not installed"
        if os.environ.get("CI"):
            pytest.fail(message, pytrace=False)
        pytest.skip(message)
    return tools
