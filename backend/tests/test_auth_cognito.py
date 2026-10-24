"""Cognito-mode sign-in, sessions, recovery and job ownership, against a fake user pool.

No test here talks to AWS: `FakeCognito` stands in for the user pool (see tests/fake_cognito.py).
A live Cognito check is a separate, manual step (docs/AUTHENTICATION.md).
"""

import logging
import threading
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from app.auth.cognito import CognitoErrorKind
from app.auth.router import CHALLENGE_COOKIE
from app.auth.service import delete_stale_auth_rows
from app.dependencies import AUTH_COOKIE
from app.jobs.models import JobStatus
from tests.conftest import ACCESS_CODE, VALID_JOB, create_job, login, sign_in, wait_for_terminal

EMAIL = "lan@example.com"
PASSWORD = "correct-horse-1"
OTHER_EMAIL = "minh@example.com"
NEW_PASSWORD = "a-new-password-2"


def _login(client, email=EMAIL, password=PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def _complete_verification(client, fake, challenge_id, email=EMAIL):
    sent = client.post("/api/auth/email-verification/send", json={"challenge_id": challenge_id})
    assert sent.status_code == 200, sent.text
    code = fake.users[email].verification_code
    return client.post(
        "/api/auth/email-verification/confirm", json={"challenge_id": challenge_id, "code": code}
    )


# -- sign-in ----------------------------------------------------------------------------------


def test_login_creates_an_opaque_httponly_session_and_me_returns_the_user(
    cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, PASSWORD, name="Lan")
    response = _login(cognito_client)
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "authenticated"
    assert body["user"]["email"] == EMAIL and body["user"]["display_name"] == "Lan"
    cookie = response.headers["set-cookie"].lower()
    assert f"{AUTH_COOKIE}=" in cookie and "httponly" in cookie and "samesite=strict" in cookie
    # No Cognito token or password reaches the browser.
    for token in fake_cognito.issued_tokens:
        assert token not in response.text and token not in response.headers["set-cookie"]
    assert PASSWORD not in response.text

    me = cognito_client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"] == body["user"]
    assert me.json()["csrf_token"] == body["csrf_token"]

    with db_engine.connect() as conn:
        row = conn.execute(text("SELECT cognito_issuer, cognito_sub, email FROM users")).one()
        sessions = conn.execute(text("SELECT token_hash FROM user_sessions")).scalars().all()
    assert row.cognito_issuer == "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TestPool1"
    assert row.cognito_sub == fake_cognito.users[EMAIL].sub
    raw = cognito_client.cookies.get(AUTH_COOKIE)
    assert len(sessions) == 1 and raw not in sessions  # only a hash is stored


def test_secure_cookie_flag_when_configured(make_cognito_client, fake_cognito):
    client = make_cognito_client(cookie_secure=True)
    fake_cognito.add_user(EMAIL, PASSWORD)
    assert "secure" in _login(client).headers["set-cookie"].lower()


def test_identity_is_issuer_and_sub_not_email(cognito_client, fake_cognito, db_engine):
    user = fake_cognito.add_user(EMAIL, PASSWORD)
    first = sign_in(cognito_client, EMAIL, PASSWORD)["user"]
    # The administrator changes the email in Cognito: same account, updated profile.
    fake_cognito.users["lan.new@example.com"] = fake_cognito.users.pop(EMAIL)
    user.email = "lan.new@example.com"
    second = sign_in(cognito_client, "lan.new@example.com", PASSWORD)["user"]
    assert second["id"] == first["id"] and second["email"] == "lan.new@example.com"
    # A different Cognito user that later gets the old address is a different MyDubb user.
    fake_cognito.add_user(EMAIL, "another-password")
    third = sign_in(cognito_client, EMAIL, "another-password")["user"]
    assert third["id"] != first["id"]
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM users")).scalar_one() == 2


def test_wrong_password_and_unknown_account_get_the_same_answer(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    wrong = _login(cognito_client, password="wrong-password")
    unknown = _login(cognito_client, email="nobody@example.com")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    assert wrong.json()["error"]["code"] == "invalid_credentials"
    assert "set-cookie" not in wrong.headers
    assert cognito_client.get("/api/auth/me").status_code == 401


def test_failed_sign_ins_are_throttled(make_cognito_client, fake_cognito):
    client = make_cognito_client(access_max_failures_per_client=2)
    fake_cognito.add_user(EMAIL, PASSWORD)
    assert _login(client, password="nope-1").status_code == 401
    assert _login(client, password="nope-2").status_code == 401
    blocked = _login(client)
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "too_many_attempts"
    assert int(blocked.headers["retry-after"]) > 0


@pytest.mark.parametrize(
    ("kind", "status", "code"),
    [
        (CognitoErrorKind.UNAVAILABLE, 503, "auth_unavailable"),
        (CognitoErrorKind.RATE_LIMITED, 429, "auth_rate_limited"),
        (CognitoErrorKind.INVALID_PARAMETER, 503, "auth_unavailable"),
    ],
)
def test_cognito_failures_are_reported_without_retry(
    cognito_client, fake_cognito, kind, status, code
):
    fake_cognito.add_user(EMAIL, PASSWORD)
    fake_cognito.fail_next("InitiateAuth", kind)
    response = _login(cognito_client)
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert fake_cognito.calls.count("InitiateAuth") == 1  # never retried


def test_an_unsupported_cognito_step_is_not_a_session(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    fake_cognito.challenge_override = "SOFTWARE_TOKEN_MFA"
    response = _login(cognito_client)
    assert response.status_code == 503
    assert cognito_client.get("/api/auth/me").status_code == 401


def test_logs_never_contain_credentials(cognito_client, fake_cognito, caplog):
    fake_cognito.add_user(EMAIL, PASSWORD)
    caplog.set_level(logging.DEBUG)
    _login(cognito_client, password="wrong-password-xyz")
    sign_in(cognito_client, EMAIL, PASSWORD)
    for secret in (EMAIL, PASSWORD, "wrong-password-xyz", *fake_cognito.issued_tokens):
        assert secret not in caplog.text


# -- temporary password and email verification ------------------------------------------------


def test_temporary_password_requires_a_new_password(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, "Temp-pass-123", temporary=True)
    step = _login(cognito_client, password="Temp-pass-123")
    assert step.status_code == 200
    body = step.json()
    assert body["status"] == "new_password_required"
    assert set(body) == {"status", "challenge_id", "challenge_expires_at"}
    assert CHALLENGE_COOKIE in step.headers["set-cookie"]
    assert "path=/api/auth" in step.headers["set-cookie"].lower()
    # The challenge is not a Cognito session and grants nothing.
    assert body["challenge_id"] not in fake_cognito.issued_sessions
    assert cognito_client.get("/api/auth/me").status_code == 401

    weak = cognito_client.post(
        "/api/auth/new-password", json={"challenge_id": body["challenge_id"], "new_password": "x"}
    )
    assert weak.status_code == 422
    assert weak.json()["error"]["code"] == "password_rejected"

    done = cognito_client.post(
        "/api/auth/new-password",
        json={"challenge_id": body["challenge_id"], "new_password": NEW_PASSWORD},
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "authenticated"
    assert cognito_client.get("/api/auth/me").status_code == 200
    assert sign_in(cognito_client, EMAIL, NEW_PASSWORD)


def test_unverified_email_must_be_verified_before_any_access(
    cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, PASSWORD, email_verified=False)
    step = _login(cognito_client)
    body = step.json()
    assert body["status"] == "email_verification_required"
    # No session, no user row, no access to jobs, and the challenge id is no credential.
    assert f"{AUTH_COOKIE}=" not in step.headers.get("set-cookie", "")
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert cognito_client.post("/api/jobs", json=VALID_JOB).status_code == 401
    assert (
        cognito_client.post(
            "/api/jobs", json=VALID_JOB, headers={"X-CSRF-Token": body["challenge_id"]}
        ).status_code
        == 401
    )
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM users")).scalar_one() == 0
        payload = conn.execute(text("SELECT encrypted_payload FROM auth_challenges")).scalar_one()
    # The access token is stored encrypted only.
    assert fake_cognito.issued_tokens[0].encode() not in bytes(payload)
    assert fake_cognito.users[EMAIL].email_verified is False  # nothing marked verified for us

    sent = cognito_client.post(
        "/api/auth/email-verification/send", json={"challenge_id": body["challenge_id"]}
    )
    assert sent.status_code == 200
    assert sent.json()["status"] == "code_sent" and "***" in sent.json()["destination"]

    wrong = cognito_client.post(
        "/api/auth/email-verification/confirm",
        json={"challenge_id": body["challenge_id"], "code": "000000"},
    )
    if fake_cognito.users[EMAIL].verification_code == "000000":  # pragma: no cover
        pytest.skip("random code collided with the wrong code")
    assert wrong.status_code == 400 and wrong.json()["error"]["code"] == "code_invalid"

    code = fake_cognito.users[EMAIL].verification_code
    done = cognito_client.post(
        "/api/auth/email-verification/confirm",
        json={"challenge_id": body["challenge_id"], "code": code},
    )
    assert done.status_code == 200 and done.json()["status"] == "authenticated"
    assert cognito_client.get("/api/auth/me").status_code == 200
    with db_engine.connect() as conn:
        # Finished: the encrypted material is erased.
        assert conn.execute(text("SELECT encrypted_payload FROM auth_challenges")).scalar() is None


def test_new_password_then_email_verification(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, "Temp-pass-123", temporary=True, email_verified=False)
    first = _login(cognito_client, password="Temp-pass-123").json()
    second = cognito_client.post(
        "/api/auth/new-password",
        json={"challenge_id": first["challenge_id"], "new_password": NEW_PASSWORD},
    ).json()
    assert second["status"] == "email_verification_required"
    assert cognito_client.get("/api/auth/me").status_code == 401
    done = _complete_verification(cognito_client, fake_cognito, second["challenge_id"])
    assert done.json()["status"] == "authenticated"


# -- challenge safety -------------------------------------------------------------------------


def _new_password_challenge(client, fake):
    fake.add_user(EMAIL, "Temp-pass-123", temporary=True)
    return _login(client, password="Temp-pass-123").json()["challenge_id"]


def test_expired_challenge_is_rejected(cognito_client, fake_cognito, db_engine):
    challenge_id = _new_password_challenge(cognito_client, fake_cognito)
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE auth_challenges SET expires_at = now() - interval '1 second'"))
    response = cognito_client.post(
        "/api/auth/new-password", json={"challenge_id": challenge_id, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "challenge_invalid"
    assert "RespondToAuthChallenge" not in fake_cognito.calls


def test_completed_challenge_cannot_be_replayed(cognito_client, fake_cognito):
    challenge_id = _new_password_challenge(cognito_client, fake_cognito)
    body = {"challenge_id": challenge_id, "new_password": NEW_PASSWORD}
    assert cognito_client.post("/api/auth/new-password", json=body).status_code == 200
    replay = cognito_client.post("/api/auth/new-password", json=body)
    assert replay.status_code == 400
    assert replay.json()["error"]["code"] == "challenge_invalid"


def test_challenge_is_bound_to_the_browser_and_the_step(
    cognito_client, make_cognito_client, fake_cognito
):
    challenge_id = _new_password_challenge(cognito_client, fake_cognito)
    other_browser = make_cognito_client()
    stolen = other_browser.post(
        "/api/auth/new-password", json={"challenge_id": challenge_id, "new_password": NEW_PASSWORD}
    )
    assert stolen.status_code == 400
    other_browser.cookies.set(CHALLENGE_COOKIE, "forged-binding")
    forged = other_browser.post(
        "/api/auth/new-password", json={"challenge_id": challenge_id, "new_password": NEW_PASSWORD}
    )
    assert forged.status_code == 400
    wrong_step = cognito_client.post(
        "/api/auth/email-verification/send", json={"challenge_id": challenge_id}
    )
    assert wrong_step.status_code == 400
    # The rightful browser can still finish.
    ok = cognito_client.post(
        "/api/auth/new-password", json={"challenge_id": challenge_id, "new_password": NEW_PASSWORD}
    )
    assert ok.status_code == 200


def test_concurrent_completion_runs_once(cognito_client, make_cognito_client, fake_cognito):
    challenge_id = _new_password_challenge(cognito_client, fake_cognito)
    binding = cognito_client.cookies.get(CHALLENGE_COOKIE)
    second_tab = make_cognito_client()
    second_tab.cookies.set(CHALLENGE_COOKIE, binding)

    entered, release = threading.Event(), threading.Event()

    def hold():
        entered.set()
        assert release.wait(10)

    fake_cognito.hooks["RespondToAuthChallenge"] = hold
    body = {"challenge_id": challenge_id, "new_password": NEW_PASSWORD}
    results = {}
    first = threading.Thread(
        target=lambda: results.setdefault(
            "first", cognito_client.post("/api/auth/new-password", json=body)
        )
    )
    first.start()
    try:
        assert entered.wait(10)
        busy = second_tab.post("/api/auth/new-password", json=body)
    finally:
        release.set()
        first.join(10)
    assert busy.status_code == 409
    assert busy.json()["error"]["code"] == "challenge_busy"
    del fake_cognito.hooks["RespondToAuthChallenge"]
    assert results["first"].status_code == 200
    late = second_tab.post("/api/auth/new-password", json=body)
    assert late.status_code == 400
    assert fake_cognito.calls.count("RespondToAuthChallenge") == 1


def test_too_many_wrong_codes_end_the_challenge(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD, email_verified=False)
    challenge_id = _login(cognito_client).json()["challenge_id"]
    cognito_client.post("/api/auth/email-verification/send", json={"challenge_id": challenge_id})
    fake_cognito.users[EMAIL].verification_code = "123456"
    for _ in range(5):
        wrong = cognito_client.post(
            "/api/auth/email-verification/confirm",
            json={"challenge_id": challenge_id, "code": "999999"},
        )
        assert wrong.json()["error"]["code"] == "code_invalid"
    right = cognito_client.post(
        "/api/auth/email-verification/confirm",
        json={"challenge_id": challenge_id, "code": "123456"},
    )
    assert right.status_code == 400
    assert right.json()["error"]["code"] == "challenge_invalid"


def test_verification_codes_per_challenge_are_limited(make_cognito_client, fake_cognito):
    client = make_cognito_client(auth_recovery_max_per_client=100)
    fake_cognito.add_user(EMAIL, PASSWORD, email_verified=False)
    challenge_id = _login(client).json()["challenge_id"]
    for _ in range(3):
        sent = client.post("/api/auth/email-verification/send", json={"challenge_id": challenge_id})
        assert sent.status_code == 200
    fourth = client.post("/api/auth/email-verification/send", json={"challenge_id": challenge_id})
    assert fourth.status_code == 429
    assert fake_cognito.calls.count("GetUserAttributeVerificationCode") == 3


def test_revoked_access_token_ends_the_verification_step(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD, email_verified=False)
    challenge_id = _login(cognito_client).json()["challenge_id"]
    fake_cognito.disable(EMAIL)  # AdminDisableUser revokes the access token
    response = cognito_client.post(
        "/api/auth/email-verification/send", json={"challenge_id": challenge_id}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "challenge_invalid"


def test_unreadable_challenge_payload_ends_the_step(make_cognito_client, fake_cognito):
    client = make_cognito_client()
    challenge_id = _new_password_challenge(client, fake_cognito)
    import base64

    rotated = make_cognito_client(
        auth_token_encryption_key=base64.urlsafe_b64encode(b"z" * 32).decode()
    )
    rotated.cookies.set(CHALLENGE_COOKIE, client.cookies.get(CHALLENGE_COOKIE))
    response = rotated.post(
        "/api/auth/new-password", json={"challenge_id": challenge_id, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 400
    assert "RespondToAuthChallenge" not in fake_cognito.calls


# -- sessions, CSRF, logout, expiry -----------------------------------------------------------


def test_csrf_logout_and_expiry(cognito_client, fake_cognito, db_engine):
    fake_cognito.add_user(EMAIL, PASSWORD)
    csrf = sign_in(cognito_client, EMAIL, PASSWORD)["csrf_token"]
    assert cognito_client.post("/api/jobs", json=VALID_JOB).status_code == 403
    assert cognito_client.post("/api/auth/logout").status_code == 403
    assert create_job(cognito_client, csrf).status_code == 202

    cookie = cognito_client.cookies.get(AUTH_COOKIE)
    assert (
        cognito_client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 204
    )
    cognito_client.cookies.set(AUTH_COOKIE, cookie)
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert create_job(cognito_client, csrf).status_code == 401
    assert (
        cognito_client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}).status_code == 401
    )

    csrf = sign_in(cognito_client, EMAIL, PASSWORD)["csrf_token"]
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE user_sessions SET expires_at = now() - interval '1 second'"))
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert create_job(cognito_client, csrf).status_code == 401


def test_cross_origin_auth_requests_are_rejected(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    response = cognito_client.post(
        "/api/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert "InitiateAuth" not in fake_cognito.calls


def test_user_disabled_in_mydubb_loses_access(cognito_client, fake_cognito, db_engine):
    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE users SET disabled_at = now()"))
    assert cognito_client.get("/api/auth/me").status_code == 401
    again = _login(cognito_client)
    assert again.status_code == 403
    assert again.json()["error"]["code"] == "account_disabled"


def test_disabling_in_cognito_blocks_sign_in_but_not_existing_sessions(
    cognito_client, make_cognito_client, fake_cognito
):
    """Documented limit: MyDubb sessions are independent of Cognito tokens."""
    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)
    fake_cognito.disable(EMAIL)
    assert _login(make_cognito_client()).status_code == 401
    assert cognito_client.get("/api/auth/me").status_code == 200


# -- password reset ---------------------------------------------------------------------------


def _reset(client, fake, email=EMAIL, password=NEW_PASSWORD):
    assert client.post("/api/auth/forgot-password", json={"email": email}).status_code == 202
    code = fake.users[email].reset_code
    return client.post(
        "/api/auth/reset-password", json={"email": email, "code": code, "new_password": password}
    )


def test_password_reset_revokes_every_session(cognito_client, make_cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    laptop, phone = cognito_client, make_cognito_client()
    sign_in(laptop, EMAIL, PASSWORD)
    sign_in(phone, EMAIL, PASSWORD)
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    other = make_cognito_client()
    sign_in(other, OTHER_EMAIL, PASSWORD)

    response = _reset(make_cognito_client(), fake_cognito)
    assert response.status_code == 200 and response.json() == {"status": "password_reset"}
    assert "set-cookie" not in response.headers  # a reset does not sign in
    assert laptop.get("/api/auth/me").status_code == 401
    assert phone.get("/api/auth/me").status_code == 401
    assert other.get("/api/auth/me").status_code == 200  # another account is untouched
    assert _login(laptop).status_code == 401
    assert sign_in(laptop, EMAIL, NEW_PASSWORD)


def test_a_sign_in_in_progress_cannot_outlive_a_password_reset(
    cognito_client, make_cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, PASSWORD)
    entered, release = threading.Event(), threading.Event()

    def hold():
        entered.set()
        assert release.wait(10)

    # The old password was accepted; the sign-in is held before its session exists.
    fake_cognito.hooks["InitiateAuth"] = hold
    result = {}
    thread = threading.Thread(target=lambda: result.setdefault("r", _login(cognito_client)))
    thread.start()
    try:
        assert entered.wait(10)
        del fake_cognito.hooks["InitiateAuth"]
        assert _reset(make_cognito_client(), fake_cognito).status_code == 200
    finally:
        release.set()
        thread.join(10)

    assert result["r"].status_code == 409
    assert result["r"].json()["error"]["code"] == "password_changed"
    assert cognito_client.get("/api/auth/me").status_code == 401
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM user_sessions")).scalar_one() == 0


def test_a_pending_verification_step_cannot_outlive_a_password_reset(
    cognito_client, make_cognito_client, fake_cognito
):
    fake_cognito.add_user(EMAIL, PASSWORD, email_verified=False)
    challenge_id = _login(cognito_client).json()["challenge_id"]
    # Recovery needs a verified address: verify it out of band, then reset the password.
    fake_cognito.users[EMAIL].email_verified = True
    assert _reset(make_cognito_client(), fake_cognito).status_code == 200
    fake_cognito.users[EMAIL].email_verified = False
    done = _complete_verification(cognito_client, fake_cognito, challenge_id)
    assert done.status_code == 409
    assert done.json()["error"]["code"] == "password_changed"
    assert cognito_client.get("/api/auth/me").status_code == 401


def test_recovery_never_reveals_whether_an_account_exists(make_cognito_client, fake_cognito):
    client = make_cognito_client(auth_recovery_max_per_client=100)
    fake_cognito.add_user(EMAIL, PASSWORD)
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD, email_verified=False)
    answers = [
        client.post("/api/auth/forgot-password", json={"email": email})
        for email in (EMAIL, OTHER_EMAIL, "nobody@example.com")
    ]
    assert {a.status_code for a in answers} == {202}
    assert len({a.text for a in answers}) == 1
    assert fake_cognito.users[OTHER_EMAIL].reset_code is None  # unverified: no code sent

    resets = [
        client.post(
            "/api/auth/reset-password",
            json={"email": email, "code": "111111", "new_password": NEW_PASSWORD},
        )
        for email in (EMAIL, "nobody@example.com")
    ]
    if fake_cognito.users[EMAIL].reset_code == "111111":  # pragma: no cover
        pytest.skip("random code collided")
    assert {r.status_code for r in resets} == {400}
    assert len({r.text for r in resets}) == 1


def test_forgot_password_hides_per_user_limits_but_reports_outages(cognito_client, fake_cognito):
    fake_cognito.fail_next(
        "ForgotPassword", CognitoErrorKind.RATE_LIMITED, "LimitExceededException"
    )
    assert (
        cognito_client.post("/api/auth/forgot-password", json={"email": EMAIL}).status_code == 202
    )
    fake_cognito.fail_next("ForgotPassword", CognitoErrorKind.UNAVAILABLE)
    outage = cognito_client.post("/api/auth/forgot-password", json={"email": EMAIL})
    assert outage.status_code == 503


def test_recovery_requests_are_limited_per_email(make_cognito_client, fake_cognito):
    client = make_cognito_client(auth_recovery_max_per_client=100, auth_recovery_max_per_email=2)
    for _ in range(2):
        assert client.post("/api/auth/forgot-password", json={"email": EMAIL}).status_code == 202
    blocked = client.post("/api/auth/forgot-password", json={"email": EMAIL.upper()})
    assert blocked.status_code == 429
    assert client.post("/api/auth/forgot-password", json={"email": OTHER_EMAIL}).status_code == 202


def test_reset_with_a_weak_password_is_rejected(cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    response = _reset(cognito_client, fake_cognito, password="short")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "password_rejected"


# -- job ownership ----------------------------------------------------------------------------


def test_users_never_see_each_others_jobs(cognito_client, make_cognito_client, fake_cognito):
    fake_cognito.add_user(EMAIL, PASSWORD)
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    csrf = sign_in(cognito_client, EMAIL, PASSWORD)["csrf_token"]
    created = create_job(cognito_client, csrf, user_id=str(uuid.uuid4()))  # ignored by the API
    assert created.status_code == 202
    job_id = created.json()["id"]
    assert wait_for_terminal(cognito_client, job_id)["status"] == JobStatus.COMPLETED

    other = make_cognito_client()
    sign_in(other, OTHER_EMAIL, PASSWORD)
    for path in (f"/api/jobs/{job_id}", f"/api/jobs/{job_id}/result"):
        response = other.get(path)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "job_not_found"
    assert other.get(f"/api/jobs/{job_id}/result/audio").status_code == 404

    # The owner sees it from a new session too (ownership is the user, not the session).
    second_device = make_cognito_client()
    sign_in(second_device, EMAIL, PASSWORD)
    assert second_device.get(f"/api/jobs/{job_id}/result").status_code == 200
    assert second_device.get(f"/api/jobs/{job_id}/result/audio").status_code == 200


def test_access_code_jobs_are_not_given_to_users(
    make_client, cognito_client, fake_cognito, db_engine
):
    beta = make_client()
    csrf = login(beta)
    old_job = create_job(beta, csrf).json()["id"]
    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)
    assert cognito_client.get(f"/api/jobs/{old_job}").status_code == 404
    with db_engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT user_id FROM jobs WHERE id = :id"), {"id": old_job}
            ).scalar_one()
            is None
        )


def test_jobs_of_cognito_users_record_the_user_and_no_session(
    cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, PASSWORD)
    body = sign_in(cognito_client, EMAIL, PASSWORD)
    job_id = create_job(cognito_client, body["csrf_token"]).json()["id"]
    with db_engine.connect() as conn:
        row = conn.execute(
            text("SELECT user_id, session_id FROM jobs WHERE id = :id"), {"id": job_id}
        ).one()
    assert str(row.user_id) == body["user"]["id"] and row.session_id is None


# -- modes are exclusive ----------------------------------------------------------------------


def test_cognito_mode_has_no_access_code_login_and_rejects_its_sessions(
    make_client, cognito_client
):
    beta = make_client()
    login(beta)
    access_cookie = beta.cookies.get("mydubb_session")
    assert cognito_client.post("/api/session", json={"access_code": ACCESS_CODE}).status_code == 404
    cognito_client.cookies.set("mydubb_session", access_cookie)
    cognito_client.cookies.set(AUTH_COOKIE, access_cookie)  # not upgraded under any name
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert cognito_client.post("/api/jobs", json=VALID_JOB).status_code == 401


def test_access_code_mode_has_no_cognito_endpoints_and_rejects_user_sessions(
    client, cognito_client, fake_cognito
):
    assert client.post("/api/auth/login", json={"email": EMAIL, "password": "x"}).status_code == 404
    assert client.get("/api/meta").json()["auth"] == {
        "mode": "access_code",
        "self_registration": False,
        "password_reset": False,
    }
    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)
    user_cookie = cognito_client.cookies.get(AUTH_COOKIE)
    client.cookies.set("mydubb_session", user_cookie)
    client.cookies.set(AUTH_COOKIE, user_cookie)
    assert client.get("/api/session").status_code == 401
    assert client.post("/api/jobs", json=VALID_JOB).status_code == 401


def test_meta_reports_cognito_mode(cognito_client):
    assert cognito_client.get("/api/meta").json()["auth"] == {
        "mode": "cognito",
        "self_registration": False,
        "password_reset": True,
    }


# -- cleanup ----------------------------------------------------------------------------------


def test_cleanup_removes_finished_auth_rows(cognito_client, fake_cognito, db_engine):
    fake_cognito.add_user(EMAIL, PASSWORD)
    fake_cognito.add_user(OTHER_EMAIL, "Temp-pass-123", temporary=True)
    csrf = sign_in(cognito_client, EMAIL, PASSWORD)["csrf_token"]
    cognito_client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf})
    _login(cognito_client, OTHER_EMAIL, "Temp-pass-123")  # a pending challenge
    sign_in(cognito_client, EMAIL, PASSWORD)  # a live session
    with db_engine.begin() as conn:
        conn.execute(
            text("INSERT INTO password_reset_events (email_hash, reset_at) VALUES ('x', :t)"),
            {"t": datetime.now(UTC) - timedelta(days=2)},
        )
    from sqlalchemy.orm import Session

    with Session(db_engine) as db:
        assert delete_stale_auth_rows(db) == 2  # the revoked session and the old event
        db.commit()
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE auth_challenges SET expires_at = now() - interval '1 second'"))
    with Session(db_engine) as db:
        assert delete_stale_auth_rows(db) == 1
        db.commit()
    assert cognito_client.get("/api/auth/me").status_code == 200


# -- administration tool ----------------------------------------------------------------------


def test_admin_tool_disables_and_revokes(cognito_client, fake_cognito, db_engine):
    import io

    from sqlalchemy.orm import sessionmaker

    from scripts.auth_users import run

    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)
    factory = sessionmaker(bind=db_engine)
    out = io.StringIO()
    assert run(["disable", EMAIL.upper()], factory, out) == 0
    assert "1 session(s) revoked" in out.getvalue()
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert _login(cognito_client).json()["error"]["code"] == "account_disabled"

    assert run(["enable", EMAIL], factory, io.StringIO()) == 0
    sign_in(cognito_client, EMAIL, PASSWORD)
    assert run(["revoke-sessions", EMAIL], factory, io.StringIO()) == 0
    assert cognito_client.get("/api/auth/me").status_code == 401
    listing = io.StringIO()
    run(["list"], factory, listing)
    assert EMAIL in listing.getvalue() and "active" in listing.getvalue()
