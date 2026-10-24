"""Password reset across Cognito and PostgreSQL when one side fails (PostgreSQL, fake Cognito).

"Time passing" is simulated by moving `settle_at` in the database; nothing sleeps.
"""

import threading

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app.auth.cognito import CognitoError, CognitoErrorKind, HttpCognitoClient
from app.auth.service import (
    ChallengeBusy,
    ChallengeKind,
    LeaseOutcome,
    begin_password_reset,
    claim_challenge,
    consume_challenge,
    release_challenge,
)
from app.db import session_scope
from app.maintenance import run_cleanup
from tests.conftest import sign_in

EMAIL = "lan@example.com"
PASSWORD = "correct-horse-1"
NEW_PASSWORD = "a-new-password-2"
OTHER_EMAIL = "minh@example.com"


def _db_down(*args, **kwargs):
    raise OperationalError("simulated", None, Exception("database unavailable"))


def _reset(client, fake, code=None, email=EMAIL, password=NEW_PASSWORD):
    if code is None:
        assert client.post("/api/auth/forgot-password", json={"email": email}).status_code == 202
        code = fake.users[email].reset_code
    return client.post(
        "/api/auth/reset-password", json={"email": email, "code": code, "new_password": password}
    )


def _attempts(db_engine) -> list[str]:
    with db_engine.connect() as conn:
        return list(
            conn.execute(text("SELECT state FROM password_reset_attempts ORDER BY started_at"))
            .scalars()
            .all()
        )


def _settle_all(db_engine):
    """Every reset attempt settles now, as if its settle window had passed: later than every
    sign-in so far (as settle_at always is), earlier than every request that follows."""
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE password_reset_attempts SET settle_at = clock_timestamp()"))


def _login(client, email=EMAIL, password=PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


@pytest.fixture
def signed_in(cognito_client, make_cognito_client, fake_cognito):
    """The account owner on a laptop, plus another user who must never be affected."""
    fake_cognito.add_user(EMAIL, PASSWORD)
    fake_cognito.add_user(OTHER_EMAIL, PASSWORD)
    sign_in(cognito_client, EMAIL, PASSWORD)
    other = make_cognito_client()
    sign_in(other, OTHER_EMAIL, PASSWORD)
    return cognito_client, other


def test_cognito_succeeds_then_recording_fails_old_sessions_still_end(
    signed_in, make_cognito_client, fake_cognito, db_engine, monkeypatch
):
    laptop, other = signed_in
    monkeypatch.setattr("app.auth.router.finish_password_reset", _db_down)
    response = _reset(make_cognito_client(), fake_cognito)
    # The password is changed at Cognito: success, not a 500.
    assert response.status_code == 200 and response.json() == {"status": "password_reset"}
    assert _attempts(db_engine) == ["pending"]
    monkeypatch.undo()

    # Within the settle window the outcome is not known locally (documented window) ...
    assert laptop.get("/api/auth/me").status_code == 200
    _settle_all(db_engine)
    # ... once it has settled, every request refuses the old session, before any recovery ran.
    assert laptop.get("/api/auth/me").status_code == 401
    assert other.get("/api/auth/me").status_code == 200
    # A sign-in that starts now (new password) works.
    fresh = make_cognito_client()
    sign_in(fresh, EMAIL, NEW_PASSWORD)

    run_cleanup(laptop.app.state.services)  # recovery makes it permanent
    assert _attempts(db_engine) == ["unknown"]
    assert laptop.get("/api/auth/me").status_code == 401
    assert fresh.get("/api/auth/me").status_code == 200
    assert other.get("/api/auth/me").status_code == 200


@pytest.mark.parametrize("cognito_applied", [True, False])
def test_process_interrupted_after_the_intent_is_recovered_at_restart(
    signed_in, make_cognito_client, fake_cognito, db_engine, cognito_applied
):
    """The process died after committing the attempt (before or after Cognito applied it)."""
    laptop, other = signed_in
    services = laptop.app.state.services
    with session_scope(services.session_factory) as db:
        begin_password_reset(db, EMAIL, settle_seconds=80)
    if cognito_applied:
        fake_cognito.users[EMAIL].password = NEW_PASSWORD
    _settle_all(db_engine)

    restarted = make_cognito_client()  # startup recovery runs here
    assert _attempts(db_engine) == ["unknown"]
    assert laptop.get("/api/auth/me").status_code == 401  # fail closed either way
    assert other.get("/api/auth/me").status_code == 200
    current = NEW_PASSWORD if cognito_applied else PASSWORD
    sign_in(restarted, EMAIL, current)


@pytest.mark.parametrize("cognito_applied", [True, False])
def test_unknown_outcome_fails_closed_without_retry(
    signed_in, make_cognito_client, fake_cognito, db_engine, cognito_applied
):
    laptop, other = signed_in
    client = make_cognito_client()
    assert client.post("/api/auth/forgot-password", json={"email": EMAIL}).status_code == 202
    code = fake_cognito.users[EMAIL].reset_code

    def lost_answer():
        del fake_cognito.hooks["ConfirmForgotPassword"]
        if cognito_applied:  # Cognito changed the password, but the answer never arrived
            fake_cognito.users[EMAIL].password = NEW_PASSWORD
        raise CognitoError(CognitoErrorKind.UNAVAILABLE, "Timeout")

    fake_cognito.hooks["ConfirmForgotPassword"] = lost_answer
    response = _reset(client, fake_cognito, code=code)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "auth_unavailable"
    assert fake_cognito.calls.count("ConfirmForgotPassword") == 1  # never retried
    assert _attempts(db_engine) == ["unknown"]
    assert laptop.get("/api/auth/me").status_code == 401  # signed out at once
    assert other.get("/api/auth/me").status_code == 200

    current = NEW_PASSWORD if cognito_applied else PASSWORD
    # Until the attempt settles a delayed change may still land: sign-ins are refused ...
    early = _login(make_cognito_client(), password=current)
    assert early.status_code == 409 and early.json()["error"]["code"] == "password_changed"
    _settle_all(db_engine)
    sign_in(make_cognito_client(), EMAIL, current)  # ... afterwards they work


def test_a_wrong_code_never_signs_anyone_out(
    signed_in, make_cognito_client, fake_cognito, db_engine
):
    laptop, other = signed_in
    attacker = make_cognito_client(auth_recovery_max_per_client=100)
    for email in (EMAIL, "nobody@example.com"):
        response = _reset(attacker, fake_cognito, code="999999", email=email)
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "code_invalid"
    assert _attempts(db_engine) == ["rejected", "rejected"]
    _settle_all(db_engine)
    run_cleanup(laptop.app.state.services)
    assert laptop.get("/api/auth/me").status_code == 200
    assert other.get("/api/auth/me").status_code == 200
    sign_in(make_cognito_client(), EMAIL, PASSWORD)


def test_an_unrecorded_rejection_fails_closed(
    signed_in, make_cognito_client, fake_cognito, db_engine, monkeypatch
):
    """Documented trade-off: if even the rejection cannot be recorded, MyDubb cannot tell it
    from a success and revokes once the attempt settles."""
    laptop, other = signed_in
    monkeypatch.setattr("app.auth.router.finish_password_reset", _db_down)
    assert _reset(make_cognito_client(), fake_cognito, code="999999").status_code == 400
    monkeypatch.undo()
    assert laptop.get("/api/auth/me").status_code == 200  # not before it settles
    _settle_all(db_engine)
    assert laptop.get("/api/auth/me").status_code == 401
    assert other.get("/api/auth/me").status_code == 200


def test_nothing_is_sent_to_cognito_when_the_intent_cannot_be_recorded(
    signed_in, make_cognito_client, fake_cognito, monkeypatch
):
    laptop, _ = signed_in
    client = make_cognito_client()
    assert client.post("/api/auth/forgot-password", json={"email": EMAIL}).status_code == 202
    code = fake_cognito.users[EMAIL].reset_code
    monkeypatch.setattr("app.auth.router.begin_password_reset", _db_down)
    response = _reset(client, fake_cognito, code=code)
    assert response.status_code == 503
    assert "ConfirmForgotPassword" not in fake_cognito.calls
    assert fake_cognito.users[EMAIL].password == PASSWORD
    assert laptop.get("/api/auth/me").status_code == 200


def test_a_sign_in_racing_an_unrecorded_reset_does_not_survive(
    signed_in, make_cognito_client, fake_cognito, db_engine, monkeypatch
):
    laptop, other = signed_in
    entered, release = threading.Event(), threading.Event()

    def hold():
        del fake_cognito.hooks["InitiateAuth"]
        entered.set()
        assert release.wait(10)

    # Old password accepted; the sign-in is held before its session exists.
    fake_cognito.hooks["InitiateAuth"] = hold
    late = make_cognito_client()
    result = {}
    thread = threading.Thread(target=lambda: result.setdefault("r", _login(late)))
    thread.start()
    try:
        assert entered.wait(10)
        monkeypatch.setattr("app.auth.router.finish_password_reset", _db_down)
        assert _reset(make_cognito_client(), fake_cognito).status_code == 200
        monkeypatch.undo()
    finally:
        release.set()
        thread.join(10)

    # The attempt has not settled, so the sign-in got a session, but it does not survive.
    assert result["r"].status_code == 200
    _settle_all(db_engine)
    assert late.get("/api/auth/me").status_code == 401
    assert laptop.get("/api/auth/me").status_code == 401
    assert other.get("/api/auth/me").status_code == 200


# -- challenge leases (service level) ---------------------------------------------------------


def _pending_verification(client, fake):
    fake.add_user(EMAIL, PASSWORD, email_verified=False)
    challenge_id = client.post(
        "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
    ).json()["challenge_id"]
    return challenge_id, client.cookies.get("mydubb_auth_challenge")


def _claim(services, challenge_id, binding):
    with session_scope(services.session_factory) as db:
        return claim_challenge(
            db,
            services.token_cipher,
            token=challenge_id,
            binding=binding,
            kind=ChallengeKind.EMAIL_VERIFICATION,
            lease_seconds=3600,
        )


def _in_tx(services, work):
    with session_scope(services.session_factory) as db:
        return work(db)


def _expire_leases(db_engine):
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE auth_challenges SET locked_until = now() - interval '1 second'"))


def test_lease_operations_are_fenced_by_the_lease_token(cognito_client, fake_cognito, db_engine):
    services = cognito_client.app.state.services
    challenge_id, binding = _pending_verification(cognito_client, fake_cognito)
    a = _claim(services, challenge_id, binding)
    _expire_leases(db_engine)
    b = _claim(services, challenge_id, binding)
    assert a.lease != b.lease

    assert _in_tx(services, lambda db: release_challenge(db, a, failed_attempt=True)) is (
        LeaseOutcome.LOST
    )
    with pytest.raises(ChallengeBusy):  # B's lease is intact
        _claim(services, challenge_id, binding)
    assert _in_tx(services, lambda db: consume_challenge(db, a)) is LeaseOutcome.LOST
    with db_engine.connect() as conn:
        row = conn.execute(text("SELECT consumed_at, attempts FROM auth_challenges")).one()
    assert row.consumed_at is None and row.attempts == 0  # A changed nothing
    assert _in_tx(services, lambda db: consume_challenge(db, b)) is LeaseOutcome.DONE


def test_consuming_an_expired_step_closes_it_without_completing(
    cognito_client, fake_cognito, db_engine
):
    services = cognito_client.app.state.services
    challenge_id, binding = _pending_verification(cognito_client, fake_cognito)
    a = _claim(services, challenge_id, binding)
    with db_engine.begin() as conn:
        conn.execute(text("UPDATE auth_challenges SET expires_at = now() - interval '1 second'"))
    assert _in_tx(services, lambda db: consume_challenge(db, a)) is LeaseOutcome.EXPIRED
    with db_engine.connect() as conn:
        row = conn.execute(text("SELECT consumed_at, encrypted_payload FROM auth_challenges")).one()
    assert row.consumed_at is not None and row.encrypted_payload is None


def test_failed_attempts_still_close_the_step_with_leases(cognito_client, fake_cognito):
    services = cognito_client.app.state.services
    challenge_id, binding = _pending_verification(cognito_client, fake_cognito)
    for _ in range(5):
        claimed = _claim(services, challenge_id, binding)
        assert _in_tx(services, lambda db, c=claimed: release_challenge(db, c, failed_attempt=True))
    from app.auth.service import ChallengeInvalid

    with pytest.raises(ChallengeInvalid):
        _claim(services, challenge_id, binding)


# -- Cognito client response deadline ---------------------------------------------------------


def test_the_client_stops_reading_once_the_response_deadline_passed():
    now = [0.0]

    def clock():
        return now[0]

    def slow_body():
        for _ in range(5):
            now[0] += 4  # each chunk "takes" 4 s; the deadline is 10 s
            yield b" "

    def handler(request):
        return httpx.Response(200, content=slow_body())

    client = HttpCognitoClient(
        region="us-west-2",
        client_id="client1",
        client_secret=None,
        timeout_seconds=10,
        transport=httpx.MockTransport(handler),
        clock=clock,
    )
    with pytest.raises(CognitoError) as caught:
        client.forgot_password("a@b.co")
    assert caught.value.kind is CognitoErrorKind.UNAVAILABLE
    assert caught.value.aws_type == "Deadline"
