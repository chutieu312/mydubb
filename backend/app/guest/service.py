"""Guest sessions and the guest job quotas (docs/GUEST_ACCESS.md).

Every function is a short database operation run in the caller's transaction.

**Quotas.** A guest job holds a place in two quotas: its guest session (`jobs_per_session`
completed jobs over the session's lifetime) and its client network (`jobs_per_ip` completed jobs
in a sliding window, shared by every guest session from that network). `reserve_job` checks
both and writes the job row and its `guest_job_quota` row (`reserved`) in one transaction, under
the guest session's row lock and a transaction-scoped advisory lock of the network, always taken
in that order: concurrent requests of one session or one network are serialized, so together
they can never pass a quota. A reserved place counts like a used one until the job ends.

**Settling.** `settle_jobs` runs in the same transaction as every terminal job transition
(completed: `used`; failed, including interrupted: `released`) and changes only rows still
`reserved`, so a place is charged or given back exactly once whatever runs it twice. Startup
recovery and the liveness check only fail jobs whose heartbeat is stale, so a job still running
on another live instance keeps its place. The periodic cleanup also settles any reserved row
whose job already ended (e.g. a job failed by an instance running older code).

**Time.** Window arithmetic uses the database clock, shared by every instance.
"""

import hashlib
import secrets
import uuid
from collections.abc import Callable, Collection
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, case, delete, func, or_, select, text, update
from sqlalchemy.orm import Session

from app.auth.service import database_now
from app.config import Settings
from app.guest.models import GuestJobQuota, GuestSession, QuotaState
from app.jobs.models import Job, JobStatus

# Namespace of this module's advisory locks (two-key form), apart from the auth locks.
_LOCK_NAMESPACE = 0x67756573  # "gues"
_SESSION_START_LOCK = 0
_LOCK_TIMEOUT = "5s"


@dataclass(frozen=True)
class GuestPolicy:
    session_ttl_seconds: int
    jobs_per_session: int
    jobs_per_ip: int
    ip_window_seconds: int
    max_words: int
    sessions_per_ip: int
    sessions_global: int
    session_rate_window_seconds: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "GuestPolicy":
        return cls(
            session_ttl_seconds=settings.guest_session_ttl_seconds,
            jobs_per_session=settings.guest_jobs_per_session,
            jobs_per_ip=settings.guest_jobs_per_ip,
            ip_window_seconds=settings.guest_ip_window_seconds,
            max_words=settings.guest_max_words,
            sessions_per_ip=settings.guest_sessions_per_ip,
            sessions_global=settings.guest_sessions_global,
            session_rate_window_seconds=settings.guest_session_rate_window_seconds,
        )


class GuestSessionsExhausted(Exception):
    """Too many guest sessions were started recently (from this network, or overall)."""

    def __init__(self, retry_after: int | None) -> None:
        super().__init__("guest sessions exhausted")
        self.retry_after = retry_after


class GuestQuotaExceeded(Exception):
    """The guest session or the client network has no job left."""

    def __init__(self, scope: str, retry_after: int | None, in_flight: int) -> None:
        super().__init__(f"guest {scope} quota exceeded")
        self.scope = scope  # "session" or "ip"
        self.retry_after = retry_after
        self.in_flight = in_flight  # places held by jobs that are still running


class GuestSessionGone(Exception):
    """The guest session expired or ended while the request was being handled."""


@dataclass(frozen=True)
class IssuedGuestSession:
    id: uuid.UUID
    token: str  # raw cookie value; only its hash is stored
    csrf_token: str
    expires_at: datetime


@dataclass(frozen=True)
class QuotaStatus:
    session_limit: int
    session_used: int
    session_in_progress: int
    ip_limit: int
    # None when the caller's network cannot be told (then no job can be accepted either).
    ip_used: int | None
    ip_in_progress: int | None
    ip_retry_after_seconds: int | None

    @property
    def session_remaining(self) -> int:
        return max(0, self.session_limit - self.session_used - self.session_in_progress)

    @property
    def ip_remaining(self) -> int | None:
        if self.ip_used is None or self.ip_in_progress is None:
            return None
        return max(0, self.ip_limit - self.ip_used - self.ip_in_progress)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _limit_lock_waits(db: Session) -> None:
    db.execute(text(f"SET LOCAL lock_timeout = '{_LOCK_TIMEOUT}'"))


def _advisory_lock(db: Session, key: int) -> None:
    db.execute(select(func.pg_advisory_xact_lock(_LOCK_NAMESPACE, key)))


def _network_lock_key(ip_key: str) -> int:
    return int.from_bytes(bytes.fromhex(ip_key)[:4], "big", signed=True)


def _seconds_until(moment: datetime, now: datetime) -> int:
    return max(1, int((moment - now).total_seconds() + 0.999))


# -- sessions ---------------------------------------------------------------------------------


def start_session(db: Session, *, ip_key: str, policy: GuestPolicy) -> IssuedGuestSession:
    """Open a new guest session, unless too many were started recently."""
    _limit_lock_waits(db)
    # Starting a session is rare; one lock keeps both counts exact under concurrency.
    _advisory_lock(db, _SESSION_START_LOCK)
    now = database_now(db)
    since = now - timedelta(seconds=policy.session_rate_window_seconds)
    recent = select(GuestSession.created_at).where(GuestSession.created_at > since)
    waits: list[int] = []
    from_network = db.scalars(
        recent.where(GuestSession.ip_key == ip_key).order_by(GuestSession.created_at)
    ).all()
    if len(from_network) >= policy.sessions_per_ip:
        oldest = from_network[len(from_network) - policy.sessions_per_ip]
        waits.append(_seconds_until(oldest + (now - since), now))
    overall = db.scalar(select(func.count()).select_from(recent.subquery())) or 0
    if overall >= policy.sessions_global:
        waits.append(policy.session_rate_window_seconds)
    if waits:
        raise GuestSessionsExhausted(max(waits))

    token = secrets.token_urlsafe(32)
    record = GuestSession(
        id=uuid.uuid4(),
        token_hash=_sha256(token),
        csrf_token=secrets.token_urlsafe(32),
        ip_key=ip_key,
        created_at=now,
        expires_at=now + timedelta(seconds=policy.session_ttl_seconds),
    )
    db.add(record)
    db.flush()
    return IssuedGuestSession(
        id=record.id, token=token, csrf_token=record.csrf_token, expires_at=record.expires_at
    )


def find_active_session(db: Session, token: str) -> GuestSession | None:
    return db.scalar(
        select(GuestSession).where(
            GuestSession.token_hash == _sha256(token),
            GuestSession.revoked_at.is_(None),
            GuestSession.expires_at > func.now(),
        )
    )


def revoke_session(db: Session, session_id: uuid.UUID) -> None:
    db.execute(
        update(GuestSession)
        .where(GuestSession.id == session_id, GuestSession.revoked_at.is_(None))
        .values(revoked_at=func.now())
    )


def revoke_session_by_token(db: Session, token: str) -> None:
    """End the guest session of a cookie (an account sign-in replaces it)."""
    db.execute(
        update(GuestSession)
        .where(GuestSession.token_hash == _sha256(token), GuestSession.revoked_at.is_(None))
        .values(revoked_at=func.now())
    )


# -- quotas -----------------------------------------------------------------------------------

_COUNTED = (QuotaState.RESERVED.value, QuotaState.USED.value)


def _session_counts(db: Session, guest_session_id: uuid.UUID) -> tuple[int, int]:
    rows = db.execute(
        select(GuestJobQuota.state, func.count())
        .where(GuestJobQuota.guest_session_id == guest_session_id)
        .where(GuestJobQuota.state.in_(_COUNTED))
        .group_by(GuestJobQuota.state)
    ).all()
    counts = {state: count for state, count in rows}
    return counts.get(QuotaState.USED.value, 0), counts.get(QuotaState.RESERVED.value, 0)


def _network_counts(
    db: Session, ip_key: str, now: datetime, policy: GuestPolicy
) -> tuple[int, int, datetime | None]:
    """Used jobs in the window, jobs in flight, and when the oldest used one leaves the window."""
    cutoff = now - timedelta(seconds=policy.ip_window_seconds)
    used = and_(GuestJobQuota.state == QuotaState.USED.value, GuestJobQuota.charged_at > cutoff)
    row = db.execute(
        select(
            func.count().filter(used),
            func.count().filter(GuestJobQuota.state == QuotaState.RESERVED.value),
            func.min(GuestJobQuota.charged_at).filter(used),
        ).where(GuestJobQuota.ip_key == ip_key)
    ).one()
    oldest = row[2]
    frees_at = oldest + timedelta(seconds=policy.ip_window_seconds) if oldest else None
    return row[0] or 0, row[1] or 0, frees_at


def quota_status(
    db: Session, *, guest_session_id: uuid.UUID, ip_key: str | None, policy: GuestPolicy
) -> QuotaStatus:
    session_used, session_reserved = _session_counts(db, guest_session_id)
    ip_used = ip_reserved = retry = None
    if ip_key is not None:
        now = database_now(db)
        ip_used, ip_reserved, frees_at = _network_counts(db, ip_key, now, policy)
        if frees_at is not None and ip_used + ip_reserved >= policy.jobs_per_ip:
            retry = _seconds_until(frees_at, now)
    return QuotaStatus(
        session_limit=policy.jobs_per_session,
        session_used=session_used,
        session_in_progress=session_reserved,
        ip_limit=policy.jobs_per_ip,
        ip_used=ip_used,
        ip_in_progress=ip_reserved,
        ip_retry_after_seconds=retry,
    )


def reserve_job(
    db: Session,
    *,
    guest_session_id: uuid.UUID,
    ip_key: str,
    policy: GuestPolicy,
    create_job: Callable[[], Job],
) -> Job:
    """Check both quotas and create the job with its reserved place, atomically.

    Raises GuestQuotaExceeded (nothing written) or GuestSessionGone. The caller commits.
    """
    _limit_lock_waits(db)
    locked = db.scalar(
        select(GuestSession.id)
        .where(
            GuestSession.id == guest_session_id,
            GuestSession.revoked_at.is_(None),
            GuestSession.expires_at > func.now(),
        )
        .with_for_update()
    )
    if locked is None:
        raise GuestSessionGone
    _advisory_lock(db, _network_lock_key(ip_key))
    now = database_now(db)

    session_used, session_reserved = _session_counts(db, guest_session_id)
    if session_used + session_reserved >= policy.jobs_per_session:
        raise GuestQuotaExceeded("session", None, session_reserved)
    ip_used, ip_reserved, frees_at = _network_counts(db, ip_key, now, policy)
    if ip_used + ip_reserved >= policy.jobs_per_ip:
        retry = _seconds_until(frees_at, now) if frees_at is not None else None
        raise GuestQuotaExceeded("ip", retry, ip_reserved)

    job = create_job()
    db.add(
        GuestJobQuota(
            job_id=job.id,
            guest_session_id=guest_session_id,
            ip_key=ip_key,
            state=QuotaState.RESERVED.value,
            reserved_at=now,
            charged_at=now,
        )
    )
    db.flush()
    return job


def settle_jobs(db: Session, job_ids: Collection[uuid.UUID] | None = None) -> int:
    """Charge (completed) or give back (failed) the reserved places of jobs that have ended.

    Only `reserved` rows change, so running it again (or concurrently) changes nothing more.
    `job_ids=None` settles every ended job (periodic safety net).
    """
    condition = [
        GuestJobQuota.job_id == Job.id,
        GuestJobQuota.state == QuotaState.RESERVED.value,
        Job.status.in_((JobStatus.COMPLETED, JobStatus.FAILED)),
    ]
    if job_ids is not None:
        if not job_ids:
            return 0
        condition.append(GuestJobQuota.job_id.in_(list(job_ids)))
    completed = Job.status == JobStatus.COMPLETED
    now = func.clock_timestamp()
    result = db.execute(
        update(GuestJobQuota)
        .where(*condition)
        .values(
            state=case((completed, QuotaState.USED.value), else_=QuotaState.RELEASED.value),
            # A used job counts in the network window from its completion.
            charged_at=case((completed, now), else_=GuestJobQuota.charged_at),
            settled_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]


def delete_stale_rows(db: Session, policy: GuestPolicy) -> int:
    """Retention: settled quota rows once they left the network window; guest sessions once they
    are expired or ended and no longer count towards the session-start limit. A reserved place
    is never deleted (its job settles it)."""
    now = func.now()
    window = timedelta(seconds=policy.ip_window_seconds)
    start_window = timedelta(seconds=policy.session_rate_window_seconds)
    removed = 0
    for statement in (
        delete(GuestJobQuota).where(
            GuestJobQuota.state != QuotaState.RESERVED.value,
            GuestJobQuota.charged_at < now - window,
            GuestJobQuota.settled_at < now - window,
        ),
        delete(GuestSession).where(
            or_(GuestSession.expires_at <= now, GuestSession.revoked_at.is_not(None)),
            GuestSession.created_at < now - start_window,
        ),
    ):
        result = db.execute(statement.execution_options(synchronize_session=False))
        removed += result.rowcount or 0  # type: ignore[attr-defined]
    return removed
