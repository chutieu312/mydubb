"""Guest YouTube caption imports: their quotas and the lifecycle of one import operation
(docs/GUEST_ACCESS.md, "YouTube import quota").

A quota of its own, apart from the job quotas: `imports_per_session` successful imports over a
guest session's lifetime and `imports_per_ip` per client network in the same sliding window as
jobs (`ip_window_seconds`), shared by every guest session from that network. An import never uses
up a job and a job never uses up an import.

**Lifecycle.** Every guest import is one operation, one `guest_import_quota` row:

1. `reserve_import` checks both quotas and writes the row (`reserved`) in one short
   transaction, under the guest session's row lock and a transaction-scoped advisory lock of the
   network (its own lock namespace, so imports never wait for job reservations of the network),
   always in that order: concurrent imports of one session or one network never pass a quota.
   It commits before the caption provider is called; no transaction or lock is held while
   Supadata answers. A reserved place counts like a used one.
2. `GuestImportRunner.run` performs the import in a task of its own, so a client that disconnects
   (or a cancelled request handler) never stops it half way, and settles the row exactly once:
   `used` once the captions were fetched, checked and written as a transcript, **before** the
   answer is sent; `released` on any failure (provider error, timeout, unusable captions,
   shutdown). A success whose `used` cannot be recorded is not reported as a success.
3. While it runs, the instance's liveness loop refreshes `heartbeat_at`. `release_stale_imports`
   (startup recovery and the liveness loop) releases only rows whose heartbeat is stale, or that
   have been reserved longer than any import can take: an operation still running on another
   live instance (overlapping deploy) keeps its place. Recovery never calls the provider again.
4. Application shutdown is not a client going away. Running imports get the shutdown budget that
   jobs also use (`wait_until`, one deadline); then `stop` cancels what is left (a stalled
   provider read included), lets no cancelled import touch the database again, waits for any
   statement already running, and gives the stopped imports' places back in one statement before
   the engine is disposed. If that last statement fails, recovery releases them later.

Releasing a place gives the guest's MyDubb quota back; it does not give back what the provider
charged (a Supadata request that failed or timed out may still have cost a credit).

**Time.** Window arithmetic and heartbeats use the database clock, shared by every instance.
"""

import asyncio
import logging
import threading
import time
import uuid
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TypeVar

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.auth.service import database_now
from app.db import session_scope
from app.guest.models import GuestImportQuota, GuestSession, QuotaState
from app.guest.service import (
    GuestPolicy,
    GuestSessionGone,
    _limit_lock_waits,
    _network_lock_key,
    _seconds_until,
)

logger = logging.getLogger(__name__)

# Namespace of the import quota's network locks (two-key form), apart from the job quota's.
_IMPORT_LOCK_NAMESPACE = 0x6775696D  # "guim"

T = TypeVar("T")


class GuestImportQuotaExceeded(Exception):
    """The guest session or the client network has no import left."""

    def __init__(self, scope: str, retry_after: int | None, in_flight: int) -> None:
        super().__init__(f"guest import {scope} quota exceeded")
        self.scope = scope  # "session" or "ip"
        self.retry_after = retry_after
        self.in_flight = in_flight  # places held by imports that are still running


class ImportNotRecorded(Exception):
    """A successful import could not be recorded as used (its place was already released, or
    the database failed), so it must not be reported as a success."""


class ImportsStopped(Exception):
    """The application is shutting down: the import was stopped (or refused) by the runner."""


# How long `stop` waits for cancelled imports to end and for database statements that were
# already running (single-row updates, normally milliseconds). Not a drain: nothing new starts.
_STOP_WAIT_SECONDS = 5.0


@dataclass(frozen=True)
class ImportQuotaStatus:
    session_limit: int
    session_used: int
    session_in_progress: int
    ip_limit: int
    # None when the caller's network cannot be told (then no import can be accepted either).
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


def _advisory_lock(db: Session, ip_key: str) -> None:
    key = _network_lock_key(ip_key)
    db.execute(select(func.pg_advisory_xact_lock(_IMPORT_LOCK_NAMESPACE, key)))


def _session_counts(db: Session, guest_session_id: uuid.UUID) -> tuple[int, int]:
    used = GuestImportQuota.state == QuotaState.USED.value
    reserved = GuestImportQuota.state == QuotaState.RESERVED.value
    row = db.execute(
        select(func.count().filter(used), func.count().filter(reserved)).where(
            GuestImportQuota.guest_session_id == guest_session_id
        )
    ).one()
    return row[0] or 0, row[1] or 0


def _network_counts(
    db: Session, ip_key: str, now: datetime, policy: GuestPolicy
) -> tuple[int, int, datetime | None]:
    """Used imports in the window, imports in flight, and when the oldest used one leaves it."""
    cutoff = now - timedelta(seconds=policy.ip_window_seconds)
    used = and_(
        GuestImportQuota.state == QuotaState.USED.value, GuestImportQuota.charged_at > cutoff
    )
    row = db.execute(
        select(
            func.count().filter(used),
            func.count().filter(GuestImportQuota.state == QuotaState.RESERVED.value),
            func.min(GuestImportQuota.charged_at).filter(used),
        ).where(GuestImportQuota.ip_key == ip_key)
    ).one()
    oldest = row[2]
    frees_at = oldest + timedelta(seconds=policy.ip_window_seconds) if oldest else None
    return row[0] or 0, row[1] or 0, frees_at


def import_quota_status(
    db: Session, *, guest_session_id: uuid.UUID, ip_key: str | None, policy: GuestPolicy
) -> ImportQuotaStatus:
    session_used, session_reserved = _session_counts(db, guest_session_id)
    ip_used = ip_reserved = retry = None
    if ip_key is not None:
        now = database_now(db)
        ip_used, ip_reserved, frees_at = _network_counts(db, ip_key, now, policy)
        if frees_at is not None and ip_used + ip_reserved >= policy.imports_per_ip:
            retry = _seconds_until(frees_at, now)
    return ImportQuotaStatus(
        session_limit=policy.imports_per_session,
        session_used=session_used,
        session_in_progress=session_reserved,
        ip_limit=policy.imports_per_ip,
        ip_used=ip_used,
        ip_in_progress=ip_reserved,
        ip_retry_after_seconds=retry,
    )


def reserve_import(
    db: Session,
    *,
    guest_session_id: uuid.UUID,
    ip_key: str,
    policy: GuestPolicy,
    runner_id: str,
) -> uuid.UUID:
    """Check both import quotas and write the operation's reserved place, atomically.

    Raises GuestImportQuotaExceeded (nothing written) or GuestSessionGone. The caller commits,
    before calling the provider.
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
    _advisory_lock(db, ip_key)
    now = database_now(db)

    session_used, session_reserved = _session_counts(db, guest_session_id)
    if session_used + session_reserved >= policy.imports_per_session:
        raise GuestImportQuotaExceeded("session", None, session_reserved)
    ip_used, ip_reserved, frees_at = _network_counts(db, ip_key, now, policy)
    if ip_used + ip_reserved >= policy.imports_per_ip:
        retry = _seconds_until(frees_at, now) if frees_at is not None else None
        raise GuestImportQuotaExceeded("ip", retry, ip_reserved)

    operation = GuestImportQuota(
        id=uuid.uuid4(),
        guest_session_id=guest_session_id,
        ip_key=ip_key,
        state=QuotaState.RESERVED.value,
        runner_id=runner_id,
        heartbeat_at=now,
        reserved_at=now,
        charged_at=now,
    )
    db.add(operation)
    db.flush()
    return operation.id


def settle_import(db: Session, operation_id: uuid.UUID, *, used: bool) -> bool:
    """Charge (`used`) or give back (`released`) a reserved import. Only a `reserved` row
    changes, so a second settle, or one after recovery released it, changes nothing (False)."""
    now = func.clock_timestamp()
    values: dict = {"settled_at": now}
    if used:
        # A used import counts in the network window from its successful end.
        values.update(state=QuotaState.USED.value, charged_at=now)
    else:
        values.update(state=QuotaState.RELEASED.value)
    result = db.execute(
        update(GuestImportQuota)
        .where(
            GuestImportQuota.id == operation_id,
            GuestImportQuota.state == QuotaState.RESERVED.value,
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return (result.rowcount or 0) == 1  # type: ignore[attr-defined]


def heartbeat_imports(db: Session, runner_id: str, operation_ids: Collection[uuid.UUID]) -> int:
    """Refresh the heartbeat of the imports this instance is still running."""
    if not operation_ids:
        return 0
    result = db.execute(
        update(GuestImportQuota)
        .where(
            GuestImportQuota.id.in_(list(operation_ids)),
            GuestImportQuota.runner_id == runner_id,
            GuestImportQuota.state == QuotaState.RESERVED.value,
        )
        .values(heartbeat_at=func.now())
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]


def release_imports(db: Session, operation_ids: Collection[uuid.UUID]) -> int:
    """Give back the places of these imports if they are still reserved (shutdown of the
    instance running them). Rows already settled are not touched."""
    if not operation_ids:
        return 0
    result = db.execute(
        update(GuestImportQuota)
        .where(
            GuestImportQuota.id.in_(list(operation_ids)),
            GuestImportQuota.state == QuotaState.RESERVED.value,
        )
        .values(state=QuotaState.RELEASED.value, settled_at=func.clock_timestamp())
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]


def release_stale_imports(db: Session, *, stale_after_seconds: int, max_age_seconds: float) -> int:
    """Release reserved imports whose worker is gone: the heartbeat is stale (the instance
    stopped or crashed), or the import has been reserved longer than any import can run (its
    deadline plus a margin). An import still running on a live instance keeps its place."""
    now = func.now()
    result = db.execute(
        update(GuestImportQuota)
        .where(
            GuestImportQuota.state == QuotaState.RESERVED.value,
            or_(
                GuestImportQuota.heartbeat_at < now - timedelta(seconds=stale_after_seconds),
                GuestImportQuota.reserved_at < now - timedelta(seconds=max_age_seconds),
            ),
        )
        .values(state=QuotaState.RELEASED.value, settled_at=func.clock_timestamp())
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]


class GuestImportRunner:
    """Runs reserved guest imports to their single settlement, whatever happens to the request.

    `running_ids` is what the liveness loop heartbeats. Tasks are referenced here until they end,
    so a request that goes away never lets its import be garbage-collected half way. Every
    database statement of an import goes through `_db`, which counts it while its thread runs and
    refuses new ones once `stop` has begun, so shutdown knows when the database is no longer used.
    """

    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self._session_factory = session_factory
        self._lock = threading.Lock()
        self._db_idle = threading.Condition(self._lock)
        self._running: set[uuid.UUID] = set()
        self._tasks: set[asyncio.Task] = set()
        self._db_calls = 0
        # Set by `stop` (application shutdown): no import may start database work any more.
        self._stopping = False

    def running_ids(self) -> list[uuid.UUID]:
        with self._lock:
            return list(self._running)

    async def run(
        self,
        reserve: Callable[[], uuid.UUID],
        work: Callable[[], Awaitable[T]],
        *,
        on_done: Callable[[], None] | None = None,
    ) -> T:
        """Reserve the operation (`reserve`, a short committed transaction run in a thread), run
        `work` (fetch, check and write the transcript) and settle it; `on_done` runs when the
        operation has ended, whatever the outcome.

        Everything runs in a task of its own and the caller awaits a shield: cancelling the
        caller (a disconnected client) leaves the operation running to its end, and a success is
        still charged. Only `stop` (application shutdown) cancels the operation itself, which
        then ends with ImportsStopped. An error of `reserve` (quota exceeded, session gone) wrote
        nothing.
        """
        task = asyncio.create_task(self._run(reserve, work))
        self._tasks.add(task)
        task.add_done_callback(self._finished)
        if on_done is not None:
            task.add_done_callback(lambda _: on_done())
        return await asyncio.shield(task)

    def _finished(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        # Its outcome went to the request, or nowhere if the request is gone (already settled).
        if not task.cancelled():
            task.exception()

    async def wait_until(self, deadline: float) -> None:
        """Shutdown: let running imports end until `deadline` (time.monotonic), the budget shared
        with running jobs. Heartbeats continue meanwhile."""
        tasks = list(self._tasks)
        remaining = deadline - time.monotonic()
        if tasks and remaining > 0:
            await asyncio.wait(tasks, timeout=remaining)

    async def stop(self) -> int:
        """Shutdown, after `wait_until`: cancel the imports still running, make sure none of them
        uses the database afterwards, and give their places back. Returns how many were stopped.
        """
        with self._lock:
            self._stopping = True
            stopped_ids = list(self._running)
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=_STOP_WAIT_SECONDS)
        # A statement already running in a thread (cancelling its awaiter does not stop it).
        if not await asyncio.to_thread(self._wait_db_idle, _STOP_WAIT_SECONDS):
            logger.warning("A guest import database statement was still running at shutdown")
        if stopped_ids or tasks:
            logger.warning(
                "Stopped %d guest import(s) at shutdown", max(len(stopped_ids), len(tasks))
            )
        if stopped_ids:
            try:
                await asyncio.to_thread(self._release, stopped_ids)
            except Exception:
                logger.warning("Could not release stopped guest imports; recovery will")
        return len(tasks)

    def _wait_db_idle(self, timeout: float) -> bool:
        with self._db_idle:
            return self._db_idle.wait_for(lambda: self._db_calls == 0, timeout)

    def _release(self, operation_ids: list[uuid.UUID]) -> None:
        with session_scope(self._session_factory) as db:
            release_imports(db, operation_ids)

    async def _db(self, fn: Callable[..., T], *args: object) -> T:
        """Run one database step of an import in a thread, unless shutdown has begun."""
        if self._stopping:
            raise ImportsStopped
        return await asyncio.to_thread(self._counted, fn, *args)

    def _counted(self, fn: Callable[..., T], *args: object) -> T:
        # Counted in the thread itself: it stays counted while it runs even if its awaiter is
        # cancelled.
        with self._lock:
            if self._stopping:
                raise ImportsStopped
            self._db_calls += 1
        try:
            return fn(*args)
        finally:
            with self._db_idle:
                self._db_calls -= 1
                self._db_idle.notify_all()

    async def _run(self, reserve: Callable[[], uuid.UUID], work: Callable[[], Awaitable[T]]) -> T:
        try:
            return await self._operation(reserve, work)
        except asyncio.CancelledError:
            # Only `stop` cancels an operation (a client going away cancels the shielded caller,
            # never this task): report it as stopped, not as a cancelled request.
            if self._stopping:
                raise ImportsStopped from None
            raise

    async def _operation(
        self, reserve: Callable[[], uuid.UUID], work: Callable[[], Awaitable[T]]
    ) -> T:
        operation_id = await self._db(reserve)
        with self._lock:
            self._running.add(operation_id)
        try:
            try:
                result = await work()
            except BaseException:
                await self._settle_failure(operation_id)
                raise
            try:
                recorded = await self._db(self._settle, operation_id, True)
            except ImportsStopped:
                raise
            except Exception:
                logger.exception("Could not record a successful guest import")
                recorded = False
            if not recorded:
                # Released meanwhile (its worker looked gone) or not written: never a success
                # that was not counted. Recovery releases a row still reserved.
                raise ImportNotRecorded
            return result
        finally:
            with self._lock:
                self._running.discard(operation_id)

    async def _settle_failure(self, operation_id: uuid.UUID) -> None:
        try:
            await self._db(self._settle, operation_id, False)
        except ImportsStopped:
            pass  # shutdown: `stop` gives the place back
        except BaseException:
            # The row stays reserved; recovery releases it once its heartbeat is stale.
            logger.warning("Could not release a failed guest import; recovery will")

    def _settle(self, operation_id: uuid.UUID, used: bool) -> bool:
        with session_scope(self._session_factory) as db:
            return settle_import(db, operation_id, used=used)
