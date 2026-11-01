"""MyDubb's admin role: the server-side check, its limits, the administration tool and migration
0012, against the fake user pool and PostgreSQL. docs/AUTHENTICATION.md, "Administrators"."""

import io
import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.dependencies import AUTH_COOKIE, require_admin, require_admin_csrf
from scripts.auth_users import main as tool_main
from scripts.auth_users import run as tool
from tests.conftest import VALID_JOB, alembic_config, create_job, login, sign_in, wait_for_terminal
from tests.test_extension_auth import (
    EXT_ID,
    EXT_ORIGIN,
    _authorize,
    _code_from,
    _exchange,
    _verifier,
)
from tests.test_guest_access import GUEST_SETTINGS, start_guest

EMAIL = "lan@example.com"
PASSWORD = "correct-horse-1"
OTHER_EMAIL = "minh@example.com"
THIRD_EMAIL = "an@example.com"
ADMIN_URL = "/api/admin/session"
PROBE_URL = "/api/admin/test-probe"


def _run_tool(db_engine: Engine, *argv: str) -> str:
    out = io.StringIO()
    assert tool(list(argv), sessionmaker(bind=db_engine), out) == 0
    return out.getvalue()


def _tool_error(db_engine: Engine, capsys, *argv: str) -> str:
    """Run the tool as the command line does, on the test database: returns the one-line error."""
    from scripts import auth_users

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(auth_users, "database_url", lambda: db_engine.url)
        assert tool_main(list(argv)) == 1
    return capsys.readouterr().err


def _user_id(db_engine: Engine, email: str = EMAIL) -> str:
    with db_engine.connect() as conn:
        return str(
            conn.execute(
                text("SELECT id FROM users WHERE email_normalized = :e"), {"e": email}
            ).scalar_one()
        )


def _role(db_engine: Engine, email: str = EMAIL) -> str:
    with db_engine.connect() as conn:
        return conn.execute(
            text("SELECT role FROM users WHERE email_normalized = :e"), {"e": email}
        ).scalar_one()


def _events(db_engine: Engine) -> list[tuple]:
    with db_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT user_id::text, old_role, new_role, changed_by FROM user_role_events "
                "ORDER BY id"
            )
        )
        return [tuple(row) for row in rows]


def _grant(db_engine: Engine, email: str = EMAIL) -> str:
    return _run_tool(db_engine, "grant-admin", _user_id(db_engine, email), "--confirm-email", email)


def _revoke(db_engine: Engine, email: str = EMAIL) -> str:
    return _run_tool(db_engine, "revoke-admin", _user_id(db_engine, email))


def _add_probe(client: TestClient) -> None:
    """A state-changing endpoint guarded the way a future administration endpoint is."""

    def probe() -> dict[str, bool]:
        return {"ok": True}

    client.app.add_api_route(  # type: ignore[attr-defined]
        PROBE_URL, probe, methods=["POST"], dependencies=[Depends(require_admin_csrf)]
    )


@pytest.fixture
def web(make_cognito_client, fake_cognito) -> TestClient:
    fake_cognito.add_user(EMAIL, PASSWORD, name="Lan")
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    fake_cognito.add_user(THIRD_EMAIL, PASSWORD)
    client = make_cognito_client(extension_ids=[EXT_ID])
    _add_probe(client)
    return client


@pytest.fixture
def other(make_cognito_client) -> TestClient:
    """Another browser."""
    return make_cognito_client(extension_ids=[EXT_ID])


def _connect_extension(web: TestClient, ext: TestClient, csrf: str) -> str:
    verifier = _verifier()
    code, _ = _code_from(_authorize(web, csrf, verifier))
    response = _exchange(ext, code, verifier)
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


# -- the check --------------------------------------------------------------------------------


def test_accounts_are_ordinary_users_by_default(web, other, db_engine):
    # The very first account of an empty table is not special either.
    sign_in(web, EMAIL, PASSWORD)
    assert _role(db_engine) == "user"
    response = web.get(ADMIN_URL)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "admin_required"
    # Being signed in as an ordinary user says nothing about who the administrators are.
    assert set(response.json()["error"]) == {"code", "message"}
    assert _events(db_engine) == []


def test_no_email_address_or_domain_makes_an_administrator(web, fake_cognito, db_engine):
    fake_cognito.add_user("admin@mydubb.com", PASSWORD)
    sign_in(web, "admin@mydubb.com", PASSWORD)
    assert web.get(ADMIN_URL).status_code == 403
    assert _role(db_engine, "admin@mydubb.com") == "user"


def test_no_session_is_401_and_an_administrator_gets_only_the_role(web, other, db_engine):
    assert other.get(ADMIN_URL).status_code == 401
    assert other.get(ADMIN_URL).json()["error"]["code"] == "not_authenticated"

    sign_in(web, EMAIL, PASSWORD)
    _grant(db_engine)
    response = web.get(ADMIN_URL)
    assert response.status_code == 200
    assert response.json() == {"role": "admin"}
    assert response.headers["cache-control"] == "no-store"


def test_a_guest_is_never_an_administrator(make_cognito_client, db_engine):
    guest = make_cognito_client(**GUEST_SETTINGS)
    start_guest(guest)
    assert guest.get(ADMIN_URL).status_code == 401


def test_an_access_code_session_is_never_an_administrator(make_client):
    # Administration is not mounted in that mode, and the check itself would refuse it too.
    client = make_client()
    login(client)
    assert client.get(ADMIN_URL).status_code == 404

    def probe() -> dict[str, bool]:
        return {"ok": True}

    client.app.add_api_route(  # type: ignore[attr-defined]
        PROBE_URL, probe, methods=["GET"], dependencies=[Depends(require_admin)]
    )
    assert client.get(PROBE_URL).status_code == 403


def test_expired_session_is_refused_even_for_an_administrator(web, db_engine):
    sign_in(web, EMAIL, PASSWORD)
    _grant(db_engine)
    assert web.get(ADMIN_URL).status_code == 200
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE user_sessions SET expires_at = now()"))
    assert web.get(ADMIN_URL).status_code == 401


def test_revoked_sessions_are_refused_even_for_an_administrator(web, db_engine):
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    _grant(db_engine)
    token = web.cookies[AUTH_COOKIE]

    assert web.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    web.cookies.set(AUTH_COOKIE, token)
    assert web.get(ADMIN_URL).status_code == 401

    web.cookies.clear()
    sign_in(web, EMAIL, PASSWORD)
    assert web.get(ADMIN_URL).status_code == 200
    _run_tool(db_engine, "revoke-sessions", EMAIL)
    assert web.get(ADMIN_URL).status_code == 401
    assert _role(db_engine) == "admin"  # signing out does not change the role


def test_disabled_administrator_is_refused_and_keeps_the_role_visibly(web, db_engine):
    sign_in(web, EMAIL, PASSWORD)
    _grant(db_engine)
    assert web.get(ADMIN_URL).status_code == 200

    output = _run_tool(db_engine, "disable", EMAIL)
    assert "role=admin" in output
    assert web.get(ADMIN_URL).status_code == 401

    # `enable` tells what comes back; a new sign-in is still needed.
    assert "role=admin" in _run_tool(db_engine, "enable", EMAIL)
    assert web.get(ADMIN_URL).status_code == 401
    sign_in(web, EMAIL, PASSWORD)
    assert web.get(ADMIN_URL).status_code == 200


def test_revoking_applies_to_the_next_request_of_a_signed_in_user(web, db_engine):
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    _grant(db_engine)
    assert web.get(ADMIN_URL).status_code == 200
    assert web.post(PROBE_URL, headers={"X-CSRF-Token": csrf}).status_code == 200

    assert "admin revoked" in _revoke(db_engine)

    assert web.get(ADMIN_URL).status_code == 403
    assert web.post(PROBE_URL, headers={"X-CSRF-Token": csrf}).status_code == 403
    # Still signed in, as an ordinary user, in the same session.
    me = web.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["csrf_token"] == csrf
    assert create_job(web, csrf).status_code == 202

    # A grant applies the same way, without a new sign-in.
    _grant(db_engine)
    assert web.get(ADMIN_URL).status_code == 200


def test_state_changing_administration_needs_the_csrf_token(web, other, db_engine):
    _add_probe(other)
    assert other.post(PROBE_URL, headers={"X-CSRF-Token": "x"}).status_code == 401

    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    assert web.post(PROBE_URL, headers={"X-CSRF-Token": csrf}).json()["error"]["code"] == (
        "admin_required"
    )
    _grant(db_engine)
    missing = web.post(PROBE_URL)
    assert missing.status_code == 403
    assert missing.json()["error"]["code"] == "csrf_failed"
    assert web.post(PROBE_URL, headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert web.post(PROBE_URL, headers={"X-CSRF-Token": csrf}).status_code == 200
    # A cross-site page cannot reach it either.
    cross_site = web.post(
        PROBE_URL, headers={"X-CSRF-Token": csrf, "Origin": "https://evil.example"}
    )
    assert cross_site.json()["error"]["code"] == "origin_rejected"


# -- what the role does not do ----------------------------------------------------------------


def test_the_role_changes_nothing_for_jobs(web, other, db_engine):
    csrf = sign_in(other, OTHER_EMAIL, PASSWORD)["csrf_token"]
    job_id = create_job(other, csrf).json()["id"]
    wait_for_terminal(other, job_id)

    admin_csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    _grant(db_engine)
    # No access to another user's job.
    assert web.get(f"/api/jobs/{job_id}").status_code == 404
    # Same validation and the same response as an ordinary account.
    assert create_job(web, admin_csrf, transcript="").status_code == 422
    own = create_job(web, admin_csrf)
    assert own.status_code == 202
    assert wait_for_terminal(web, own.json()["id"])["status"] == "completed"


def test_me_and_login_do_not_expose_the_role(web, db_engine):
    sign_in(web, EMAIL, PASSWORD)
    _grant(db_engine)
    web.cookies.clear()
    assert "role" not in sign_in(web, EMAIL, PASSWORD)["user"]
    body = web.get("/api/auth/me").json()
    assert set(body) == {"user", "csrf_token", "expires_at"}
    assert set(body["user"]) == {"id", "email", "display_name"}


# -- a client cannot raise its own role -------------------------------------------------------


def test_sign_in_and_payload_never_change_the_role(web, db_engine):
    forged = {"role": "admin", "is_admin": True, "user": {"role": "admin"}}
    response = web.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD, **forged})
    assert response.status_code == 200
    csrf = response.json()["csrf_token"]
    assert _role(db_engine) == "user"

    job = web.post(
        "/api/jobs?role=admin",
        json={**VALID_JOB, **forged},
        headers={"X-CSRF-Token": csrf, "X-Role": "admin", "X-Admin": "true"},
    )
    assert job.status_code == 202
    web.cookies.set("role", "admin")
    assert web.get(ADMIN_URL, headers={"X-Role": "admin"}).status_code == 403
    assert web.get(f"{ADMIN_URL}?role=admin").status_code == 403
    assert _role(db_engine) == "user"
    assert _events(db_engine) == []


def test_a_new_sign_in_neither_grants_nor_clears_the_role(web, other, db_engine):
    sign_in(web, EMAIL, PASSWORD)
    sign_in(other, OTHER_EMAIL, PASSWORD)
    _grant(db_engine)
    # The sign-in upsert refreshes the profile only.
    web.cookies.clear()
    sign_in(web, EMAIL, PASSWORD)
    other.cookies.clear()
    sign_in(other, OTHER_EMAIL, PASSWORD)
    assert _role(db_engine) == "admin"
    assert _role(db_engine, OTHER_EMAIL) == "user"


def test_no_api_endpoint_writes_the_role(web, db_engine):
    """Every state-changing route, called with a forged role by an ordinary signed-in user."""
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    forged = {"role": "admin", "is_admin": True, "new_role": "admin"}
    calls = [
        (method, path)
        for path, operations in web.app.openapi()["paths"].items()  # type: ignore[attr-defined]
        for method in operations
        if method in {"post", "put", "patch", "delete"} and path != PROBE_URL
    ]
    assert len(calls) > 5
    # Ending the session last keeps the other calls authenticated.
    calls.sort(key=lambda call: call[1].endswith("/logout"))
    for method, path in calls:
        url = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)
        response = web.request(method, url, json=forged, headers={"X-CSRF-Token": csrf})
        assert response.status_code < 500, path
    assert _role(db_engine) == "user"
    assert _events(db_engine) == []


def test_only_the_admin_session_route_is_mounted_under_admin(web):
    paths = web.app.openapi()["paths"]  # type: ignore[attr-defined]
    assert {path for path in paths if path.startswith("/api/admin")} == {ADMIN_URL, PROBE_URL}
    assert set(paths[ADMIN_URL]) == {"get"}


# -- the extension's token --------------------------------------------------------------------


def test_extension_token_never_reaches_administration(web, make_cognito_client, db_engine):
    ext = make_cognito_client(extension_ids=[EXT_ID])
    _add_probe(ext)
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    _grant(db_engine)
    token = _connect_extension(web, ext, csrf)
    bearer = {"Authorization": f"Bearer {token}", "Origin": EXT_ORIGIN}

    # Alone, from the extension's origin or not.
    assert ext.get(ADMIN_URL, headers=bearer).status_code == 401
    assert ext.get(ADMIN_URL, headers={"Authorization": f"Bearer {token}"}).status_code == 401
    # As the website's cookie.
    ext.cookies.set(AUTH_COOKIE, token)
    assert ext.get(ADMIN_URL).status_code == 401
    ext.cookies.clear()
    # Next to an administrator's valid website cookie: the request is refused, not upgraded.
    assert web.get(ADMIN_URL).status_code == 200
    mixed = web.get(ADMIN_URL, headers={"Authorization": f"Bearer {token}"})
    assert mixed.status_code == 401
    # Same for a request that changes state, also with the session's CSRF token.
    assert (
        web.post(
            PROBE_URL, headers={"Authorization": f"Bearer {token}", "X-CSRF-Token": csrf}
        ).status_code
        == 401
    )
    # The extension's origin is not accepted for it at all.
    rejected = ext.post(PROBE_URL, headers={**bearer, "X-CSRF-Token": csrf})
    assert rejected.status_code == 403
    assert rejected.json()["error"]["code"] == "origin_rejected"
    # The website's token is no bearer token either.
    website_token = web.cookies[AUTH_COOKIE]
    assert (
        ext.get(ADMIN_URL, headers={"Authorization": f"Bearer {website_token}"}).status_code == 401
    )

    # The extension works as before for this administrator.
    assert ext.get("/api/extension/session", headers=bearer).status_code == 200
    assert ext.post("/api/jobs", json=VALID_JOB, headers=bearer).status_code == 202


# -- the tool ---------------------------------------------------------------------------------


def test_tool_changes_only_the_named_user_and_records_it(
    web, other, make_cognito_client, db_engine
):
    third = make_cognito_client()
    sign_in(web, EMAIL, PASSWORD)
    sign_in(other, OTHER_EMAIL, PASSWORD)
    sign_in(third, THIRD_EMAIL, PASSWORD)
    target = _user_id(db_engine)

    output = _grant(db_engine)
    assert "admin granted" in output and target in output and EMAIL in output
    assert _role(db_engine) == "admin"
    assert _role(db_engine, OTHER_EMAIL) == "user"
    assert _role(db_engine, THIRD_EMAIL) == "user"

    events = _events(db_engine)
    assert [event[:3] for event in events] == [(target, "user", "admin")]
    assert events[0][3].startswith("auth_users:")

    _grant(db_engine, OTHER_EMAIL)
    _revoke(db_engine)
    assert _role(db_engine) == "user"
    assert _role(db_engine, OTHER_EMAIL) == "admin"
    assert [event[:3] for event in _events(db_engine)] == [
        (target, "user", "admin"),
        (_user_id(db_engine, OTHER_EMAIL), "user", "admin"),
        (target, "admin", "user"),
    ]

    # Other tool commands do not touch the role.
    _run_tool(db_engine, "revoke-sessions", OTHER_EMAIL)
    assert _role(db_engine, OTHER_EMAIL) == "admin"
    assert _role(db_engine, THIRD_EMAIL) == "user"


def test_tool_repeating_a_change_records_nothing(web, db_engine):
    sign_in(web, EMAIL, PASSWORD)
    assert "not an admin, nothing changed" in _revoke(db_engine)
    assert _events(db_engine) == []
    _grant(db_engine)
    assert "already an admin, nothing changed" in _grant(db_engine)
    assert len(_events(db_engine)) == 1


def test_tool_grant_needs_one_id_and_the_matching_email(web, db_engine, capsys):
    sign_in(web, EMAIL, PASSWORD)
    target = _user_id(db_engine)

    # Argument errors: no target, no confirmation, several targets, no bulk option.
    for argv in (
        ["grant-admin"],
        ["grant-admin", target],
        ["grant-admin", "--confirm-email", EMAIL],
        ["grant-admin", target, target, "--confirm-email", EMAIL],
        ["grant-admin", "--all"],
        ["grant-admin", "--all", "--confirm-email", EMAIL],
        ["revoke-admin"],
        ["revoke-admin", target, target],
        ["revoke-admin", "--all"],
    ):
        with pytest.raises(SystemExit) as exit_info:
            tool(argv, sessionmaker(bind=db_engine), io.StringIO())
        assert exit_info.value.code == 2
    capsys.readouterr()

    # An email is not a target.
    assert "USER_ID must be a user id" in _tool_error(
        db_engine, capsys, "grant-admin", EMAIL, "--confirm-email", EMAIL
    )
    assert "USER_ID must be a user id" in _tool_error(db_engine, capsys, "revoke-admin", EMAIL)
    assert "USER_ID must be a user id" in _tool_error(db_engine, capsys, "role", EMAIL)
    # A wrong confirmation changes nothing.
    assert "nothing changed" in _tool_error(
        db_engine, capsys, "grant-admin", target, "--confirm-email", OTHER_EMAIL
    )
    # An unknown id.
    missing = str(uuid.uuid4())
    assert "no such user" in _tool_error(
        db_engine, capsys, "grant-admin", missing, "--confirm-email", EMAIL
    )
    assert "no such user" in _tool_error(db_engine, capsys, "revoke-admin", missing)
    assert "no such user" in _tool_error(db_engine, capsys, "role", missing)
    assert _role(db_engine) == "user"
    assert _events(db_engine) == []

    # The confirmation ignores case and spaces, like a sign-in's email.
    _run_tool(db_engine, "grant-admin", target, "--confirm-email", f" {EMAIL.upper()} ")
    assert _role(db_engine) == "admin"


def test_tool_refuses_to_grant_to_a_disabled_user_but_can_revoke(web, db_engine, capsys):
    sign_in(web, EMAIL, PASSWORD)
    target = _user_id(db_engine)
    _run_tool(db_engine, "disable", EMAIL)
    assert "disabled" in _tool_error(
        db_engine, capsys, "grant-admin", target, "--confirm-email", EMAIL
    )
    assert _role(db_engine) == "user"

    _run_tool(db_engine, "enable", EMAIL)
    _grant(db_engine)
    _run_tool(db_engine, "disable", EMAIL)
    assert "admin revoked" in _revoke(db_engine)
    assert _role(db_engine) == "user"


def test_tool_lookup_role_and_list(web, other, db_engine, capsys):
    sign_in(web, EMAIL, PASSWORD)
    sign_in(other, OTHER_EMAIL, PASSWORD)
    target = _user_id(db_engine)
    # A second account with the same email (e.g. another issuer): lookup shows both.
    twin = uuid.uuid4()
    now = datetime.now(UTC)
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, cognito_issuer, cognito_sub, email, email_normalized, "
                "created_at, updated_at) "
                "VALUES (:id, 'other-issuer', 'other-sub', :e, :e, :at, :at)"
            ),
            {"id": twin, "e": EMAIL, "at": now - timedelta(days=1)},
        )

    found = _run_tool(db_engine, "lookup", EMAIL.upper()).splitlines()
    assert len(found) == 2
    assert target in found[0] and str(twin) in found[1]
    assert all("role=user" in line for line in found)
    assert "no user has this email" in _tool_error(db_engine, capsys, "lookup", "no@example.com")

    # Neither a lookup nor reading a role writes anything.
    _run_tool(db_engine, "role", target)
    assert _events(db_engine) == []

    first = _run_tool(db_engine, "grant-admin", target, "--confirm-email", EMAIL)
    assert "role=admin" in first
    _revoke_output = _run_tool(db_engine, "revoke-admin", target)
    assert "role=user" in _revoke_output
    _run_tool(db_engine, "grant-admin", target, "--confirm-email", EMAIL)

    role = _run_tool(db_engine, "role", target).splitlines()
    assert role[0].startswith(f"role: {target}") and "role=admin" in role[0]
    assert "user -> admin" in role[1]  # newest first
    assert "admin -> user" in role[2]
    assert "user -> admin" in role[3]

    admins = _run_tool(db_engine, "list", "--role", "admin").splitlines()
    assert len(admins) == 1 and target in admins[0]
    assert len(_run_tool(db_engine, "list").splitlines()) == 3


def test_tool_output_has_no_secret_and_never_the_connection_string(
    web, db_engine, capsys, monkeypatch
):
    login_body = sign_in(web, EMAIL, PASSWORD)
    target = _user_id(db_engine)
    output = (
        _grant(db_engine)
        + _run_tool(db_engine, "lookup", EMAIL)
        + _run_tool(db_engine, "role", target)
        + _run_tool(db_engine, "list")
        + _revoke(db_engine)
    )
    assert login_body["csrf_token"] not in output
    assert web.cookies[AUTH_COOKIE] not in output
    assert "sub-" not in output  # Cognito's sub
    assert "password" not in output.lower()

    # A database failure prints the error's type only.
    monkeypatch.setenv("DATABASE_URL", "postgresql://someuser:s3cr3t-pw@127.0.0.1:1/db")
    assert tool_main(["revoke-admin", target]) == 1
    captured = capsys.readouterr()
    assert "database operation failed" in captured.err
    for secret in ("s3cr3t-pw", "someuser", "127.0.0.1"):
        assert secret not in captured.err + captured.out


# -- migration 0012 ---------------------------------------------------------------------------


def test_models_match_the_migrations(db_engine):
    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn, opts={"compare_type": True})
        diffs = compare_metadata(context, Base.metadata)
    assert [diff for diff in diffs if "user_role_events" in str(diff) or "role" in str(diff)] == []


def test_role_values_are_checked_by_the_database(web, db_engine):
    sign_in(web, EMAIL, PASSWORD)
    with pytest.raises(IntegrityError), db_engine.begin() as conn:
        conn.execute(text("UPDATE users SET role = 'owner'"))
    with pytest.raises(IntegrityError), db_engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO user_role_events (user_id, old_role, new_role, changed_by, "
                "changed_at) VALUES (:id, 'user', 'user', 'x', now())"
            ),
            {"id": uuid.uuid4()},
        )


def test_0012_keeps_accounts_and_sessions_and_makes_nobody_an_administrator(
    engine, database_url, web, db_engine
):
    csrf = sign_in(web, EMAIL, PASSWORD)["csrf_token"]
    _grant(db_engine)
    config = alembic_config(database_url)
    command.downgrade(config, "0011")
    try:
        with engine.connect() as conn:
            columns = conn.execute(
                text("SELECT column_name FROM information_schema.columns WHERE table_name='users'")
            ).scalars()
            assert "role" not in set(columns)
            assert conn.execute(text("SELECT to_regclass('user_role_events')")).scalar_one() is None
        # The website keeps working at 0011 with a sign-in row written the old way.
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, cognito_issuer, cognito_sub, email, email_normalized,"
                    " created_at, updated_at) VALUES (:id, 'i', 's', 'old@example.com', "
                    "'old@example.com', now(), now())"
                ),
                {"id": uuid.uuid4()},
            )
    finally:
        command.upgrade(config, "head")

    # The session survived both directions; the grant did not (documented in the migration).
    assert web.get("/api/auth/me").json()["csrf_token"] == csrf
    assert web.get(ADMIN_URL).status_code == 403
    assert _role(db_engine) == "user"
    assert _role(db_engine, "old@example.com") == "user"
    assert _events(db_engine) == []


def test_code_from_before_0012_keeps_writing_on_the_new_schema(web, db_engine):
    """During a deploy overlap the old code inserts users without the role."""
    with db_engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO users (id, cognito_issuer, cognito_sub, email, email_normalized, "
                "created_at, updated_at) VALUES (:id, 'i', 's', 'old@example.com', "
                "'old@example.com', now(), now())"
            ),
            {"id": uuid.uuid4()},
        )
    assert _role(db_engine, "old@example.com") == "user"
