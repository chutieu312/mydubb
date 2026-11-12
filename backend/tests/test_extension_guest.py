"""'Try as guest' in the Chrome extension: the website's guest session approves the extension
(Authorization Code + PKCE, like Connect), and the extension's guest token is a credential of that
same guest session, so the website and the extension share its jobs and quotas.
docs/EXTENSION_AUTH.md, "Guests". PostgreSQL, mock providers, fake user pool; nothing external.

`web` is the browser (a cookie client, the website and Chrome's sign-in window of one profile);
`ext` is the extension: no cookies, `Origin: chrome-extension://<id>` and a bearer token.
"""

import threading
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.dependencies import GUEST_COOKIE
from app.guest.service import GuestPolicy, delete_stale_rows
from tests.conftest import VALID_JOB, sign_in, wait_for_terminal
from tests.test_extension_auth import (
    EMAIL,
    EXT_ID,
    EXT_ORIGIN,
    OTHER_EXT_ID,
    PASSWORD,
    REDIRECT,
    _challenge,
    _code_from,
    _exchange,
    _verifier,
)
from tests.test_guest_access import (
    GUEST_SETTINGS,
    IP_A,
    IP_B,
    IP_HEADER,
    SIGNUP_CASES,
    start_guest,
)

GUEST_EXT: dict[str, Any] = {
    **GUEST_SETTINGS,
    "extension_ids": [EXT_ID],
    "extension_guest_enabled": True,
}


@pytest.fixture
def make_app(make_cognito_client) -> Callable[..., TestClient]:
    return lambda **overrides: make_cognito_client(**{**GUEST_EXT, **overrides})


@pytest.fixture
def web(make_app) -> TestClient:
    return make_app()


@pytest.fixture
def ext(make_app) -> TestClient:
    return make_app()


def _guest_authorize(web: TestClient, csrf: str, verifier: str, ip: str = IP_A, **overrides: Any):
    body = {
        "client_id": EXT_ID,
        "redirect_uri": REDIRECT,
        "state": "state-" + "g" * 20,
        "code_challenge": _challenge(verifier),
        "code_challenge_method": "S256",
        **overrides,
    }
    return web.post(
        "/api/extension/guest/authorize",
        json=body,
        headers={"X-CSRF-Token": csrf, IP_HEADER: ip},
    )


def _connect_guest(web: TestClient, ext: TestClient, ip: str = IP_A) -> dict:
    """The panel's Try as guest: the website continues (or starts) its guest session, approves,
    and the extension exchanges the code."""
    csrf = start_guest(web, ip)["csrf_token"]
    verifier = _verifier()
    code, _ = _code_from(_guest_authorize(web, csrf, verifier, ip))
    response = _exchange(ext, code, verifier)
    assert response.status_code == 200, response.text
    return response.json()


def _bearer(token: str, ip: str = IP_A) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Origin": EXT_ORIGIN, IP_HEADER: ip}


def _ext_job(ext: TestClient, token: str, ip: str = IP_A, **overrides: Any):
    return ext.post("/api/jobs", json={**VALID_JOB, **overrides}, headers=_bearer(token, ip))


def _web_job(web: TestClient, csrf: str, ip: str = IP_A):
    return web.post("/api/jobs", json=VALID_JOB, headers={"X-CSRF-Token": csrf, IP_HEADER: ip})


def _ext_wait(ext: TestClient, token: str, job_id: str, ip: str = IP_A) -> dict:
    ext.headers.update(_bearer(token, ip))
    try:
        return wait_for_terminal(ext, job_id)
    finally:
        for name in ("Authorization", "Origin", IP_HEADER):
            del ext.headers[name]


def _ext_session(ext: TestClient, token: str, ip: str = IP_A):
    return ext.get("/api/extension/session", headers=_bearer(token, ip))


def _web_quota(web: TestClient, ip: str = IP_A) -> dict:
    response = web.get("/api/guest/session", headers={IP_HEADER: ip})
    assert response.status_code == 200, response.text
    return response.json()["quota"]


# -- configuration and capability -------------------------------------------------------------


def test_off_by_default_and_only_with_guest_access_and_an_extension(make_cognito_client):
    def meta(**settings: Any) -> dict:
        return make_cognito_client(**settings).get("/api/meta").json()["guest_access"]

    assert meta(**{**GUEST_SETTINGS, "extension_ids": [EXT_ID]})["extension"] is False
    assert meta(**{**GUEST_SETTINGS, "extension_guest_enabled": True})["extension"] is False
    assert meta(**GUEST_EXT)["extension"] is True
    # Turning guest access off turns this off too, and the server still starts.
    assert meta(**{**GUEST_EXT, "guest_access_enabled": False}) == {"enabled": False}


def test_guest_authorize_is_refused_while_off(make_cognito_client):
    web = make_cognito_client(**{**GUEST_SETTINGS, "extension_ids": [EXT_ID]})
    csrf = start_guest(web)["csrf_token"]
    off = _guest_authorize(web, csrf, _verifier())
    assert off.status_code == 404
    assert off.json()["error"]["code"] == "extension_guest_disabled"


# -- the flow, both directions ----------------------------------------------------------------


def test_extension_first_starts_the_guest_session_that_the_website_then_sees(web, ext, db_engine):
    """Try as guest in the panel with no guest session yet: the website starts one (the existing
    policy), the extension gets a token of it, and the Studio later opens that same session and
    sees the job made in the extension."""
    grant = _connect_guest(web, ext)
    assert grant["kind"] == "guest" and grant["user"] is None
    assert "csrf_token" not in grant  # a bearer token needs none
    guest_id = grant["guest"]["id"]
    assert (
        web.get("/api/guest/session", headers={IP_HEADER: IP_A}).json()["guest"]["id"] == guest_id
    )

    session = _ext_session(ext, grant["access_token"])
    assert session.status_code == 200
    assert session.headers["cache-control"] == "no-store"
    assert session.json()["kind"] == "guest"
    assert session.json()["guest"]["id"] == guest_id
    assert session.json()["quota"]["session_remaining"] == 5

    created = _ext_job(ext, grant["access_token"])
    assert created.status_code == 202, created.text
    job_id = created.json()["id"]
    assert _ext_wait(ext, grant["access_token"], job_id)["status"] == "completed"
    result = ext.get(f"/api/jobs/{job_id}/result", headers=_bearer(grant["access_token"]))
    assert result.status_code == 200
    audio = ext.get(result.json()["audio"]["url"], headers=_bearer(grant["access_token"]))
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/mpeg"

    # The website: the same guest session, its job and its count.
    assert _web_quota(web)["session_used"] == 1
    assert _web_quota(web)["session_remaining"] == 4
    assert web.get(f"/api/jobs/{job_id}").json()["status"] == "completed"
    with db_engine.connect() as conn:
        row = conn.execute(
            text("SELECT guest_session_id, user_id, session_id FROM jobs WHERE id = :id"),
            {"id": job_id},
        ).one()
        usage = conn.execute(
            text("SELECT client, access FROM job_usage WHERE job_id = :id"), {"id": job_id}
        ).one()
    assert str(row.guest_session_id) == guest_id and row.user_id is None and row.session_id is None
    assert (usage.client, usage.access) == ("extension", "guest")


def test_web_first_two_of_five_then_three_left_then_two(web, ext):
    """The acceptance case: 2 jobs on the website, the extension continues the session and sees 3
    left; one more job in the extension, the website sees 2 after a refresh."""
    csrf = start_guest(web)["csrf_token"]
    for _ in range(2):
        response = _web_job(web, csrf)
        assert response.status_code == 202
        assert wait_for_terminal(web, response.json()["id"])["status"] == "completed"
    guest_id = web.get("/api/guest/session", headers={IP_HEADER: IP_A}).json()["guest"]["id"]

    grant = _connect_guest(web, ext)
    assert grant["guest"]["id"] == guest_id  # continued, not a new session
    assert _ext_session(ext, grant["access_token"]).json()["quota"]["session_remaining"] == 3

    created = _ext_job(ext, grant["access_token"])
    assert _ext_wait(ext, grant["access_token"], created.json()["id"])["status"] == "completed"
    assert _web_quota(web)["session_remaining"] == 2
    assert _ext_session(ext, grant["access_token"]).json()["quota"]["session_remaining"] == 2


def test_trying_again_or_reconnecting_never_gives_more_jobs(web, ext, make_app):
    first = _connect_guest(web, ext)
    created = _ext_job(ext, first["access_token"])
    _ext_wait(ext, first["access_token"], created.json()["id"])
    # Disconnect in the extension ends only its token.
    logout = ext.post("/api/extension/logout", headers=_bearer(first["access_token"]))
    assert logout.status_code == 204
    assert _ext_session(ext, first["access_token"]).status_code == 401
    assert _web_quota(web)["session_used"] == 1  # the website's guest session goes on
    # Try as guest again (and in another extension panel, another instance): the same session.
    again = _connect_guest(web, make_app())
    assert again["guest"]["id"] == first["guest"]["id"]
    assert again["access_token"] != first["access_token"]
    quota = _ext_session(ext, again["access_token"]).json()["quota"]
    assert (quota["session_used"], quota["session_remaining"]) == (1, 4)


def test_one_last_place_and_two_clients_at_once_accepts_exactly_one(web, ext, make_app):
    """Four of five used; the website and the extension (on two app instances) send Generate at
    the same moment: the guest session's row lock lets exactly one in."""
    csrf = start_guest(web)["csrf_token"]
    grant = _connect_guest(web, ext)
    for _ in range(4):
        response = _web_job(web, csrf)
        wait_for_terminal(web, response.json()["id"])
    other = make_app()
    barrier = threading.Barrier(2)
    results: dict[str, int] = {}

    def from_web() -> None:
        barrier.wait()
        results["web"] = _web_job(web, csrf).status_code

    def from_ext() -> None:
        barrier.wait()
        results["ext"] = _ext_job(other, grant["access_token"]).status_code

    threads = [threading.Thread(target=from_web), threading.Thread(target=from_ext)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert sorted(results.values()) == [202, 429], results
    quota = _web_quota(web)
    assert quota["session_used"] + quota["session_in_progress"] == 5


def test_quota_refusal_limits_and_a_failure_given_back(web, make_app):
    """The guest limits apply to the extension unchanged: words and length before any row, the
    session's 5 jobs, and a failed job gives its place back."""
    failing = make_app(mock_fail_stage="speech")
    grant = _connect_guest(web, failing)
    token = grant["access_token"]
    too_long = _ext_job(failing, token, transcript=" ".join(f"w{i}" for i in range(1001)))
    assert too_long.json()["error"]["code"] == "guest_word_limit_exceeded"
    too_far = _ext_job(
        failing, token, first_sentence_start="00:00:00", last_sentence_start="00:10:01"
    )
    assert too_far.json()["error"]["code"] == "guest_duration_limit_exceeded"
    failed = _ext_job(failing, token)
    assert failed.status_code == 202
    assert _ext_wait(failing, token, failed.json()["id"])["status"] == "failed"
    assert _web_quota(web)["session_remaining"] == 5  # given back

    ext = make_app()
    for _ in range(5):
        created = _ext_job(ext, token)
        assert created.status_code == 202, created.text
        _ext_wait(ext, token, created.json()["id"])
    refused = _ext_job(ext, token)
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "guest_session_quota_exhausted"
    assert _ext_session(ext, token).json()["quota"]["session_remaining"] == 0


def test_the_network_quota_and_the_shared_cap_apply(make_app):
    caps = {
        "usage_caps_enabled": True,
        "usage_cap_generates_per_day": 2,
        "usage_cap_youtube_imports_per_day": 1,
    }
    web, ext = make_app(**caps), make_app(**caps)
    grant = _connect_guest(web, ext)
    for _ in range(2):
        created = _ext_job(ext, grant["access_token"])
        assert created.status_code == 202
        _ext_wait(ext, grant["access_token"], created.json()["id"])
    capped = _ext_job(ext, grant["access_token"])
    assert capped.status_code == 503
    assert capped.json()["error"]["code"] == "generate_daily_cap_reached"
    assert _web_quota(web)["session_used"] == 2  # the refusal wrote nothing

    small = make_app(guest_jobs_per_ip=1)
    other = _connect_guest(small, make_app(guest_jobs_per_ip=1), ip=IP_B)
    first = _ext_job(small, other["access_token"], ip=IP_B)
    _ext_wait(small, other["access_token"], first.json()["id"], ip=IP_B)
    network = _ext_job(small, other["access_token"], ip=IP_B)
    assert network.json()["error"]["code"] == "guest_ip_quota_exhausted"


@SIGNUP_CASES
def test_the_extension_gets_the_same_ways_in_when_a_guest_is_used_up(make_app, signup, next_step):
    """The panel shows the server's 429 message as it is: the same words as the website's."""
    limits = {"guest_jobs_per_session": 2, "guest_jobs_per_ip": 3, **signup}
    web, ext = make_app(**limits), make_app(**limits)
    token = _connect_guest(web, ext)["access_token"]
    for _ in range(2):
        created = _ext_job(ext, token)
        _ext_wait(ext, token, created.json()["id"])
    session = _ext_job(ext, token)
    assert session.status_code == 429
    error = session.json()["error"]
    assert error["code"] == "guest_session_quota_exhausted" and error["limit"] == 2
    assert error["message"] == f"This guest session has used all 2 of its jobs. {next_step}"

    web.cookies.clear()
    other = _connect_guest(web, ext)["access_token"]
    created = _ext_job(ext, other)
    _ext_wait(ext, other, created.json()["id"])
    network = _ext_job(ext, other)
    assert network.status_code == 429 and "retry-after" in network.headers
    error = network.json()["error"]
    assert error["code"] == "guest_ip_quota_exhausted" and error["limit"] == 3
    assert error["message"].endswith(f"Try again later. {next_step}")
    assert "invitation" not in error["message"]


# -- the code exchange ------------------------------------------------------------------------


def test_the_code_is_one_time_short_lived_and_bound_to_pkce_client_and_redirect(
    web, ext, db_engine
):
    csrf = start_guest(web)["csrf_token"]

    def code() -> tuple[str, str]:
        verifier = _verifier()
        return _code_from(_guest_authorize(web, csrf, verifier))[0], verifier

    # Used twice: the first attempt consumes it, even a failed one.
    used, verifier = code()
    assert _exchange(ext, used, verifier).status_code == 200
    assert _exchange(ext, used, verifier).json()["error"]["code"] == "invalid_grant"
    wrong, verifier = code()
    assert _exchange(ext, wrong, _verifier()).json()["error"]["code"] == "invalid_grant"
    assert _exchange(ext, wrong, verifier).json()["error"]["code"] == "invalid_grant"
    # Another redirect or another extension.
    other, verifier = code()
    mismatch = _exchange(
        ext, other, verifier, redirect_uri=f"https://{OTHER_EXT_ID}.chromiumapp.org/"
    )
    assert mismatch.status_code == 400
    # Expired.
    late, verifier = code()
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE extension_auth_codes SET expires_at = now() - interval '1 s'"))
    assert _exchange(ext, late, verifier).json()["error"]["code"] == "invalid_grant"
    # Authorize checks the client and the redirect as for accounts.
    unknown = _guest_authorize(web, csrf, _verifier(), client_id=OTHER_EXT_ID)
    assert unknown.json()["error"]["code"] == "extension_unknown"
    elsewhere = _guest_authorize(web, csrf, _verifier(), redirect_uri="https://evil.example/")
    assert elsewhere.json()["error"]["code"] == "redirect_uri_mismatch"


def test_a_code_whose_guest_session_ended_gives_no_token(web, ext):
    csrf = start_guest(web)["csrf_token"]
    verifier = _verifier()
    code, _ = _code_from(_guest_authorize(web, csrf, verifier))
    # Leave guest mode on the website before the extension exchanges the code.
    assert web.delete("/api/guest/session", headers={"X-CSRF-Token": csrf}).status_code == 204
    assert _exchange(ext, code, verifier).json()["error"]["code"] == "invalid_grant"


def test_a_code_made_while_on_is_refused_once_the_feature_is_off(web, make_app):
    csrf = start_guest(web)["csrf_token"]
    verifier = _verifier()
    code, _ = _code_from(_guest_authorize(web, csrf, verifier))
    off = make_app(extension_guest_enabled=False)
    assert _exchange(off, code, verifier).json()["error"]["code"] == "invalid_grant"


def test_guest_authorize_needs_the_guest_session_csrf_and_origin(web, ext, make_app, fake_cognito):
    verifier = _verifier()
    assert _guest_authorize(ext, "", verifier).status_code == 401  # no guest cookie
    csrf = start_guest(web)["csrf_token"]
    assert _guest_authorize(web, "wrong", verifier).json()["error"]["code"] == "csrf_failed"
    cross = web.post(
        "/api/extension/guest/authorize",
        json={},
        headers={"X-CSRF-Token": csrf, "Origin": "https://evil.example", IP_HEADER: IP_A},
    )
    assert cross.json()["error"]["code"] == "origin_rejected"
    # The extension cannot approve itself, even with a guest token.
    grant = _connect_guest(web, ext)
    from_ext = ext.post(
        "/api/extension/guest/authorize", json={}, headers=_bearer(grant["access_token"])
    )
    assert from_ext.json()["error"]["code"] == "origin_rejected"
    # A signed-in account (whose sign-in ended the guest session) connects with Connect instead.
    fake_cognito.add_user(EMAIL, PASSWORD)
    account = make_app()
    start_guest(account)
    account_csrf = sign_in(account, EMAIL, PASSWORD)["csrf_token"]
    assert _guest_authorize(account, account_csrf, verifier).status_code == 401


# -- the token: lifetime, ending, scope and isolation ------------------------------------------


def test_the_token_ends_with_its_guest_session(web, ext, db_engine):
    grant = _connect_guest(web, ext)
    token = grant["access_token"]
    with db_engine.connect() as conn:
        session_end = conn.execute(text("SELECT expires_at FROM guest_sessions")).scalar_one()
        token_end = conn.execute(text("SELECT expires_at FROM guest_extension_tokens")).scalar_one()
        stored = conn.execute(text("SELECT token_hash FROM guest_extension_tokens")).scalar_one()
    assert token_end <= session_end  # never outlives it
    assert token not in stored  # only its hash
    # Expiry of the guest session.
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE guest_sessions SET expires_at = now() - interval '1 s'"))
    assert _ext_session(ext, token).status_code == 401
    assert _ext_job(ext, token).status_code == 401


def test_leaving_guest_mode_or_signing_in_on_the_website_ends_the_token(
    web, ext, make_app, fake_cognito
):
    grant = _connect_guest(web, ext)
    csrf = web.get("/api/guest/session", headers={IP_HEADER: IP_A}).json()["csrf_token"]
    assert web.delete("/api/guest/session", headers={"X-CSRF-Token": csrf}).status_code == 204
    assert _ext_session(ext, grant["access_token"]).status_code == 401

    fake_cognito.add_user(EMAIL, PASSWORD)
    browser = make_app()
    again = _connect_guest(browser, ext)
    sign_in(browser, EMAIL, PASSWORD)  # the sign-in ends this browser's guest session
    assert _ext_session(ext, again["access_token"]).status_code == 401


def test_the_token_only_opens_jobs_session_and_logout(web, ext):
    grant = _connect_guest(web, ext)
    headers = _bearer(grant["access_token"])
    for method, path in (
        ("GET", "/api/admin/session"),
        ("GET", "/api/account/usage"),
        ("GET", "/api/auth/me"),
        ("GET", "/api/guest/session"),
        ("POST", "/api/transcripts/youtube"),
    ):
        response = ext.request(method, path, headers=headers, json={} if method == "POST" else None)
        assert response.status_code in (401, 403), (path, response.status_code)
    # As a cookie it means nothing.
    ext.cookies.set(GUEST_COOKIE, grant["access_token"])
    try:
        assert ext.get("/api/guest/session", headers={IP_HEADER: IP_A}).status_code == 401
    finally:
        ext.cookies.clear()


def test_the_token_is_refused_once_the_feature_is_turned_off(web, ext, make_app):
    grant = _connect_guest(web, ext)
    off = make_app(extension_guest_enabled=False)
    assert _ext_session(off, grant["access_token"]).status_code == 401
    assert _ext_job(off, grant["access_token"]).status_code == 401


def test_two_guest_sessions_and_a_guest_and_an_account_never_see_each_other(make_app, fake_cognito):
    a_web, b_web, ext = make_app(), make_app(), make_app()
    a = _connect_guest(a_web, ext, IP_A)
    b = _connect_guest(b_web, ext, IP_B)
    assert a["guest"]["id"] != b["guest"]["id"]
    job_a = _ext_job(ext, a["access_token"]).json()["id"]
    _ext_wait(ext, a["access_token"], job_a)
    for path in (
        f"/api/jobs/{job_a}",
        f"/api/jobs/{job_a}/result",
        f"/api/jobs/{job_a}/result/audio",
    ):
        assert ext.get(path, headers=_bearer(b["access_token"], IP_B)).status_code == 404
        assert b_web.get(path).status_code == 404
    assert _ext_session(ext, b["access_token"], IP_B).json()["quota"]["session_used"] == 0

    # An account's extension token and the guest's never cross either.
    fake_cognito.add_user(EMAIL, PASSWORD)
    account_web = make_app()
    csrf = sign_in(account_web, EMAIL, PASSWORD)["csrf_token"]
    verifier = _verifier()
    authorize = account_web.post(
        "/api/extension/authorize",
        json={
            "client_id": EXT_ID,
            "redirect_uri": REDIRECT,
            "state": "state-" + "a" * 20,
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
        },
        headers={"X-CSRF-Token": csrf},
    )
    code, _ = _code_from(authorize)
    account = _exchange(ext, code, verifier).json()
    assert account["kind"] == "account" and account["user"]["email"] == EMAIL
    job_account = _ext_job(ext, account["access_token"]).json()["id"]
    assert (
        ext.get(f"/api/jobs/{job_account}", headers=_bearer(a["access_token"])).status_code == 404
    )
    assert (
        ext.get(f"/api/jobs/{job_a}", headers=_bearer(account["access_token"])).status_code == 404
    )
    # The account's session answer carries its Free plan usage, not a guest quota.
    session = _ext_session(ext, account["access_token"]).json()
    assert session["kind"] == "account" and session["quota"] is None
    assert session["usage"]["plan"] == "free"
    assert session["usage"]["generate"] == {"used": 1, "limit": 20, "remaining": 19}


def test_no_client_supplied_identity_is_used(web, ext):
    """The guest session comes from the code (and then the token), never from the request."""
    grant = _connect_guest(web, ext)
    stranger = str(uuid.uuid4())
    created = ext.post(
        "/api/jobs",
        json={**VALID_JOB, "guest_session_id": stranger, "user_id": stranger},
        headers=_bearer(grant["access_token"]),
    )
    assert created.status_code == 202
    job = created.json()["id"]
    assert web.get(f"/api/jobs/{job}").status_code == 200  # the website's guest session owns it


def test_cleanup_removes_ended_tokens(web, ext, db_engine, make_settings):
    grant = _connect_guest(web, ext)
    ext.post("/api/extension/logout", headers=_bearer(grant["access_token"]))
    _connect_guest(web, ext)  # a live one stays
    policy = GuestPolicy.from_settings(make_settings(**GUEST_EXT))
    with sessionmaker(bind=db_engine)() as db:
        delete_stale_rows(db, policy)
        db.commit()
    with db_engine.connect() as conn:
        rows = conn.execute(text("SELECT revoked_at FROM guest_extension_tokens")).all()
    assert [row.revoked_at for row in rows] == [None]


def test_accounts_connect_as_before(make_app, fake_cognito):
    """The existing Connect is unchanged with the feature on: same token answer plus `kind`."""
    fake_cognito.add_user(EMAIL, PASSWORD, name="Lan")
    web, ext = make_app(), make_app()
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    verifier = _verifier()
    authorize = web.post(
        "/api/extension/authorize",
        json={
            "client_id": EXT_ID,
            "redirect_uri": REDIRECT,
            "state": "state-" + "b" * 20,
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
        },
        headers={"X-CSRF-Token": csrf},
    )
    code, _ = _code_from(authorize)
    grant = _exchange(ext, code, verifier).json()
    assert grant["user"] == {"id": grant["user"]["id"], "email": EMAIL, "display_name": "Lan"}
    assert grant["kind"] == "account" and grant["guest"] is None
    created = _ext_job(ext, grant["access_token"])
    assert created.status_code == 202
    assert _ext_wait(ext, grant["access_token"], created.json()["id"])["status"] == "completed"


# -- schema -----------------------------------------------------------------------------------


def test_models_match_the_migration(db_engine):
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    from app.db import Base

    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn, opts={"compare_type": True})
        diffs = compare_metadata(context, Base.metadata)
    related = ("guest_extension_tokens", "extension_auth_codes")
    assert [d for d in diffs if any(name in repr(d) for name in related)] == []


def test_a_code_has_exactly_one_owner(db_engine):
    insert = text(
        "INSERT INTO extension_auth_codes (id, code_hash, client_id, redirect_uri, "
        "code_challenge, auth_started_at, created_at, expires_at) VALUES (:id, 'h', "
        "'c', 'r', 'x', now(), now(), now())"
    )
    with (
        pytest.raises(Exception, match="ck_extension_auth_codes_one_owner"),
        db_engine.begin() as conn,
    ):
        conn.execute(insert, {"id": uuid.uuid4()})


def test_the_migration_keeps_account_codes_and_goes_down_and_up(engine, database_url):
    """0021 -> 0022 with an account code written before it; down removes guest codes and tokens
    only; up again."""
    from alembic import command
    from sqlalchemy import inspect

    from tests.conftest import alembic_config

    config = alembic_config(database_url)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE jobs, users, guest_sessions CASCADE"))
    command.downgrade(config, "0021_free_quotas")
    try:
        assert "guest_extension_tokens" not in inspect(engine).get_table_names()
        user_id = uuid.uuid4()
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, cognito_issuer, cognito_sub, email, email_normalized, "
                    "created_at, updated_at) VALUES (:id, 'i', 's', 'a@x.org', 'a@x.org', now(), "
                    "now())"
                ),
                {"id": user_id},
            )
            conn.execute(
                text(
                    "INSERT INTO extension_auth_codes (id, code_hash, user_id, client_id, "
                    "redirect_uri, code_challenge, auth_started_at, created_at, expires_at) VALUES "
                    "(:id, 'old', :u, 'c', 'r', 'x', now(), now(), now())"
                ),
                {"id": uuid.uuid4(), "u": user_id},
            )
        command.upgrade(config, "head")
        with engine.begin() as conn:
            assert (
                conn.execute(text("SELECT code_hash FROM extension_auth_codes")).scalar() == "old"
            )
            guest = uuid.uuid4()
            conn.execute(
                text(
                    "INSERT INTO guest_sessions (id, token_hash, csrf_token, ip_key, created_at, "
                    "expires_at) VALUES (:id, 'g', 'c', 'k', now(), now() + interval '1 h')"
                ),
                {"id": guest},
            )
            conn.execute(
                text(
                    "INSERT INTO extension_auth_codes (id, code_hash, guest_session_id, client_id, "
                    "redirect_uri, code_challenge, auth_started_at, created_at, expires_at) VALUES "
                    "(:id, 'guest', :g, 'c', 'r', 'x', now(), now(), now())"
                ),
                {"id": uuid.uuid4(), "g": guest},
            )
        command.downgrade(config, "0021_free_quotas")
        with engine.connect() as conn:
            hashes = (
                conn.execute(text("SELECT code_hash FROM extension_auth_codes")).scalars().all()
            )
        assert hashes == ["old"]
        columns = {c["name"]: c for c in inspect(engine).get_columns("extension_auth_codes")}
        assert "guest_session_id" not in columns and columns["user_id"]["nullable"] is False
    finally:
        command.upgrade(config, "head")
    assert "guest_extension_tokens" in inspect(engine).get_table_names()
