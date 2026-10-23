import pytest
from alembic import command
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import inspect

from app.config import Settings
from app.main import create_app
from tests.conftest import alembic_config


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readiness_reports_database_ok(client):
    response = client.get("/api/ready")
    assert response.status_code == 200
    assert response.json()["checks"]["database"] == "ok"


def test_readiness_fails_without_leaking_connection_details(make_settings):
    url = "postgresql://user:super-secret-password@127.0.0.1:1/nowhere"
    app = create_app(make_settings(database_url=url, db_connect_timeout_seconds=2))
    response = TestClient(app).get("/api/ready")  # no lifespan: DB is unreachable
    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "checks": {"database": "unavailable"}}
    assert "super-secret-password" not in response.text


def test_meta_announces_mock_mode_and_voices(client):
    body = client.get("/api/meta").json()
    assert body["mock_mode"] is True
    # Order matters: the first voice is the default shown selected by the UI.
    assert body["voices"] == [
        {
            "id": "AndrewMultilingual",
            "label": "Andrew Multilingual",
            "provider_voice": "en-US-AndrewMultilingualNeural",
            "description": "Male",
        },
        {
            "id": "EmmaMultilingual",
            "label": "Emma Multilingual",
            "provider_voice": "en-US-EmmaMultilingualNeural",
            "description": "Female",
        },
    ]


def test_api_responses_carry_security_headers(client):
    response = client.get("/api/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"database_url": "sqlite:///local.db"},
        {"provider_mode": "azure"},
        {"app_env": "production", "access_code": "x" * 32},  # mock mode in production
        {"access_code": "short"},
    ],
)
def test_unsafe_configuration_is_refused(make_settings, overrides):
    with pytest.raises(ValidationError):
        make_settings(**overrides)


def test_production_requires_secure_cookies(make_settings):
    with pytest.raises(ValidationError, match="COOKIE_SECURE"):
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            app_env="production",
            database_url="postgresql://u:p@127.0.0.1/db",
            access_code="x" * 32,
            provider_mode="mock",
            cookie_secure=False,
        )


def test_serves_frontend_build_on_same_origin(make_client, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>MyDubb</title>")
    (dist / "assets" / "app-123.js").write_text("console.log('x')")
    (tmp_path / "secret.txt").write_text("outside-dist-secret")
    client = make_client(frontend_dist_dir=dist)

    assert "MyDubb" in client.get("/").text
    assert "MyDubb" in client.get("/some/client/route").text  # SPA fallback
    asset = client.get("/assets/app-123.js")
    assert "immutable" in asset.headers["cache-control"]
    for traversal in ("/..%2Fsecret.txt", "/assets/..%2F..%2Fsecret.txt"):
        assert "outside-dist-secret" not in client.get(traversal).text
    unknown_api = client.get("/api/does-not-exist")
    assert unknown_api.status_code == 404
    assert unknown_api.json()["error"]["code"] == "not_found"


def test_migrations_downgrade_and_upgrade_on_empty_schema(engine, database_url):
    config = alembic_config(database_url)
    command.downgrade(config, "base")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}
    command.upgrade(config, "head")
    assert {"access_sessions", "jobs"} <= set(inspect(engine).get_table_names())


PRODUCTION = {
    "app_env": "production",
    "cookie_secure": True,
    "access_code": "a-production-access-code-0123456789",
}


def test_production_refuses_mock_providers_without_explicit_opt_in(make_settings):
    with pytest.raises(ValidationError, match="ALLOW_MOCK_PROVIDERS_IN_PRODUCTION"):
        make_settings(**PRODUCTION)


def test_production_mock_beta_with_explicit_opt_in(make_client):
    client = make_client(**PRODUCTION, allow_mock_providers_in_production=True)

    meta = client.get("/api/meta").json()
    assert meta["mock_mode"] is True  # the UI keeps showing the mock banner
    response = client.post("/api/session", json={"access_code": PRODUCTION["access_code"]})
    assert "secure" in response.headers["set-cookie"].lower()
    assert client.get("/api/health").headers["strict-transport-security"] == "max-age=31536000"
    assert client.get("/api/docs").status_code == 404


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"cookie_secure": False}, "COOKIE_SECURE"),
        ({"mock_fail_stage": "speech"}, "MOCK_FAIL_STAGE"),
        ({"access_code": "only-fifteen-ch"}, "at least 16 characters"),
    ],
)
def test_opt_in_keeps_every_other_production_rule(make_settings, overrides, message):
    with pytest.raises(ValidationError, match=message):
        make_settings(**{**PRODUCTION, **overrides}, allow_mock_providers_in_production=True)


def test_no_hsts_outside_production(client):
    assert "strict-transport-security" not in client.get("/api/health").headers


def test_stale_threshold_must_exceed_heartbeat_interval(make_settings):
    with pytest.raises(ValidationError, match="JOB_STALE_AFTER_SECONDS"):
        make_settings(job_heartbeat_interval_seconds=30, job_stale_after_seconds=60)


def test_configuration_errors_never_include_secret_values(monkeypatch, tmp_path):
    from app.config import ConfigurationError, load_settings

    monkeypatch.chdir(tmp_path)  # no local .env file
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "mysql://user:TOPSECRET-DB-PASSWORD@host/db")
    monkeypatch.setenv("ACCESS_CODE", "TOPSEC7")  # too short: rejected with its field
    monkeypatch.setenv("PROVIDER_MODE", "mock")

    with pytest.raises(ConfigurationError) as caught:
        load_settings()

    message = str(caught.value)
    assert "DATABASE_URL" in message and "ACCESS_CODE" in message
    assert "TOPSEC" not in message
    assert caught.value.__cause__ is None and caught.value.__suppress_context__
