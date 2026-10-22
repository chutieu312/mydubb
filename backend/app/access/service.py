"""Access Code validation and server-side session lifecycle."""

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.access.models import AccessSession


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def access_code_matches(submitted: str, configured: str) -> bool:
    # Compare fixed-length digests in constant time so neither content nor length leaks.
    return hmac.compare_digest(_sha256(submitted), _sha256(configured))


@dataclass(frozen=True)
class IssuedSession:
    token: str  # raw cookie value; never stored server-side
    csrf_token: str
    expires_at: datetime


def create_session(db: Session, ttl_seconds: int) -> IssuedSession:
    now = datetime.now(UTC)
    token = secrets.token_urlsafe(32)
    record = AccessSession(
        token_hash=_sha256(token),
        csrf_token=secrets.token_urlsafe(32),
        created_at=now,
        expires_at=now + timedelta(seconds=ttl_seconds),
    )
    db.add(record)
    db.flush()
    return IssuedSession(token=token, csrf_token=record.csrf_token, expires_at=record.expires_at)


def find_active_session(db: Session, token: str) -> AccessSession | None:
    record = db.scalar(select(AccessSession).where(AccessSession.token_hash == _sha256(token)))
    if record is None or record.revoked_at is not None:
        return None
    if record.expires_at <= datetime.now(UTC):
        return None
    return record


def revoke_session(db: Session, record: AccessSession) -> None:
    record.revoked_at = datetime.now(UTC)


def delete_stale_sessions(db: Session) -> int:
    """Remove sessions that are expired or revoked. Their jobs keep metadata (owner set NULL)."""
    now = datetime.now(UTC)
    result = db.execute(
        delete(AccessSession).where(
            (AccessSession.expires_at <= now) | (AccessSession.revoked_at.is_not(None))
        )
    )
    return result.rowcount or 0  # type: ignore[attr-defined]
