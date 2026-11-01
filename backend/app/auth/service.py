"""Cognito-mode users, sessions, pending sign-in steps and password-reset revocation.

Every function here is a short database operation; callers run each one in its own
transaction and never hold a transaction open while waiting for Cognito.

**Pending steps (challenges).** `claim_challenge` is a compare-and-set `UPDATE` that takes a
short lease on an unexpired, unconsumed challenge of the expected kind whose token and browser
binding match, and stamps it with a fresh random `lease_token`; a second concurrent request
finds the lease taken (`ChallengeBusy`) and a replay after completion finds it consumed
(`ChallengeInvalid`). After the Cognito call the caller either consumes the challenge (its
encrypted payload is erased) or releases the lease, counting a failed attempt or a sent code.
Both are compare-and-set on the lease token, so a request whose lease ran out and was taken over
by another request changes nothing (`LeaseOutcome.LOST`); consuming also re-checks the expiry,
so a step that expired while Cognito was answering creates no session. The lease length only
decides when a stuck request may be taken over; correctness does not depend on it.

**Sign-ins that started before a revocation.** A sign-in records `auth_started_at` from the
database clock before its first Cognito request and carries it into its session. A revocation
moves `users.sessions_valid_after` to the database clock and revokes the existing sessions:

* password reset (`finish_password_reset`, `resolve_stale_password_resets`) takes the
  transaction-scoped advisory lock of the email, like `establish_user_session`, and also writes
  a `password_reset_events` row for a first sign-in whose user row does not exist yet;
* administrator revocation and disabling (`revoke_user_access`) update the user row, whose row
  lock `establish_user_session` also takes (its upsert), with `clock_timestamp()` evaluated after
  that lock is held.

Either the revocation sees the new session (and revokes it) or the sign-in sees the revocation
(and creates no session). Every request also requires `auth_started_at > sessions_valid_after`.

**Password reset across Cognito and PostgreSQL** (no distributed transaction exists between
them). `begin_password_reset` commits a `pending` attempt *before* `ConfirmForgotPassword` is
sent (if that write fails, nothing is sent). The outcome is recorded afterwards
(`finish_password_reset`): `succeeded` and `unknown` (no answer, timeout, 5xx) revoke, `rejected`
(e.g. a wrong code) does nothing. If the outcome cannot be recorded (database error, crash), the
attempt stays `pending`; once its `settle_at` has passed, every request treats sessions that
started before `settle_at` as revoked, sign-ins that started before it are refused, and
`resolve_stale_password_resets` (startup and periodic cleanup) records it as `unknown` and
revokes for good. A pending attempt that has not settled yet blocks nothing, so a wrong code
never signs anyone out, unless recording the rejection itself fails.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import ColumnElement, delete, exists, func, literal, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth.cognito import CognitoUser
from app.auth.crypto import DecryptionError, TokenCipher
from app.auth.models import (
    AuthChallenge,
    ExtensionAuthCode,
    PasswordResetAttempt,
    PasswordResetEvent,
    SessionClient,
    User,
    UserRole,
    UserRoleEvent,
    UserSession,
)

MAX_CHALLENGE_ATTEMPTS = 5
MAX_VERIFICATION_SENDS = 3
# Long enough to cover any sign-in still in flight (the longest step lives an hour at most).
RESET_EVENT_RETENTION = timedelta(days=1)
# Added to MyDubb's own bound on a Cognito request to get `settle_at`: an assumption (not a
# guarantee Cognito documents) that a request MyDubb gave up on is applied or dropped by then.
RESET_SETTLE_MARGIN_SECONDS = 60
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
    """The account's access was revoked (password reset, administrator) after this sign-in
    started; no session is created."""


class RoleChangeRefused(Exception):
    """A role change that is not allowed; the message is meant for the administrator."""


class LeaseOutcome(StrEnum):
    DONE = "done"
    LOST = "lost"  # another request took the challenge over; nothing was changed
    EXPIRED = "expired"  # the step expired before it could be completed; it is now closed


class ResetOutcome(StrEnum):
    SUCCEEDED = "succeeded"
    REJECTED = "rejected"
    UNKNOWN = "unknown"


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _email_hash_sql(column: Any) -> ColumnElement[str]:
    """SQL equivalent of sha256_hex(column) for a text column."""
    return func.encode(func.sha256(func.convert_to(column, literal("UTF8"))), literal("hex"))


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
    lease: str  # this request's lease token
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
    lease = secrets.token_urlsafe(24)
    row = db.execute(
        update(AuthChallenge)
        .where(
            *matches,
            or_(AuthChallenge.locked_until.is_(None), AuthChallenge.locked_until <= now),
        )
        .values(locked_until=now + timedelta(seconds=lease_seconds), lease_token=lease)
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
    claimed = ClaimedChallenge(
        id=row.id,
        lease=lease,
        payload={},
        auth_started_at=row.auth_started_at,
        expires_at=row.expires_at,
        attempts=row.attempts,
        sends=row.sends,
    )
    try:
        if row.encrypted_payload is None:
            raise DecryptionError
        payload = cipher.decrypt(row.encrypted_payload, _associated_data(row.id, kind))
    except DecryptionError:
        # Unreadable (e.g. the key was rotated): the step cannot finish, so end it.
        consume_challenge(db, claimed)
        raise ChallengeInvalid from None
    return replace(claimed, payload=payload)


def _closed_values() -> dict[str, Any]:
    return {
        "consumed_at": datetime.now(UTC),
        "encrypted_payload": None,
        "locked_until": None,
        "lease_token": None,
    }


def consume_challenge(db: Session, claimed: ClaimedChallenge) -> LeaseOutcome:
    """Complete the step, if this request still holds the lease and it has not expired.

    LOST: another request holds or finished it (nothing changed). EXPIRED: it expired while this
    request worked on it; it is closed without completing.
    """
    now = datetime.now(UTC)
    owned = (
        AuthChallenge.id == claimed.id,
        AuthChallenge.lease_token == claimed.lease,
        AuthChallenge.consumed_at.is_(None),
    )
    done = db.execute(
        update(AuthChallenge)
        .where(*owned, AuthChallenge.expires_at > now)
        .values(**_closed_values())
        .returning(AuthChallenge.id)
    ).one_or_none()
    if done is not None:
        return LeaseOutcome.DONE
    closed = db.execute(
        update(AuthChallenge).where(*owned).values(**_closed_values()).returning(AuthChallenge.id)
    ).one_or_none()
    return LeaseOutcome.EXPIRED if closed is not None else LeaseOutcome.LOST


def release_challenge(
    db: Session, claimed: ClaimedChallenge, *, failed_attempt: bool = False, sent: bool = False
) -> LeaseOutcome:
    """End this request's lease (only if it still holds it). A failed attempt counts toward
    MAX_CHALLENGE_ATTEMPTS; the attempt that reaches it closes the challenge."""
    released = db.execute(
        update(AuthChallenge)
        .where(
            AuthChallenge.id == claimed.id,
            AuthChallenge.lease_token == claimed.lease,
            AuthChallenge.consumed_at.is_(None),
        )
        .values(
            locked_until=None,
            lease_token=None,
            attempts=AuthChallenge.attempts + (1 if failed_attempt else 0),
            sends=AuthChallenge.sends + (1 if sent else 0),
        )
        .returning(AuthChallenge.attempts)
    ).one_or_none()
    if released is None:
        return LeaseOutcome.LOST
    if released.attempts >= MAX_CHALLENGE_ATTEMPTS:
        # The row is still locked by the update above, so no other request got in between.
        db.execute(
            update(AuthChallenge).where(AuthChallenge.id == claimed.id).values(**_closed_values())
        )
    return LeaseOutcome.DONE


# -- users and sessions -----------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedUserSession:
    token: str  # raw cookie value; never stored server-side
    csrf_token: str
    expires_at: datetime


def _unsettled_reset_blocks(email_hash: Any, auth_started_at: Any) -> ColumnElement[bool]:
    """A reset attempt that may have changed the password after this sign-in started: still
    `pending` past `settle_at` (its outcome was never recorded), or recorded as `unknown`."""
    return exists().where(
        PasswordResetAttempt.email_hash == email_hash,
        PasswordResetAttempt.settle_at > auth_started_at,
        or_(
            PasswordResetAttempt.state == ResetOutcome.UNKNOWN.value,
            (PasswordResetAttempt.state == "pending")
            & (PasswordResetAttempt.settle_at <= func.now()),
        ),
    )


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
    if db.scalar(select(_unsettled_reset_blocks(email_hash, auth_started_at))):
        raise PasswordChangedDuringSignIn

    now = datetime.now(UTC)
    profile = {
        "email": cognito_user.email[:320],
        "email_normalized": email_normalized[:320],
        "display_name": (cognito_user.name or "")[:_MAX_DISPLAY_NAME] or None,
        "updated_at": now,
        "last_login_at": now,
    }
    # The upsert takes the user row lock and returns the row's latest committed version, so an
    # administrator revocation committed meanwhile is seen here (see revoke_user_access).
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


def open_extension_session(
    db: Session, *, user_id: uuid.UUID, auth_started_at: datetime, ttl_seconds: int
) -> tuple[User, IssuedUserSession] | None:
    """A session for the Chrome extension, from a sign-in (website session) that started at
    `auth_started_at`. Takes the same locks and applies the same revocation rules as
    `establish_user_session`, so a password reset, an administrator revocation or disabling that
    covers that sign-in also prevents this session. None when the user may not have one."""
    _limit_lock_waits(db)
    email = db.scalar(select(User.email_normalized).where(User.id == user_id))
    if email is None:
        return None
    email_hash = sha256_hex(email)
    _lock_email(db, email_hash)
    user = db.scalars(
        select(User).where(User.id == user_id).with_for_update(),
        execution_options={"populate_existing": True},
    ).one_or_none()
    if user is None or user.disabled_at is not None:
        return None
    if user.sessions_valid_after is not None and user.sessions_valid_after >= auth_started_at:
        return None
    last_reset = db.scalar(
        select(func.max(PasswordResetEvent.reset_at)).where(
            PasswordResetEvent.email_hash == email_hash
        )
    )
    if last_reset is not None and last_reset >= auth_started_at:
        return None
    if db.scalar(select(_unsettled_reset_blocks(email_hash, auth_started_at))):
        return None
    now = datetime.now(UTC)
    token = secrets.token_urlsafe(32)
    record = UserSession(
        user_id=user.id,
        client=SessionClient.EXTENSION.value,
        token_hash=sha256_hex(token),
        # Never sent to the extension: a bearer token needs no CSRF token.
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


def find_active_user_session(
    db: Session, token: str, client: SessionClient = SessionClient.WEB
) -> tuple[UserSession, User] | None:
    """The session for this token if it is live, was issued to `client` (a cookie never
    accepts an extension token, nor the reverse) and its user may use it."""
    unsettled_reset = exists().where(
        PasswordResetAttempt.email_hash == _email_hash_sql(User.email_normalized),
        PasswordResetAttempt.state == "pending",
        PasswordResetAttempt.settle_at <= func.now(),
        UserSession.auth_started_at < PasswordResetAttempt.settle_at,
    )
    row = db.execute(
        select(UserSession, User)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.token_hash == sha256_hex(token),
            UserSession.client == client.value,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > datetime.now(UTC),
            User.disabled_at.is_(None),
            or_(
                User.sessions_valid_after.is_(None),
                UserSession.auth_started_at > User.sessions_valid_after,
            ),
            ~unsettled_reset,
        )
    ).one_or_none()
    return (row[0], row[1]) if row is not None else None


def revoke_user_session(db: Session, session_id: uuid.UUID) -> None:
    db.execute(
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )


def _revoke_sessions_started_before(
    db: Session, user_ids: list[uuid.UUID], instant: datetime | ColumnElement[datetime]
) -> int:
    if not user_ids:
        return 0
    result = db.execute(
        update(UserSession)
        .where(
            UserSession.user_id.in_(user_ids),
            UserSession.revoked_at.is_(None),
            UserSession.auth_started_at <= instant,
        )
        .values(revoked_at=datetime.now(UTC))
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]


def revoke_user_access(db: Session, user_id: uuid.UUID, *, disable: bool = False) -> int:
    """Administrator revocation: end the user's sessions and every sign-in or pending step that
    started before now (database clock); optionally also disable the user. Returns the number
    of sessions revoked. Re-enabling (`enable_user`) never undoes the revocation."""
    _limit_lock_waits(db)
    values: dict[str, Any] = {
        # Evaluated once the row lock is held (after a concurrent sign-in's upsert, if any).
        "sessions_valid_after": func.clock_timestamp(),
        "updated_at": func.clock_timestamp(),
    }
    if disable:
        values["disabled_at"] = func.clock_timestamp()
    instant = db.execute(
        update(User)
        .where(User.id == user_id)
        .values(**values)
        .returning(User.sessions_valid_after)
        .execution_options(synchronize_session=False)
    ).scalar_one()
    # A new statement: it also sees a session committed by a sign-in that held the row first.
    return _revoke_sessions_started_before(db, [user_id], instant)


def enable_user(db: Session, user_id: uuid.UUID) -> None:
    """Allow new sign-ins again. `sessions_valid_after` is kept, so a sign-in that started
    before the user was disabled still cannot complete."""
    db.execute(
        update(User)
        .where(User.id == user_id)
        .values(disabled_at=None, updated_at=func.clock_timestamp())
        .execution_options(synchronize_session=False)
    )


# -- roles ------------------------------------------------------------------------------------


def _lock_user_for_role_change(db: Session, user_id: uuid.UUID) -> User:
    _limit_lock_waits(db)
    user = db.scalars(
        select(User).where(User.id == user_id).with_for_update(),
        execution_options={"populate_existing": True},
    ).one_or_none()
    if user is None:
        raise RoleChangeRefused("no such user")
    return user


def _change_role(db: Session, user: User, role: UserRole, changed_by: str) -> bool:
    """Set the role and record the change, in the caller's transaction. False: it already was."""
    old_role = user.role
    if old_role == role.value:
        return False
    now = database_now(db)
    user.role = role.value
    user.updated_at = now
    db.add(
        UserRoleEvent(
            user_id=user.id,
            old_role=old_role,
            new_role=role.value,
            changed_by=changed_by[:200],
            changed_at=now,
        )
    )
    db.flush()
    return True


def grant_admin(db: Session, user_id: uuid.UUID, *, confirm_email: str, changed_by: str) -> bool:
    """Make exactly this user an administrator, if `confirm_email` is this user's current email
    and the user is not disabled (an `enable` would otherwise bring back an administrator nobody
    was looking at). The role applies from the user's next request. False: already one."""
    user = _lock_user_for_role_change(db, user_id)
    if user.email_normalized != normalize_email(confirm_email):
        raise RoleChangeRefused("this email is not the email of that user id; nothing changed")
    if user.disabled_at is not None:
        raise RoleChangeRefused("this user is disabled; nothing changed")
    return _change_role(db, user, UserRole.ADMIN, changed_by)


def revoke_admin(db: Session, user_id: uuid.UUID, *, changed_by: str) -> bool:
    """Make this user an ordinary user again, also while disabled. Sessions stay valid, as an
    ordinary user's, and the next request is no longer an administrator's. False: it wasn't one."""
    return _change_role(db, _lock_user_for_role_change(db, user_id), UserRole.USER, changed_by)


# -- password reset ---------------------------------------------------------------------------


def begin_password_reset(db: Session, email: str, settle_seconds: float) -> uuid.UUID:
    """Record the intent before Cognito is asked to change the password."""
    started = database_now(db)
    attempt = PasswordResetAttempt(
        id=uuid.uuid4(),
        email_hash=sha256_hex(normalize_email(email)),
        state="pending",
        started_at=started,
        settle_at=started + timedelta(seconds=settle_seconds),
    )
    db.add(attempt)
    db.flush()
    return attempt.id


def _apply_reset(db: Session, email_hash: str, effective_at: datetime) -> int:
    """Sessions (and sign-ins in flight) that started at or before `effective_at` are revoked
    for every account whose email matches."""
    db.add(PasswordResetEvent(email_hash=email_hash, reset_at=effective_at))
    user_ids = list(
        db.scalars(
            update(User)
            .where(_email_hash_sql(User.email_normalized) == email_hash)
            .values(
                sessions_valid_after=func.greatest(
                    func.coalesce(User.sessions_valid_after, effective_at), effective_at
                ),
                updated_at=func.clock_timestamp(),
            )
            .returning(User.id)
            .execution_options(synchronize_session=False)
        )
    )
    return _revoke_sessions_started_before(db, user_ids, effective_at)


def finish_password_reset(
    db: Session, attempt_id: uuid.UUID, email: str, outcome: ResetOutcome
) -> int:
    """Record Cognito's answer. `succeeded` and `unknown` revoke the account's sessions (and
    sign-ins in flight); `unknown` additionally keeps refusing sign-ins that started before
    `settle_at`, since the change may still be applied. Returns the sessions revoked."""
    _limit_lock_waits(db)
    email_hash = sha256_hex(normalize_email(email))
    _lock_email(db, email_hash)
    db.execute(
        update(PasswordResetAttempt)
        .where(PasswordResetAttempt.id == attempt_id, PasswordResetAttempt.state == "pending")
        .values(state=outcome.value, resolved_at=func.clock_timestamp())
    )
    # Even if recovery already recorded the attempt as unknown, a confirmed success revokes
    # again up to now (harmless, and never weaker).
    if outcome is ResetOutcome.REJECTED:
        return 0
    return _apply_reset(db, email_hash, database_now(db))


def resolve_stale_password_resets(db: Session) -> int:
    """Attempts whose outcome was never recorded and whose `settle_at` has passed: record them as
    `unknown` and revoke up to `settle_at` (fail closed). Returns the attempts resolved."""
    _limit_lock_waits(db)
    stale = db.execute(
        select(PasswordResetAttempt.id, PasswordResetAttempt.email_hash)
        .where(
            PasswordResetAttempt.state == "pending",
            PasswordResetAttempt.settle_at <= func.now(),
        )
        .order_by(PasswordResetAttempt.email_hash)
    ).all()
    resolved = 0
    for attempt_id, email_hash in stale:
        _lock_email(db, email_hash)
        settle_at = db.scalar(
            update(PasswordResetAttempt)
            .where(PasswordResetAttempt.id == attempt_id, PasswordResetAttempt.state == "pending")
            .values(state=ResetOutcome.UNKNOWN.value, resolved_at=func.clock_timestamp())
            .returning(PasswordResetAttempt.settle_at)
        )
        if settle_at is not None:  # not recorded by its own request meanwhile
            _apply_reset(db, email_hash, settle_at)
            resolved += 1
    return resolved


def delete_stale_auth_rows(db: Session) -> int:
    """Expired or revoked user sessions, finished or expired challenges and extension codes, old
    reset events and old resolved reset attempts. A pending attempt is never deleted."""
    now = datetime.now(UTC)
    old = now - RESET_EVENT_RETENTION
    removed = 0
    for statement in (
        delete(UserSession).where(
            (UserSession.expires_at <= now) | UserSession.revoked_at.is_not(None)
        ),
        delete(AuthChallenge).where(
            (AuthChallenge.expires_at <= now) | AuthChallenge.consumed_at.is_not(None)
        ),
        delete(ExtensionAuthCode).where(
            (ExtensionAuthCode.expires_at <= now) | ExtensionAuthCode.consumed_at.is_not(None)
        ),
        delete(PasswordResetEvent).where(PasswordResetEvent.reset_at < old),
        delete(PasswordResetAttempt).where(
            PasswordResetAttempt.state != "pending",
            PasswordResetAttempt.settle_at < old,
            PasswordResetAttempt.resolved_at < old,
        ),
    ):
        result = db.execute(statement.execution_options(synchronize_session=False))
        removed += result.rowcount or 0  # type: ignore[attr-defined]
    return removed
