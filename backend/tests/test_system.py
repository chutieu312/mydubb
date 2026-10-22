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
    assert {v["id"]: v["provider_voice"] for v in body["voices"]} == {
        "HoaiMy": "vi-VN-HoaiMyNeural",
        "NamMinh": "vi-VN-NamMinhNeural",
    }


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
