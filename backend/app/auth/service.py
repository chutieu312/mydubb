"""Cognito-mode users, sessions, pending sign-in steps and password-reset revocation.

Every function here is a short database operation; callers run each one in its own
transaction and never hold a transaction open while waiting for Cognito.

**Pending steps (challenges).** `claim_challenge` is a compare-and-set `UPDATE` that takes a
short lease on an unexpired, unconsumed challenge of the expected kind whose token and browser
binding match; a second concurrent request finds the lease taken (`ChallengeBusy`) and a replay
after completion finds it consumed (`ChallengeInvalid`). After the Cognito call the caller
either consumes the challenge (its encrypted payload is erased) or releases the lease, counting
a failed attempt or a sent code.

**Password reset vs. sign-ins in flight.** A sign-in records `auth_started_at` from the
database clock before its first Cognito request; its session can only be created if no password
reset for that email completed at or after that instant. `record_password_reset` (after Cognito
confirmed the reset) and `establish_user_session` take the same transaction-scoped advisory lock
for the email, so one of them always sees the other's committed work: either the reset sees the
new session and revokes it, or the sign-in sees the reset (event row or the user's
`sessions_valid_after`) and creates no session. Sessions are also checked against
`sessions_valid_after` on every request.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth.cognito import CognitoUser
from app.auth.crypto import DecryptionError, TokenCipher
from app.auth.models import AuthChallenge, PasswordResetEvent, User, UserSession

MAX_CHALLENGE_ATTEMPTS = 5
MAX_VERIFICATION_SENDS = 3
# Long enough to cover any sign-in still in flight (the longest step lives an hour at most).
RESET_EVENT_RETENTION = timedelta(days=1)
_LOCK_TIMEOUT = "5s"
_MAX_DISPLAY_NAME = 200


class ChallengeKind(StrEnum):
    NEW_PASSWORD = "new_password"  # noqa: S105 (step name)
    EMAIL_VERIFICATION = "email_verification"


class ChallengeInvalid(Exception):
    """Unknown, expired, consumed, other kind or other browser (indistinguishable to clients)."""


class ChallengeBusy(Exception):
    """Another request currently holds the challenge."""


class AccountDisabled(Exception):
    pass


class PasswordChangedDuringSignIn(Exception):
    """A password reset completed after this sign-in started; no session is created."""


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_email(email: str) -> str:
    return email.strip().lower()


def database_now(db: Session) -> datetime:
    """The database clock (shared by every instance), not this process's clock."""
    return db.execute(text("SELECT clock_timestamp()")).scalar_one()


def _limit_lock_waits(db: Session) -> None:
    db.execute(text(f"SET LOCAL lock_timeout = '{_LOCK_TIMEOUT}'"))
    db.execute(text(f"SET LOCAL statement_timeout = '{_LOCK_TIMEOUT}'"))


def _lock_email(db: Session, email_hash: str) -> None:
    key = int.from_bytes(bytes.fromhex(email_hash)[:8], "big", signed=True)
    db.execute(select(func.pg_advisory_xact_lock(key)))


# -- pending sign-in steps --------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedChallenge:
    challenge_id: str  # returned to the client; only its hash is stored
    binding: str  # browser-binding cookie value; only its hash is stored
    expires_at: datetime


@dataclass(frozen=True)
class ClaimedChallenge:
    id: uuid.UUID
    payload: dict[str, Any]
    auth_started_at: datetime
    expires_at: datetime
    attempts: int
    sends: int


def _associated_data(challenge_id: uuid.UUID, kind: ChallengeKind) -> bytes:
    return challenge_id.bytes + kind.value.encode("ascii")


def create_challenge(
    db: Session,
    cipher: TokenCipher,
    *,
    kind: ChallengeKind,
    payload: dict[str, Any],
    auth_started_at: datetime,
    ttl_seconds: int,
) -> IssuedChallenge:
    now = datetime.now(UTC)
    row_id = uuid.uuid4()
    token = secrets.token_urlsafe(32)
    binding = secrets.token_urlsafe(32)
    record = AuthChallenge(
        id=row_id,
        token_hash=sha256_hex(token),
        binding_hash=sha256_hex(binding),
        kind=kind.value,
        encrypted_payload=cipher.encrypt(payload, _associated_data(row_id, kind)),
        auth_started_at=auth_started_at,
        created_at=now,
        expires_at=now + timedelta(seconds=ttl_seconds),
    )
    db.add(record)
    db.flush()
    return IssuedChallenge(challenge_id=token, binding=binding, expires_at=record.expires_at)


def claim_challenge(
    db: Session,
    cipher: TokenCipher,
    *,
    token: str,
    binding: str | None,
    kind: ChallengeKind,
    lease_seconds: float,
) -> ClaimedChallenge:
    if not token or not binding:
        raise ChallengeInvalid
    now = datetime.now(UTC)
    matches = (
        AuthChallenge.token_hash == sha256_hex(token),
        AuthChallenge.binding_hash == sha256_hex(binding),
        AuthChallenge.kind == kind.value,
        AuthChallenge.consumed_at.is_(None),
        AuthChallenge.expires_at > now,
    )
    row = db.execute(
        update(AuthChallenge)
        .where(
            *matches,
            or_(AuthChallenge.locked_until.is_(None), AuthChallenge.locked_until <= now),
        )
        .values(locked_until=now + timedelta(seconds=lease_seconds))
        .returning(
            AuthChallenge.id,
            AuthChallenge.encrypted_payload,
            AuthChallenge.auth_started_at,
            AuthChallenge.expires_at,
            AuthChallenge.attempts,
            AuthChallenge.sends,
        )
    ).one_or_none()
    if row is None:
        held = db.scalar(select(AuthChallenge.id).where(*matches))
        raise ChallengeBusy if held is not None else ChallengeInvalid
    try:
        if row.encrypted_payload is None:
            raise DecryptionError
        payload = cipher.decrypt(row.encrypted_payload, _associated_data(row.id, kind))
    except DecryptionError:
        # Unreadable (e.g. the key was rotated): the step cannot finish, so end it.
        consume_challenge(db, row.id)
        raise ChallengeInvalid from None
    return ClaimedChallenge(
        id=row.id,
        payload=payload,
        auth_started_at=row.auth_started_at,
        expires_at=row.expires_at,
        attempts=row.attempts,
        sends=row.sends,
    )


def consume_challenge(db: Session, challenge_id: uuid.UUID) -> None:
    db.execute(
        update(AuthChallenge)
        .where(AuthChallenge.id == challenge_id)
        .values(consumed_at=datetime.now(UTC), encrypted_payload=None, locked_until=None)
    )


def release_challenge(
    db: Session, challenge_id: uuid.UUID, *, failed_attempt: bool = False, sent: bool = False
) -> None:
    """End the lease. A failed attempt counts toward MAX_CHALLENGE_ATTEMPTS; the attempt that
    reaches it consumes the challenge."""
    attempts = AuthChallenge.attempts + (1 if failed_attempt else 0)
    db.execute(
        update(AuthChallenge)
        .where(AuthChallenge.id == challenge_id)
        .values(
            locked_until=None,
            attempts=attempts,
            sends=AuthChallenge.sends + (1 if sent else 0),
        )
    )
    if failed_attempt:
        db.execute(
            update(AuthChallenge)
            .where(
                AuthChallenge.id == challenge_id,
                AuthChallenge.attempts >= MAX_CHALLENGE_ATTEMPTS,
            )
            .values(consumed_at=datetime.now(UTC), encrypted_payload=None)
        )


# -- users and sessions -----------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedUserSession:
    token: str  # raw cookie value; never stored server-side
    csrf_token: str
    expires_at: datetime


def establish_user_session(
    db: Session,
    *,
    issuer: str,
    cognito_user: CognitoUser,
    auth_started_at: datetime,
    ttl_seconds: int,
) -> tuple[User, IssuedUserSession]:
    """Create or refresh the user (by issuer + sub) and open a session for this sign-in."""
    _limit_lock_waits(db)
    email_normalized = normalize_email(cognito_user.email)
    email_hash = sha256_hex(email_normalized)
    _lock_email(db, email_hash)

    last_reset = db.scalar(
        select(func.max(PasswordResetEvent.reset_at)).where(
            PasswordResetEvent.email_hash == email_hash
        )
    )
    if last_reset is not None and last_reset >= auth_started_at:
        raise PasswordChangedDuringSignIn

    now = datetime.now(UTC)
    profile = {
        "email": cognito_user.email[:320],
        "email_normalized": email_normalized[:320],
        "display_name": (cognito_user.name or "")[:_MAX_DISPLAY_NAME] or None,
        "updated_at": now,
        "last_login_at": now,
    }
    user = db.scalars(
        insert(User)
        .values(
            id=uuid.uuid4(),
            cognito_issuer=issuer,
            cognito_sub=cognito_user.sub,
            created_at=now,
            **profile,
        )
        .on_conflict_do_update(constraint="uq_users_cognito_identity", set_=profile)
        .returning(User),
        execution_options={"populate_existing": True},
    ).one()
    if user.disabled_at is not None:
        raise AccountDisabled
    if user.sessions_valid_after is not None and user.sessions_valid_after >= auth_started_at:
        raise PasswordChangedDuringSignIn

    token = secrets.token_urlsafe(32)
    record = UserSession(
        user_id=user.id,
        token_hash=sha256_hex(token),
        csrf_token=secrets.token_urlsafe(32),
        auth_started_at=auth_started_at,
        created_at=now,
        expires_at=now + timedelta(seconds=ttl_seconds),
    )
    db.add(record)
    db.flush()
    return user, IssuedUserSession(
        token=token, csrf_token=record.csrf_token, expires_at=record.expires_at
    )


def find_active_user_session(db: Session, token: str) -> tuple[UserSession, User] | None:
    """The session for this cookie if it is live and its user may use it."""
    row = db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.token_hash == sha256_hex(token),
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > datetime.now(UTC),
            User.disabled_at.is_(None),
            or_(
                User.sessions_valid_after.is_(None),
                UserSession.auth_started_at > User.sessions_valid_after,
            ),
        )
    ).one_or_none()
    return (row[0], row[1]) if row is not None else None


def revoke_user_session(db: Session, session_id: uuid.UUID) -> None:
    db.execute(
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )


def revoke_user_sessions(db: Session, user_ids: list[uuid.UUID]) -> int:
    if not user_ids:
        return 0
    result = db.execute(
        update(UserSession)
        .where(UserSession.user_id.in_(user_ids), UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]


def record_password_reset(db: Session, email: str) -> int:
    """After Cognito confirmed a reset: invalidate every session (and sign-in in flight) of the
    accounts with this email. Returns the number of sessions revoked."""
    _limit_lock_waits(db)
    email_normalized = normalize_email(email)
    email_hash = sha256_hex(email_normalized)
    _lock_email(db, email_hash)
    reset_at = database_now(db)
    db.add(PasswordResetEvent(email_hash=email_hash, reset_at=reset_at))
    user_ids = list(
        db.scalars(
            update(User)
            .where(User.email_normalized == email_normalized)
            .values(sessions_valid_after=reset_at, updated_at=reset_at)
            .returning(User.id)
            .execution_options(synchronize_session=False)
        )
    )
    return revoke_user_sessions(db, user_ids)


def delete_stale_auth_rows(db: Session) -> int:
    """Expired or revoked user sessions, finished or expired challenges, old reset events."""
    now = datetime.now(UTC)
    removed = 0
    for statement in (
        delete(UserSession).where(
            (UserSession.expires_at <= now) | UserSession.revoked_at.is_not(None)
        ),
        delete(AuthChallenge).where(
            (AuthChallenge.expires_at <= now) | AuthChallenge.consumed_at.is_not(None)
        ),
        delete(PasswordResetEvent).where(PasswordResetEvent.reset_at < now - RESET_EVENT_RETENTION),
    ):
        result = db.execute(statement.execution_options(synchronize_session=False))
        removed += result.rowcount or 0  # type: ignore[attr-defined]
    return removed
