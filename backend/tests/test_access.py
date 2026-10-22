from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from tests.conftest import ACCESS_CODE, VALID_JOB, create_job, login

JOB_ID = "00000000-0000-0000-0000-000000000001"


def test_incorrect_access_code_is_rejected_without_session(client):
    response = client.post("/api/session", json={"access_code": "wrong-code-123"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_access_code"
    assert "set-cookie" not in response.headers
    assert client.get("/api/session").status_code == 401


def test_valid_code_establishes_httponly_strict_session(client):
    response = client.post("/api/session", json={"access_code": ACCESS_CODE})
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert "mydubb_session=" in cookie
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    # The Access Code itself is never echoed back.
    assert ACCESS_CODE not in response.text

    session = client.get("/api/session")
    assert session.status_code == 200
    assert session.json()["csrf_token"] == response.json()["csrf_token"]


def test_secure_cookie_flag_when_configured(make_client):
    client = make_client(cookie_secure=True)
    response = client.post("/api/session", json={"access_code": ACCESS_CODE})
    assert "secure" in response.headers["set-cookie"].lower()


def test_valid_session_can_access_protected_apis(client):
    csrf = login(client)
    created = create_job(client, csrf)
    assert created.status_code == 202
    assert client.get(f"/api/jobs/{created.json()['id']}").status_code == 200


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/jobs"),
        ("get", f"/api/jobs/{JOB_ID}"),
        ("get", f"/api/jobs/{JOB_ID}/result"),
        ("get", f"/api/jobs/{JOB_ID}/result/audio"),
        ("delete", "/api/session"),
    ],
)
def test_unauthenticated_requests_are_rejected(client, method, path):
    kwargs = {"json": VALID_JOB} if method == "post" else {}
    response = getattr(client, method)(path, **kwargs)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "not_authenticated"


def test_expired_session_is_rejected(client, db_engine):
    csrf = login(client)
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE access_sessions SET expires_at = :t"),
            {"t": datetime.now(UTC) - timedelta(seconds=1)},
        )
    assert client.get("/api/session").status_code == 401
    assert create_job(client, csrf).status_code == 401


def test_logged_out_session_is_rejected_even_if_cookie_is_replayed(client):
    csrf = login(client)
    cookie = client.cookies.get("mydubb_session")
    response = client.delete("/api/session", headers={"X-CSRF-Token": csrf})
    assert response.status_code == 204

    client.cookies.set("mydubb_session", cookie)
    assert client.get("/api/session").status_code == 401
    assert create_job(client, csrf).status_code == 401


def test_state_changing_requests_require_csrf_token(client):
    csrf = login(client)
    missing = client.post("/api/jobs", json=VALID_JOB)
    assert missing.status_code == 403
    assert missing.json()["error"]["code"] == "csrf_failed"
    wrong = client.post("/api/jobs", json=VALID_JOB, headers={"X-CSRF-Token": "nope"})
    assert wrong.status_code == 403
    assert client.delete("/api/session").status_code == 403
    # The session survived the rejected logout.
    assert create_job(client, csrf).status_code == 202


def test_cross_origin_state_changing_requests_are_rejected(client):
    response = client.post(
        "/api/session",
        json={"access_code": ACCESS_CODE},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "origin_rejected"

    same_origin = client.post(
        "/api/session", json={"access_code": ACCESS_CODE}, headers={"Origin": "http://testserver"}
    )
    assert same_origin.status_code == 200


def test_trusted_dev_origin_is_allowed(make_client):
    client = make_client(trusted_origins=["http://localhost:5173"])
    response = client.post(
        "/api/session",
        json={"access_code": ACCESS_CODE},
        headers={"Origin": "http://localhost:5173"},
    )
    assert response.status_code == 200


def test_brute_force_attempts_are_throttled(make_client):
    client = make_client(access_max_failures_per_client=3)
    for _ in range(3):
        assert client.post("/api/session", json={"access_code": "wrong-guess"}).status_code == 401

    blocked = client.post("/api/session", json={"access_code": ACCESS_CODE})
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "too_many_attempts"
    assert int(blocked.headers["retry-after"]) > 0


def test_brute_force_limit_uses_the_configured_client_ip_header(make_client):
    client = make_client(access_max_failures_per_client=2, client_ip_header="cf-connecting-ip")

    def attempt(edge_ip: str, spoofed_xff: str):
        return client.post(
            "/api/session",
            json={"access_code": "wrong-guess"},
            headers={"CF-Connecting-IP": edge_ip, "X-Forwarded-For": spoofed_xff},
        )

    # Rotating a client-controlled X-Forwarded-For does not reset the per-client limit.
    assert attempt("203.0.113.7", "10.0.0.1").status_code == 401
    assert attempt("203.0.113.7", "10.0.0.2").status_code == 401
    assert attempt("203.0.113.7", "10.0.0.3").status_code == 429
    # Another real client is unaffected.
    assert attempt("198.51.100.9", "10.0.0.3").status_code == 401
