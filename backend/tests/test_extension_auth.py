"""Connecting the Chrome extension (Authorization Code + PKCE) and its bearer token on the job
endpoints, against the fake user pool. docs/EXTENSION_AUTH.md.

The website side (sign-in, approval) is a cookie client; the extension is a separate client with
no cookies that sends `Origin: chrome-extension://<id>` like Chrome does.
"""

import base64
import hashlib
import io
import secrets
from collections.abc import Callable
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from app.auth.service import delete_stale_auth_rows
from app.config import Settings
from app.dependencies import AUTH_COOKIE
from tests.conftest import COGNITO_SETTINGS, VALID_JOB, sign_in, wait_for_terminal
from tests.test_guest_access import GUEST_SETTINGS, IP_HEADER, start_guest

EMAIL = "lan@example.com"
PASSWORD = "correct-horse-1"
OTHER_EMAIL = "minh@example.com"
EXT_ID = "abcdefghijklmnopabcdefghijklmnop"
OTHER_EXT_ID = "ponmlkjihgfedcbaponmlkjihgfedcba"
EXT_ORIGIN = f"chrome-extension://{EXT_ID}"
REDIRECT = f"https://{EXT_ID}.chromiumapp.org/"
MISMATCH = "redirect_uri_mismatch"


def _verifier() -> str:
    return secrets.token_urlsafe(48)


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


@pytest.fixture
def make_ext_client(make_cognito_client) -> Callable[..., TestClient]:
    return lambda **overrides: make_cognito_client(**{"extension_ids": [EXT_ID], **overrides})


@pytest.fixture
def web(make_ext_client, fake_cognito) -> TestClient:
    fake_cognito.add_user(EMAIL, PASSWORD, name="Lan")
    return make_ext_client()


@pytest.fixture
def ext(make_ext_client) -> TestClient:
    """The extension: no cookie jar shared with the website."""
    return make_ext_client()


def _authorize(web: TestClient, csrf: str, verifier: str, **overrides: Any):
    body = {
        "client_id": EXT_ID,
        "redirect_uri": REDIRECT,
        "state": "state-" + "x" * 20,
        "code_challenge": _challenge(verifier),
        "code_challenge_method": "S256",
        **overrides,
    }
    return web.post("/api/extension/authorize", json=body, headers={"X-CSRF-Token": csrf})


def _code_from(response) -> tuple[str, str]:
    assert response.status_code == 200, response.text
    url = urlsplit(response.json()["redirect_url"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == REDIRECT
    query = parse_qs(url.query)
    return query["code"][0], query["state"][0]


def _exchange(ext: TestClient, code: str, verifier: str, **overrides: Any):
    body = {
        "grant_type": "authorization_code",
        "client_id": EXT_ID,
        "redirect_uri": REDIRECT,
        "code": code,
        "code_verifier": verifier,
        **overrides,
    }
    return ext.post("/api/extension/token", json=body, headers={"Origin": EXT_ORIGIN})


def _connect(web: TestClient, ext: TestClient, email: str = EMAIL) -> dict:
    csrf = sign_in(web, email, PASSWORD)["csrf_token"]
    verifier = _verifier()
    code, _ = _code_from(_authorize(web, csrf, verifier))
    response = _exchange(ext, code, verifier)
    assert response.status_code == 200, response.text
    return response.json()


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Origin": EXT_ORIGIN}


# -- configuration ----------------------------------------------------------------------------


def test_extension_ids_are_validated(make_settings):
    with pytest.raises(ValidationError, match="32 letters"):
        make_settings(**COGNITO_SETTINGS, extension_ids=["not-an-id"])
    with pytest.raises(ValidationError, match="AUTH_MODE=cognito"):
        make_settings(extension_ids=[EXT_ID])
    settings: Settings = make_settings(**COGNITO_SETTINGS)
    assert settings.extension_ids == []


def test_everything_is_off_without_extension_ids(make_cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    client = make_cognito_client()
    csrf = sign_in(client, EMAIL, PASSWORD)["csrf_token"]
    off = _authorize(client, csrf, _verifier())
    assert off.status_code == 404 and off.json()["error"]["code"] == "extension_disabled"
    token = client.post(
        "/api/extension/token",
        json={
            "grant_type": "authorization_code",
            "client_id": EXT_ID,
            "redirect_uri": REDIRECT,
            "code": "x",
            "code_verifier": _verifier(),
        },
    )
    assert token.status_code == 404
    # An extension origin is an ordinary foreign origin then.
    refused = client.post(
        "/api/jobs", json=VALID_JOB, headers={"Origin": EXT_ORIGIN, "Authorization": "Bearer x"}
    )
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "origin_rejected"
    lookup = client.get("/api/jobs/" + "0" * 32, headers={"Authorization": "Bearer x"})
    assert lookup.status_code == 401


def test_access_code_mode_has_no_extension_endpoints(client):
    assert client.get("/api/extension/session").status_code == 404


# -- connecting -------------------------------------------------------------------------------


def test_connect_dub_and_fetch_audio_with_the_bearer_token(web, ext, db_engine):
    connected = _connect(web, ext)
    assert connected["token_type"] == "Bearer"
    assert connected["user"]["email"] == EMAIL and connected["user"]["display_name"] == "Lan"
    token = connected["access_token"]
    assert not ext.cookies  # the extension never gets a cookie
    with db_engine.connect() as conn:
        rows = conn.execute(text("SELECT client, token_hash FROM user_sessions")).all()
    assert sorted(r.client for r in rows) == ["extension", "web"]
    assert token not in [r.token_hash for r in rows]  # only the hash is stored

    session = ext.get("/api/extension/session", headers=_bearer(token))
    assert session.status_code == 200 and session.json()["user"] == connected["user"]

    # No CSRF token and no cookie: the bearer token alone, from the extension's origin.
    created = ext.post("/api/jobs", json={**VALID_JOB, "speed": 1.5}, headers=_bearer(token))
    assert created.status_code == 202, created.text
    job_id = created.json()["id"]
    job = wait_for_terminal_with(ext, job_id, token)
    assert job["status"] == "completed"
    result = ext.get(f"/api/jobs/{job_id}/result", headers=_bearer(token))
    assert result.status_code == 200 and result.json()["speed"] == 1.5
    audio = ext.get(result.json()["audio"]["url"], headers=_bearer(token))
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/mpeg"
    assert audio.headers["cache-control"] == "private, no-store"
    # The same account sees the job on the website.
    assert web.get(f"/api/jobs/{job_id}").status_code == 200


def wait_for_terminal_with(client: TestClient, job_id: str, token: str) -> dict:
    client.headers["Authorization"] = f"Bearer {token}"
    try:
        return wait_for_terminal(client, job_id)
    finally:
        del client.headers["Authorization"]


def test_authorize_needs_a_signed_in_account_and_csrf(web, ext, make_guest, fake_cognito):
    verifier = _verifier()
    assert _authorize(ext, "", verifier).status_code == 401
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    assert _authorize(web, "wrong", verifier).json()["error"]["code"] == "csrf_failed"
    cross = web.post(
        "/api/extension/authorize",
        json={},
        headers={"X-CSRF-Token": csrf, "Origin": "https://evil.example"},
    )
    assert cross.status_code == 403
    # The extension's own origin cannot approve itself.
    from_ext = web.post(
        "/api/extension/authorize",
        json={},
        headers={"X-CSRF-Token": csrf, "Origin": EXT_ORIGIN, "Authorization": "Bearer x"},
    )
    assert from_ext.json()["error"]["code"] == "origin_rejected"
    # A guest is not an account.
    guest = make_guest()
    guest_csrf = start_guest(guest)["csrf_token"]
    assert _authorize(guest, guest_csrf, verifier).status_code == 401


@pytest.fixture
def make_guest(make_cognito_client) -> Callable[[], TestClient]:
    return lambda: make_cognito_client(**{**GUEST_SETTINGS, "extension_ids": [EXT_ID]})


@pytest.mark.parametrize(
    ("overrides", "status", "code"),
    [
        ({"client_id": OTHER_EXT_ID}, 400, "extension_unknown"),
        ({"redirect_uri": f"https://{OTHER_EXT_ID}.chromiumapp.org/"}, 400, MISMATCH),
        ({"redirect_uri": f"https://{EXT_ID}.chromiumapp.org/x"}, 400, MISMATCH),
        ({"redirect_uri": "https://evil.example/"}, 400, MISMATCH),
        ({"code_challenge_method": "plain"}, 422, "validation_error"),
        ({"code_challenge": "short"}, 422, "validation_error"),
        ({"state": "short"}, 422, "validation_error"),
    ],
)
def test_authorize_checks_client_redirect_and_pkce(web, overrides, status, code):
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    response = _authorize(web, csrf, _verifier(), **overrides)
    assert response.status_code == status
    assert response.json()["error"]["code"] == code


def test_a_code_is_consumed_by_its_first_attempt(web, ext):
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    verifier = _verifier()
    code, state = _code_from(_authorize(web, csrf, verifier))
    assert state == "state-" + "x" * 20
    wrong = _exchange(ext, code, _verifier())
    assert wrong.status_code == 400 and wrong.json()["error"]["code"] == "invalid_grant"
    # The wrong verifier used the code up: the right one no longer works either.
    assert _exchange(ext, code, verifier).json()["error"]["code"] == "invalid_grant"

    code, _ = _code_from(_authorize(web, csrf, verifier))
    assert _exchange(ext, code, verifier).status_code == 200
    assert _exchange(ext, code, verifier).json()["error"]["code"] == "invalid_grant"  # replay


def test_a_code_is_bound_to_its_client_and_expires(make_ext_client, web, ext, db_engine):
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    verifier = _verifier()
    code, _ = _code_from(_authorize(web, csrf, verifier))
    both = make_ext_client(extension_ids=[EXT_ID, OTHER_EXT_ID])
    stolen = both.post(
        "/api/extension/token",
        json={
            "grant_type": "authorization_code",
            "client_id": OTHER_EXT_ID,
            "redirect_uri": f"https://{OTHER_EXT_ID}.chromiumapp.org/",
            "code": code,
            "code_verifier": verifier,
        },
    )
    assert stolen.json()["error"]["code"] == "invalid_grant"

    code, _ = _code_from(_authorize(web, csrf, verifier))
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE extension_auth_codes SET expires_at = now()"))
    assert _exchange(ext, code, verifier).json()["error"]["code"] == "invalid_grant"
    assert _exchange(ext, "unknown", verifier).json()["error"]["code"] == "invalid_grant"


# -- the token --------------------------------------------------------------------------------


def test_tokens_are_never_accepted_in_the_other_place(web, ext, make_ext_client):
    token = _connect(web, ext)["access_token"]
    web_cookie = web.cookies.get(AUTH_COOKIE)
    assert web_cookie
    # An extension token sent as the website cookie is not a website session.
    as_cookie = make_ext_client()
    as_cookie.cookies.set(AUTH_COOKIE, token)
    assert as_cookie.get("/api/auth/me").status_code == 401
    # A website cookie value sent as a bearer token is not an extension session.
    assert ext.get("/api/extension/session", headers=_bearer(web_cookie)).status_code == 401
    assert ext.post("/api/jobs", json=VALID_JOB, headers=_bearer(web_cookie)).status_code == 401
    # The bearer token does not open the account endpoints or the YouTube import.
    assert ext.get("/api/auth/me", headers=_bearer(token)).status_code == 401
    imported = ext.post(
        "/api/transcripts/youtube", json={"url": "https://youtu.be/x"}, headers=_bearer(token)
    )
    assert imported.status_code == 403 and imported.json()["error"]["code"] == "origin_rejected"


def test_a_bad_bearer_header_never_falls_back_to_the_cookie(web, ext):
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    response = web.post(
        "/api/jobs",
        json=VALID_JOB,
        headers={"X-CSRF-Token": csrf, "Authorization": "Bearer not-a-token"},
    )
    assert response.status_code == 401
    assert web.post("/api/jobs", json=VALID_JOB, headers={"X-CSRF-Token": csrf}).status_code == 202


def test_extension_origin_is_limited_to_its_own_calls(web, ext):
    token = _connect(web, ext)["access_token"]
    # A job POST from the extension origin needs the bearer token (no cookie request from there).
    no_bearer = ext.post("/api/jobs", json=VALID_JOB, headers={"Origin": EXT_ORIGIN})
    assert no_bearer.json()["error"]["code"] == "origin_rejected"
    unknown = ext.post(
        "/api/jobs",
        json=VALID_JOB,
        headers={
            "Authorization": f"Bearer {token}",
            "Origin": f"chrome-extension://{OTHER_EXT_ID}",
        },
    )
    assert unknown.json()["error"]["code"] == "origin_rejected"
    for path in ("/api/auth/logout", "/api/guest/session", "/api/auth/login"):
        refused = ext.post(path, json={}, headers=_bearer(token))
        assert refused.json()["error"]["code"] == "origin_rejected", path


def test_jobs_of_another_account_are_not_found(web, ext, make_ext_client, fake_cognito):
    token = _connect(web, ext)["access_token"]
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    other = make_ext_client()
    other_csrf = sign_in(other, OTHER_EMAIL, PASSWORD)["csrf_token"]
    job_id = other.post("/api/jobs", json=VALID_JOB, headers={"X-CSRF-Token": other_csrf}).json()[
        "id"
    ]
    assert ext.get(f"/api/jobs/{job_id}", headers=_bearer(token)).status_code == 404
    assert ext.get(f"/api/jobs/{job_id}/result/audio", headers=_bearer(token)).status_code == 404


def test_logout_ends_the_extension_token_only(web, ext):
    token = _connect(web, ext)["access_token"]
    assert ext.post("/api/extension/logout", headers=_bearer(token)).status_code == 204
    assert ext.get("/api/extension/session", headers=_bearer(token)).status_code == 401
    assert ext.post("/api/extension/logout", headers=_bearer(token)).status_code == 401
    assert web.get("/api/auth/me").status_code == 200


def test_expired_token_is_refused(web, ext, db_engine):
    token = _connect(web, ext)["access_token"]
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE user_sessions SET expires_at = now() WHERE client = 'extension'"))
    assert ext.get("/api/extension/session", headers=_bearer(token)).status_code == 401


def test_token_lifetime_is_capped_by_the_session_ttl(make_ext_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    web, ext = make_ext_client(session_ttl_seconds=600), make_ext_client(session_ttl_seconds=600)
    connected = _connect(web, ext)
    session = ext.get("/api/extension/session", headers=_bearer(connected["access_token"]))
    assert session.json()["expires_at"] == connected["expires_at"]
    expires = datetime.fromisoformat(connected["expires_at"])
    created = datetime.fromisoformat(web.get("/api/auth/me").json()["expires_at"])
    assert abs((expires - created).total_seconds()) < 60


# -- revocation -------------------------------------------------------------------------------


def test_password_reset_and_admin_revocation_end_extension_tokens(
    web, ext, fake_cognito, db_engine
):
    from scripts.auth_users import run

    token = _connect(web, ext)["access_token"]
    factory = sessionmaker(bind=db_engine)
    assert run(["revoke-sessions", EMAIL], factory, io.StringIO()) == 0
    assert ext.get("/api/extension/session", headers=_bearer(token)).status_code == 401

    token = _connect(web, ext)["access_token"]
    assert web.post("/api/auth/forgot-password", json={"email": EMAIL}).status_code == 202
    reset = web.post(
        "/api/auth/reset-password",
        json={
            "email": EMAIL,
            "code": fake_cognito.users[EMAIL].reset_code,
            "new_password": "a-new-password-2",
        },
    )
    assert reset.status_code == 200
    assert ext.get("/api/extension/session", headers=_bearer(token)).status_code == 401
    assert ext.post("/api/jobs", json=VALID_JOB, headers=_bearer(token)).status_code == 401


def test_a_code_approved_before_a_revocation_cannot_be_exchanged(web, ext, db_engine):
    from scripts.auth_users import run

    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    verifier = _verifier()
    code, _ = _code_from(_authorize(web, csrf, verifier))
    assert run(["disable", EMAIL], sessionmaker(bind=db_engine), io.StringIO()) == 0
    assert _exchange(ext, code, verifier).json()["error"]["code"] == "invalid_grant"


def test_cleanup_removes_used_and_expired_codes(web, ext, db_engine):
    _connect(web, ext)
    csrf = web.get("/api/auth/me").json()["csrf_token"]
    _code_from(_authorize(web, csrf, _verifier()))
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE extension_auth_codes SET expires_at = now()"))
    with Session(db_engine) as db:
        delete_stale_auth_rows(db)
        db.commit()
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM extension_auth_codes")).scalar_one() == 0


def test_guest_and_website_flows_are_unchanged(make_guest):
    guest = make_guest()
    csrf = start_guest(guest)["csrf_token"]
    response = guest.post(
        "/api/jobs", json=VALID_JOB, headers={"X-CSRF-Token": csrf, IP_HEADER: "203.0.113.10"}
    )
    assert response.status_code == 202
    assert (
        guest.post("/api/jobs", json=VALID_JOB, headers={IP_HEADER: "203.0.113.10"}).json()[
            "error"
        ]["code"]
        == "csrf_failed"
    )
