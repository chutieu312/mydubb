"""Records what a dubbing job asked of the providers, without ever affecting the job.

The pipeline gives each job a `UsageCollector` and makes it the *current* one for the worker
thread (`activate`). The providers open `attempt(...)` around each request they send; with no
collector current (unit tests, smoke scripts, usage recording off) it does nothing. No provider
signature changes and nothing is requested, retried or reordered to measure usage.

Reliability rules:

* One attempt is one provider request, written once its outcome is known, in its own short
  transaction (so a failed job keeps what was spent before the failure). A request holding many
  blocks is one attempt (`items`).
* Every write is guarded and bounded: each usage transaction starts by limiting its own lock wait
  and run time on the server (`USAGE_WRITE_TIMEOUT_SECONDS`, `store.limit_waits`), so a lock held
  by someone else ends in an error, not a stuck worker. An error is logged by type only, the job
  carries on, and writing stops after the first failure (no timeout per remaining request); the
  pending rows get one last try when the job ends, bounded the same way. `attempts_expected`
  and `write_errors` in the summary let the report show what is missing. `(job_id, seq)` makes
  repeated writes harmless.
* Missing figures stay unknown (NULL), never 0. A request that timed out or failed after being
  sent is *not* assumed to be free.
* Limit: a process that dies mid-request cannot write that request, nor the job's ending; the
  summary then has no `finished_at` and the report calls the job incomplete.
* Only counts, sizes, timings and fixed labels are kept; no text, SSML, key, address or URL.
"""

import contextvars
import logging
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from app.db import session_scope
from app.usage import store
from app.usage.metering import UNIT

logger = logging.getLogger(__name__)

METHOD_VERSION = 1


@dataclass(frozen=True)
class UsageContext:
    """Who asked, as fixed labels only (never an identity): client web | extension, access
    invitation | guest | access_code."""

    client: str = "unknown"
    access: str = "unknown"


class UsageCollector:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        job_id: uuid.UUID,
        facts: dict[str, Any],
        write_timeout_seconds: float = 3.0,
    ) -> None:
        self._factory = session_factory
        self._write_timeout = write_timeout_seconds
        self.job_id = job_id
        self._facts = {**facts, "started_at": datetime.now(UTC), "method_version": METHOD_VERSION}
        self._notes: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._seq = 0
        self._pending: list[dict[str, Any]] = []
        self._degraded = False
        self._write_errors = 0

    # -- called by the pipeline -------------------------------------------------------------
    def begin(self) -> None:
        self._guarded(lambda db: store.upsert_summary(db, self.job_id, self._facts))

    def note(self, **fields: Any) -> None:
        with self._lock:
            self._notes.update(fields)

    def finish(self, outcome: str, error_code: str | None) -> None:
        with self._lock:
            self._degraded = False  # one last try for what could not be written
            pending, self._pending = self._pending, []
            expected = self._seq
        if pending:
            self._guarded(lambda db: store.insert_attempts(db, pending), pending)
        with self._lock:
            lost = len(self._pending)
            values = {
                **self._facts,
                **self._notes,
                "finished_at": datetime.now(UTC),
                "outcome": outcome,
                "error_code": error_code[:50] if error_code else None,
                "attempts_expected": expected,
                "write_errors": self._write_errors,
            }
        self._guarded(lambda db: store.upsert_summary(db, self.job_id, values))
        if lost or self._write_errors:
            logger.warning(
                "Job %s: usage is incomplete (%d write error(s), %d attempt(s) not stored); "
                "the job is unaffected",
                self.job_id,
                self._write_errors,
                lost,
            )

    # -- called by `Attempt` ----------------------------------------------------------------
    def add_attempt(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._seq += 1
            row = {**row, "job_id": self.job_id, "seq": self._seq}
            if self._degraded:
                self._pending.append(row)
                return
        self._guarded(lambda db: store.insert_attempts(db, [row]), [row])

    def _guarded(self, write, keep: list[dict[str, Any]] | None = None) -> None:
        try:
            with session_scope(self._factory) as db:
                # First statement of every usage transaction: a lock held by someone else or a
                # slow statement ends in an error here instead of holding the worker.
                store.limit_waits(db, self._write_timeout)
                write(db)
        except Exception as exc:
            with self._lock:
                first = not self._degraded
                self._degraded = True
                self._write_errors += 1
                if keep:
                    self._pending.extend(keep)
            if first:
                # The exception text can quote SQL parameters: type only.
                logger.warning(
                    "Job %s: usage was not written (%s); the job is unaffected",
                    self.job_id,
                    type(exc).__name__,
                )


_current: contextvars.ContextVar[UsageCollector | None] = contextvars.ContextVar(
    "mydubb_usage_collector", default=None
)


def current() -> UsageCollector | None:
    return _current.get()


def activate(collector: UsageCollector) -> contextvars.Token:
    return _current.set(collector)


def deactivate(token: contextvars.Token) -> None:
    _current.reset(token)


def note(**fields: Any) -> None:
    """Facts about the running job (MP3 size, ...); no-op without a collector."""
    collector = current()
    if collector is not None:
        collector.note(**fields)


@contextmanager
def audio_stage():
    """Times the audio processing stage, also when it fails."""
    started = time.monotonic()
    try:
        yield
    finally:
        note(audio_ms=round((time.monotonic() - started) * 1000))


def note_audio_result(processed: Any) -> None:
    """The measured length and the size of the final MP3 (unknown stays unknown)."""
    try:
        values: dict[str, Any] = {"mp3_bytes": processed.path.stat().st_size}
        report = processed.duration_report
        if report is not None:
            values["final_audio_seconds"] = Decimal(report.mp3_decoded_samples) / Decimal(
                report.sample_rate
            )
        note(**values)
    except Exception as exc:  # measuring must never touch the job
        logger.warning("Audio facts for usage were not read (%s)", type(exc).__name__)


class Attempt:
    """One provider request. Fill in what is known as it becomes known; leaving the `with`
    block (normally or by an exception, which is never suppressed) records it."""

    def __init__(
        self,
        collector: UsageCollector | None,
        service: str,
        operation: str,
        *,
        kind: str,
        items: int,
    ) -> None:
        self._collector = collector
        self._service = service
        self._operation = operation
        self._kind = kind
        self.items = items
        self.outcome: str | None = None
        self.http_status: int | None = None
        self._sent: tuple[int, str] | None = None
        self._actual: tuple[int, str] | None = None
        self._estimate: tuple[int, str] | None = None
        self._started_at = datetime.now(UTC)
        self._clock = time.monotonic()

    def sent(self, amount: int, unit: str) -> None:
        self._sent = (amount, unit)

    def actual(self, amount: int, method: str) -> None:
        """A figure the provider itself reported as charged."""
        self._actual = (amount, method)

    def estimate(self, amount: int, method: str) -> None:
        """Our reading of the billing rules, used only if the request succeeded."""
        self._estimate = (amount, method)

    def __enter__(self) -> "Attempt":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if self._collector is None:
            return False
        try:
            self._collector.add_attempt(self._row(exc))
        except Exception as error:  # recording must never change the request's outcome
            logger.warning("Usage attempt was not recorded (%s)", type(error).__name__)
        return False

    def _row(self, exc: BaseException | None) -> dict[str, Any]:
        outcome = self.outcome
        error_code = getattr(exc, "code", None) if exc is not None else None
        if exc is not None and outcome is None:
            outcome = "failed"
            error_code = error_code or type(exc).__name__
        outcome = outcome or "ok"
        amount: int | None
        if self._actual is not None:
            amount, basis, method = self._actual[0], "actual", self._actual[1]
        elif outcome == "cancelled":
            amount, basis, method = 0, "none", "not-sent"
        elif self._kind == "mock":
            amount, basis, method = None, "none", "mock-not-billed"
        elif outcome == "ok" and self._estimate is not None:
            amount, basis, method = self._estimate[0], "estimated", self._estimate[1]
        else:
            # Sent but unanswered, rejected or without a usable figure: not assumed free.
            method = self._estimate[1] if self._estimate else None
            amount, basis = None, "unknown"
        sent_amount, sent_unit = self._sent if self._sent else (None, None)
        return {
            "service": self._service,
            "provider_kind": self._kind,
            "operation": self._operation,
            "outcome": outcome,
            "http_status": self.http_status,
            "error_code": str(error_code)[:50] if error_code else None,
            "items": self.items,
            "started_at": self._started_at,
            "elapsed_ms": round((time.monotonic() - self._clock) * 1000),
            "sent_amount": sent_amount,
            "sent_unit": sent_unit,
            "usage_amount": amount,
            "usage_unit": UNIT,
            "usage_basis": basis,
            "usage_method": method,
        }


def attempt(service: str, operation: str, *, kind: str = "azure", items: int = 1) -> Attempt:
    return Attempt(current(), service, operation, kind=kind, items=items)
