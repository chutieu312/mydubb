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
   provider read included), lets no cancelled import start database work again, waits a bounded
   time for a statement already running, and gives the stopped imports' places back in one
   bounded statement. If that is not possible in time, the rows stay `reserved` without a
   heartbeat and recovery releases them later; settling only ever changes `reserved` rows, so a
   late statement can never charge or release twice.

**Bounded database work.** Every database step of an import (reserve, settle, heartbeat, the
shutdown release) runs on the runner's own small engine (`create_import_engine`) in a transaction
with `statement_timeout` and `lock_timeout` set locally (so it also works through a transaction
pooler), a bounded pool checkout and connect, and TCP keepalives that end a read from a dead
server. A step therefore ends within about `db_timeout_seconds` (a dead network: a few seconds
more), in the database and in its thread, instead of just being abandoned by its awaiter. Steps
run on daemon threads of their own, not the event loop's default executor, which the loop joins
when it closes: a step that is stuck anyway cannot hold up the process exit. Recovery
and the quota reads of `GET /api/guest/session` are not import steps and use the application's
engine.

Releasing a place gives the guest's MyDubb quota back; it does not give back what the provider
charged (a Supadata request that failed or timed out may still have cost a credit).

**Time.** Window arithmetic and heartbeats use the database clock, shared by every instance.
"""

import asyncio
import contextlib
import logging
import threading
import time
import uuid
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TypeVar

from sqlalchemy import Engine, and_, create_engine, func, or_, select, text, update
from sqlalchemy.orm import Session, sessionmaker

from app.auth.service import database_now
from app.db import session_scope
from app.guest.models import GuestImportQuota, GuestSession, QuotaState
from app.guest.service import (
    GuestPolicy,
    GuestSessionGone,
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


# Upper bound of one database step of an import: statement and lock waits in PostgreSQL, pool
# checkout and connect on the client. A step is a few single-row statements (milliseconds).
IMPORT_DB_TIMEOUT_SECONDS = 2.0
# Margin `stop` allows on top of that bound before it treats a step as not ending.
_STOP_MARGIN_SECONDS = 1.0


def create_import_engine(url: str, timeout_seconds: float = IMPORT_DB_TIMEOUT_SECONDS) -> Engine:
    """The guest import runner's own engine: small pool, bounded checkout and connect, and TCP
    keepalives (libpq) so that a read from a server that went away ends too."""
    seconds = max(2, round(timeout_seconds))  # libpq's connect_timeout minimum is 2 s
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_size=2,
        max_overflow=2,
        pool_timeout=timeout_seconds,
        connect_args={
            "connect_timeout": seconds,
            "keepalives": 1,
            "keepalives_idle": 1,
            "keepalives_interval": 1,
            "keepalives_count": 2,
            "tcp_user_timeout": int(seconds * 1000),
        },
    )


async def _in_daemon_thread[R](fn: Callable[..., R], *args: object) -> R:
    """Run `fn` on a daemon thread of its own and await its result. Cancelling the awaiter does
    not stop the thread (callers count it, see `GuestImportRunner._counted`); nothing joins it."""
    loop = asyncio.get_running_loop()
    future: asyncio.Future[R] = loop.create_future()

    def resolve(result: R | None, error: BaseException | None) -> None:
        if future.done():  # the awaiter was cancelled
            return
        if error is not None:
            future.set_exception(error)
        else:
            future.set_result(result)  # type: ignore[arg-type]

    def target() -> None:
        result: R | None = None
        error: BaseException | None = None
        try:
            result = fn(*args)
        except BaseException as exc:  # handed to the awaiter
            error = exc
        # The loop may be closed by now: then nobody waits for this any more.
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(resolve, result, error)

    threading.Thread(target=target, name="guest-import-db", daemon=True).start()
    return await future


@dataclass(frozen=True)
class StopOutcome:
    stopped: int  # imports cancelled at shutdown
    # True when no import database work is running any more: the import engine may be disposed.
    quiescent: bool
    # Places given back by the shutdown release (0 when it failed or did not run).
    released: int


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
    before calling the provider, and bounds lock waits (GuestImportRunner runs it with
    `lock_timeout` and `statement_timeout`).
    """
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
    database step of an import goes through `_counted`, which counts it while its thread runs and
    refuses new ones once `stop` has begun, so shutdown knows whether the database is still used;
    each step runs in `_transaction`, bounded as described in the module docstring.
    """

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        db_timeout_seconds: float = IMPORT_DB_TIMEOUT_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        self._db_timeout = db_timeout_seconds
        self._lock = threading.Lock()
        self._db_idle = threading.Condition(self._lock)
        self._running: set[uuid.UUID] = set()
        self._tasks: set[asyncio.Task] = set()
        self._db_calls = 0
        # Set by `stop` (application shutdown): no import may start database work any more.
        self._stopping = False
        # The import heartbeat in flight, if any: never two at once.
        self._heartbeat: asyncio.Future | None = None

    @property
    def stop_bound_seconds(self) -> float:
        """How long each of the two phases of `stop` may take at most."""
        return self._db_timeout + _STOP_MARGIN_SECONDS

    def running_ids(self) -> list[uuid.UUID]:
        with self._lock:
            return list(self._running)

    def db_calls(self) -> int:
        with self._lock:
            return self._db_calls

    async def run(
        self,
        reserve: Callable[[Session], uuid.UUID],
        work: Callable[[], Awaitable[T]],
        *,
        on_done: Callable[[], None] | None = None,
    ) -> T:
        """Reserve the operation (`reserve(db)`, a short bounded transaction committed in a
        thread), run `work` (fetch, check and write the transcript) and settle it; `on_done` runs
        when the operation has ended, whatever the outcome.

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

    def schedule_heartbeat(self, runner_id: str) -> bool:
        """Liveness loop (on the event loop): refresh the heartbeat of the imports running here,
        in the background, like every import step (daemon thread, counted, bounded). It never
        blocks the loop; at most one runs at a time (a slow one is not stacked up: the next tick
        skips it), and none starts once `stop` has begun. Returns whether one was started."""
        if self._stopping or (self._heartbeat is not None and not self._heartbeat.done()):
            return False
        ids = self.running_ids()
        if not ids:
            return False
        self._heartbeat = asyncio.ensure_future(self._beat(runner_id, ids))
        return True

    async def _beat(self, runner_id: str, ids: list[uuid.UUID]) -> None:
        try:
            await self._db(lambda db: heartbeat_imports(db, runner_id, ids))
        except ImportsStopped:
            pass
        except Exception:
            # Missed beats only bring recovery closer; the next tick tries again.
            logger.warning("Guest import heartbeat failed")

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

    async def stop(self) -> StopOutcome:
        """Shutdown, after `wait_until`: cancel the imports still running, start no import
        database work any more, and give the stopped imports' places back.

        Two phases of at most `stop_bound_seconds` each: (1) the cancelled imports end and any
        step already running finishes (it is bounded in the database, so it normally ends within
        `db_timeout_seconds`); (2) one bounded release of the stopped operations. If phase 1 does
        not end in time, no release is attempted and the outcome is not quiescent: the caller
        must not dispose the import engine, and recovery releases the rows later.
        """
        with self._lock:
            self._stopping = True
            stopped_ids = list(self._running)
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        if self._heartbeat is not None and not self._heartbeat.done():
            # Its statement, if running, stays counted below; only its awaiter goes.
            self._heartbeat.cancel()
        bound = self.stop_bound_seconds
        phase_end = time.monotonic() + bound
        if tasks:
            await asyncio.wait(tasks, timeout=bound)
        quiescent = await _in_daemon_thread(
            self._wait_db_idle, max(0.0, phase_end - time.monotonic())
        )
        if stopped_ids or tasks:
            logger.warning("Stopped %d guest import(s) at shutdown", len(tasks))
        if not quiescent:
            logger.warning(
                "%d guest import database step(s) still running at shutdown; their places are "
                "left to recovery and the import database engine is not disposed",
                self.db_calls(),
            )
            return StopOutcome(stopped=len(tasks), quiescent=False, released=0)
        released = 0
        if stopped_ids:
            # Counted like any import step, so a release that overruns keeps us from claiming
            # the database is no longer used.
            release = asyncio.ensure_future(
                _in_daemon_thread(
                    lambda: self._counted(self._release, stopped_ids, allow_stopping=True)
                )
            )
            done, _ = await asyncio.wait({release}, timeout=bound)
            if release in done and release.exception() is None:
                released = release.result()
            else:
                if release in done:
                    release.exception()  # retrieved: logged below
                logger.warning("Could not release stopped guest imports in time; recovery will")
            quiescent = self.db_calls() == 0
            if not quiescent:
                logger.warning(
                    "The guest import release is still running at shutdown; the import "
                    "database engine is not disposed"
                )
        return StopOutcome(stopped=len(tasks), quiescent=quiescent, released=released)

    def _wait_db_idle(self, timeout: float) -> bool:
        with self._db_idle:
            return self._db_idle.wait_for(lambda: self._db_calls == 0, timeout)

    def _release(self, operation_ids: list[uuid.UUID]) -> int:
        return self._transaction(lambda db: release_imports(db, operation_ids))

    def _transaction(self, step: Callable[[Session], T]) -> T:
        """One import step in its own transaction, its waits bounded inside PostgreSQL."""
        milliseconds = int(self._db_timeout * 1000)
        with session_scope(self._session_factory) as db:
            db.execute(text(f"SET LOCAL statement_timeout = {milliseconds}"))
            db.execute(text(f"SET LOCAL lock_timeout = {milliseconds}"))
            return step(db)

    async def _db(self, step: Callable[[Session], T]) -> T:
        """Run one database step of an import in a thread, unless shutdown has begun."""
        if self._stopping:
            raise ImportsStopped
        return await _in_daemon_thread(self._counted, self._transaction, step)

    def _counted(self, fn: Callable[..., T], *args: object, allow_stopping: bool = False) -> T:
        # Counted in the thread itself: it stays counted while it runs even if its awaiter is
        # cancelled.
        with self._lock:
            if self._stopping and not allow_stopping:
                raise ImportsStopped
            self._db_calls += 1
        try:
            return fn(*args)
        finally:
            with self._db_idle:
                self._db_calls -= 1
                self._db_idle.notify_all()

    async def _run(
        self, reserve: Callable[[Session], uuid.UUID], work: Callable[[], Awaitable[T]]
    ) -> T:
        try:
            return await self._operation(reserve, work)
        except asyncio.CancelledError:
            # Only `stop` cancels an operation (a client going away cancels the shielded caller,
            # never this task): report it as stopped, not as a cancelled request.
            if self._stopping:
                raise ImportsStopped from None
            raise

    async def _operation(
        self, reserve: Callable[[Session], uuid.UUID], work: Callable[[], Awaitable[T]]
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
                recorded = await self._db(lambda db: settle_import(db, operation_id, used=True))
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
            await self._db(lambda db: settle_import(db, operation_id, used=False))
        except ImportsStopped:
            pass  # shutdown: `stop` gives the place back
        except BaseException:
            # The row stays reserved; recovery releases it once its heartbeat is stale.
            logger.warning("Could not release a failed guest import; recovery will")
