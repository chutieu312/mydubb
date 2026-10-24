"""Races around Cognito sign-in: admin revocation and challenge lease fencing (PostgreSQL).

Deterministic: requests are held inside the fake Cognito with hooks and threading.Event, and a
lease "expires" by moving `locked_until` in the database; nothing sleeps.
"""

import io
import threading

import pytest
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.auth.router import CHALLENGE_COOKIE
from app.auth.service import ChallengeBusy, ChallengeKind, claim_challenge
from app.db import session_scope
from scripts.auth_users import run as admin
from tests.conftest import sign_in

EMAIL = "lan@example.com"
PASSWORD = "correct-horse-1"
OTHER_EMAIL = "minh@example.com"
NEW_PASSWORD = "a-new-password-2"


def _login(client, email=EMAIL, password=PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def _live_sessions(db_engine, email=EMAIL) -> int:
    with db_engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT count(*) FROM user_sessions s JOIN users u ON u.id = s.user_id "
                "WHERE u.email = :email AND s.revoked_at IS NULL"
            ),
            {"email": email},
        ).scalar_one()


_HELD: list["Held"] = []


@pytest.fixture(autouse=True)
def _release_held_requests(make_cognito_client):
    """A failing test must not leave a request held: the app's shutdown would wait for it.
    Depending on make_cognito_client makes this teardown run before the apps shut down."""
    yield
    while _HELD:
        held = _HELD.pop()
        held.release.set()
        if held.thread is not None:
            held.thread.join(10)


class Held:
    """Holds one call of a fake Cognito operation until released (runs `during` first)."""

    def __init__(self, fake, operation, during=None):
        self.fake, self.operation, self.during = fake, operation, during
        self.entered, self.release = threading.Event(), threading.Event()
        self.thread: threading.Thread | None = None
        fake.hooks[operation] = self._hook
        _HELD.append(self)

    def _hook(self):
        del self.fake.hooks[self.operation]  # only the first call is held
        if self.during is not None:
            self.during()
        self.entered.set()
        assert self.release.wait(10)

    def run(self, request):
        result = {}
        thread = threading.Thread(target=lambda: result.setdefault("response", request()))
        self.thread = thread
        thread.start()
        assert self.entered.wait(10)
        return thread, result

    def finish(self, thread, result):
        self.release.set()
        thread.join(10)
        return result["response"]


# -- finding 2: admin revocation vs. sign-ins in progress -----------------------------------


def test_revoke_sessions_stops_a_sign_in_that_started_before_it(
    cognito_client, make_cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, PASSWORD)
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)  # an existing session
    other = make_cognito_client()
    sign_in(other, OTHER_EMAIL, PASSWORD)

    # A second sign-in passed Cognito (old credentials) and is held before its session exists.
    late = make_cognito_client()
    held = Held(fake_cognito, "InitiateAuth")
    thread, result = held.run(lambda: _login(late))
    assert admin(["revoke-sessions", EMAIL], sessionmaker(bind=db_engine), io.StringIO()) == 0
    response = held.finish(thread, result)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "password_changed"
    assert late.get("/api/auth/me").status_code == 401
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert _live_sessions(db_engine) == 0
    # Another user is untouched, and a sign-in that starts after the revocation works.
    assert other.get("/api/auth/me").status_code == 200
    fresh = make_cognito_client()
    sign_in(fresh, EMAIL, PASSWORD)
    assert fresh.get("/api/auth/me").status_code == 200


def test_disable_then_enable_does_not_revive_an_older_sign_in(
    cognito_client, make_cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)
    late = make_cognito_client()
    held = Held(fake_cognito, "InitiateAuth")
    thread, result = held.run(lambda: _login(late))
    factory = sessionmaker(bind=db_engine)
    assert admin(["disable", EMAIL], factory, io.StringIO()) == 0
    assert admin(["enable", EMAIL], factory, io.StringIO()) == 0
    response = held.finish(thread, result)

    assert response.status_code == 409
    assert late.get("/api/auth/me").status_code == 401
    assert _live_sessions(db_engine) == 0
    sign_in(make_cognito_client(), EMAIL, PASSWORD)  # re-enabled: new sign-ins work


def test_revoke_sessions_ends_a_pending_email_verification(
    cognito_client, make_cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, PASSWORD)
    sign_in(make_cognito_client(), EMAIL, PASSWORD)  # the user row exists
    fake_cognito.users[EMAIL].email_verified = False  # e.g. the address was changed
    challenge_id = _login(cognito_client).json()["challenge_id"]
    sent = cognito_client.post(
        "/api/auth/email-verification/send", json={"challenge_id": challenge_id}
    )
    assert sent.status_code == 200
    assert admin(["revoke-sessions", EMAIL], sessionmaker(bind=db_engine), io.StringIO()) == 0

    done = cognito_client.post(
        "/api/auth/email-verification/confirm",
        json={"challenge_id": challenge_id, "code": fake_cognito.users[EMAIL].verification_code},
    )
    assert done.status_code == 409
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert _live_sessions(db_engine) == 0
    sign_in(make_cognito_client(), EMAIL, PASSWORD)  # verified meanwhile; a new sign-in works


# -- finding 3: challenge lease ownership ---------------------------------------------------


def _verification_challenge(client, fake):
    fake.add_user(EMAIL, PASSWORD, email_verified=False)
    challenge_id = _login(client).json()["challenge_id"]
    sent = client.post("/api/auth/email-verification/send", json={"challenge_id": challenge_id})
    assert sent.status_code == 200
    return challenge_id, client.cookies.get(CHALLENGE_COOKIE)


def _expire_leases(db_engine):
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE auth_challenges SET locked_until = now() - interval '1 second'"))


def _claim(client, challenge_id, binding):
    services = client.app.state.services
    with session_scope(services.session_factory) as db:
        return claim_challenge(
            db,
            services.token_cipher,
            token=challenge_id,
            binding=binding,
            kind=ChallengeKind.EMAIL_VERIFICATION,
            lease_seconds=3600,
        )


def _confirm(client, challenge_id, code):
    return client.post(
        "/api/auth/email-verification/confirm", json={"challenge_id": challenge_id, "code": code}
    )


def test_a_stale_request_cannot_release_the_lease_of_the_new_holder(
    cognito_client, fake_cognito, db_engine
):
    challenge_id, binding = _verification_challenge(cognito_client, fake_cognito)
    taken = {}

    def lease_lost_to_b():
        _expire_leases(db_engine)  # A is slow: its lease runs out ...
        taken["b"] = _claim(cognito_client, challenge_id, binding)  # ... and B claims

    held = Held(fake_cognito, "VerifyUserAttribute", during=lease_lost_to_b)
    thread, result = held.run(lambda: _confirm(cognito_client, challenge_id, "000000"))
    response = held.finish(thread, result)
    assert response.json()["error"]["code"] in ("code_invalid", "challenge_busy")
    assert "b" in taken

    # B still holds the challenge: a third request cannot claim it.
    try:
        _claim(cognito_client, challenge_id, binding)
    except ChallengeBusy:
        pass
    else:
        raise AssertionError("A's late release opened B's lease")


def test_a_request_that_lost_its_lease_creates_no_session(cognito_client, fake_cognito, db_engine):
    challenge_id, binding = _verification_challenge(cognito_client, fake_cognito)
    code = fake_cognito.users[EMAIL].verification_code

    def lease_lost_to_b():
        _expire_leases(db_engine)
        _claim(cognito_client, challenge_id, binding)

    held = Held(fake_cognito, "VerifyUserAttribute", during=lease_lost_to_b)
    thread, result = held.run(lambda: _confirm(cognito_client, challenge_id, code))
    response = held.finish(thread, result)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "challenge_busy"
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert _live_sessions(db_engine) == 0
    with db_engine.connect() as conn:
        # The step is still open for its current holder (not consumed by A).
        assert conn.execute(text("SELECT consumed_at FROM auth_challenges")).scalar() is None


def test_a_challenge_that_expires_during_the_cognito_call_creates_no_session(
    cognito_client, make_cognito_client, fake_cognito, db_engine
):
    challenge_id, _ = _verification_challenge(cognito_client, fake_cognito)
    code = fake_cognito.users[EMAIL].verification_code

    def expire():
        with db_engine.begin() as conn:
            conn.execute(
                text("UPDATE auth_challenges SET expires_at = now() - interval '1 second'")
            )

    held = Held(fake_cognito, "VerifyUserAttribute", during=expire)
    thread, result = held.run(lambda: _confirm(cognito_client, challenge_id, code))
    response = held.finish(thread, result)

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "challenge_invalid"
    assert cognito_client.get("/api/auth/me").status_code == 401
    assert _live_sessions(db_engine) == 0
    # Cognito already verified the email (a side effect that cannot be undone): signing in again
    # goes straight to a session.
    sign_in(make_cognito_client(), EMAIL, PASSWORD)


def test_a_new_password_step_that_expires_during_the_call_creates_no_session(
    cognito_client, make_cognito_client, fake_cognito, db_engine
):
    fake_cognito.add_user(EMAIL, "Temp-pass-123", temporary=True)
    challenge_id = _login(cognito_client, password="Temp-pass-123").json()["challenge_id"]

    def expire():
        with db_engine.begin() as conn:
            conn.execute(
                text("UPDATE auth_challenges SET expires_at = now() - interval '1 second'")
            )

    held = Held(fake_cognito, "RespondToAuthChallenge", during=expire)
    thread, result = held.run(
        lambda: cognito_client.post(
            "/api/auth/new-password",
            json={"challenge_id": challenge_id, "new_password": NEW_PASSWORD},
        )
    )
    response = held.finish(thread, result)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "challenge_invalid"
    assert _live_sessions(db_engine) == 0
    # The new password is already active at Cognito; the user signs in with it.
    sign_in(make_cognito_client(), EMAIL, NEW_PASSWORD)


def test_retry_after_a_failed_attempt_still_works_with_leases(cognito_client, fake_cognito):
    challenge_id, _ = _verification_challenge(cognito_client, fake_cognito)
    assert _confirm(cognito_client, challenge_id, "000000").status_code in (400, 200)
    code = fake_cognito.users[EMAIL].verification_code
    if code == "000000":  # pragma: no cover - random code collided with the wrong one
        return
    done = _confirm(cognito_client, challenge_id, code)
    assert done.status_code == 200 and done.json()["status"] == "authenticated"
