"""Bounded reads of the usage tables, for the administration API (`app/admin/usage.py`).

The rules of the report (`report.py`: completeness, actual / estimated / unknown / none, mock,
prices) are used as they are; only how the rows are read differs. `build_report` loads every job and
attempt of a period, which a local command can afford. Here a list reads one page from the database
and a summary reads the period in batches of jobs, so memory stays bounded whatever the period
holds.

Each response is one `REPEATABLE READ, READ ONLY` transaction on its own short session, opened after
the caller's rights were checked: the session that checked them has already queried, and the
isolation level can only be set before a transaction's first query. Its lock wait and statement run
time are limited on the server, for that transaction only (`store.limit_waits`).
"""

import base64
import binascii
import hashlib
import json
import time
import uuid
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session, sessionmaker

from app.usage.models import JobUsage, UsageAttempt
from app.usage.pricing import PriceBook
from app.usage.report import (
    Filters,
    JobReport,
    Totals,
    _first_usage_at,
    _jobs_without_usage,
    _reasons,
    _snapshot,
    _usage_conditions,
    job_reports_of,
    usage_rows_query,
)
from app.usage.store import limit_waits

STATEMENT_TIMEOUT_SECONDS = 10.0  # lock wait and run time of each statement, on the server
SUMMARY_BUDGET_SECONDS = 30.0  # all the batches of one summary, checked between batches
SUMMARY_BATCH_JOBS = 200
_MAX_SEQ = 2**31 - 1


class SummaryBudgetExceeded(Exception):
    """The summary of a period took longer than its budget, one short statement at a time."""


class InvalidCursor(ValueError):
    pass


class CursorFilterMismatch(ValueError):
    pass


@contextmanager
def report_snapshot(factory: sessionmaker[Session]) -> Iterator[Session]:
    """A new session in one read-only snapshot. Leaving it ends the transaction (its local timeouts
    with it) and returns the connection to the shared pool; nothing is committed."""
    with factory() as db:
        # First statements of the transaction, in this order: `limit_waits` is a SELECT, which
        # takes the snapshot, and the isolation level can no longer be set after it.
        _snapshot(db)
        limit_waits(db, STATEMENT_TIMEOUT_SECONDS)
        yield db


def _with_attempts(db: Session, rows: list) -> dict[uuid.UUID, JobReport]:
    """Job reports of some usage rows, each with all its attempts and its completeness."""
    jobs = job_reports_of(rows)
    if not jobs:
        return jobs
    attempts = db.scalars(
        select(UsageAttempt)
        .where(UsageAttempt.job_id.in_(jobs))
        .order_by(UsageAttempt.job_id, UsageAttempt.seq)
    )
    for attempt in attempts:
        jobs[attempt.job_id].attempts.append(attempt)
    for job in jobs.values():
        job.reasons = _reasons(job)
    return jobs


# -- summary of a period ------------------------------------------------------------------------


@dataclass
class PeriodSummary:
    filters: Filters
    totals: Totals = field(default_factory=Totals)
    statuses: Counter = field(default_factory=Counter)
    reasons: Counter = field(default_factory=Counter)
    incomplete: int = 0
    jobs_with_mock: int = 0
    jobs_without_usage: int = 0
    first_usage_at: datetime | None = None


def _batches(db: Session, filters: Filters, size: int) -> Iterator[list]:
    """The period's usage rows, newest first, one batch at a time (keyset, never OFFSET)."""
    query = usage_rows_query().where(*_usage_conditions(filters))
    query = query.order_by(JobUsage.started_at.desc(), JobUsage.job_id.desc()).limit(size)
    after = None
    while True:
        batch = db.execute(
            query if after is None else query.where(_before(*after)),
        ).all()
        if batch:
            yield batch
        if len(batch) < size:
            return
        last = batch[-1][0]
        after = (last.started_at, last.job_id)


def _before(started_at: datetime, job_id: uuid.UUID):
    return tuple_(JobUsage.started_at, JobUsage.job_id) < (started_at, job_id)


def summarize_period(db: Session, filters: Filters, prices: PriceBook) -> PeriodSummary:
    """The whole period, whatever a page shows: every job and attempt is seen once, in batches, by
    the same `Totals` and completeness rules as the command-line report."""
    summary = PeriodSummary(filters=filters)
    deadline = time.monotonic() + SUMMARY_BUDGET_SECONDS
    for batch in _batches(db, filters, SUMMARY_BATCH_JOBS):
        for job in _with_attempts(db, batch).values():
            summary.totals.add_job(job, prices)
            summary.statuses[job.status] += 1
            summary.reasons.update(job.reasons)
            summary.incomplete += not job.complete
            summary.jobs_with_mock += job.providers in ("mock", "mixed")
        db.expunge_all()  # the batch's objects are done with: memory stays one batch
        if time.monotonic() > deadline:
            raise SummaryBudgetExceeded
    summary.first_usage_at = _first_usage_at(db)
    summary.jobs_without_usage = _jobs_without_usage(db, filters)
    return summary


# -- one page of jobs ---------------------------------------------------------------------------


def _encode_cursor(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(value: str) -> dict[str, Any]:
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.b64decode(padded, altchars=b"-_", validate=True))
    except (ValueError, binascii.Error):
        raise InvalidCursor from None
    if not isinstance(payload, dict):
        raise InvalidCursor
    return payload


def _filters_fingerprint(filters: Filters) -> str:
    """Binds a cursor to the filters it was issued for."""
    parts = (filters.since, filters.until, filters.language, filters.job_ids)
    return hashlib.sha256(repr(parts).encode()).hexdigest()[:16]


def _jobs_position(cursor: str, filters: Filters) -> tuple[datetime, uuid.UUID]:
    payload = _decode_cursor(cursor)
    try:
        started_at = datetime.fromisoformat(payload["s"]).astimezone(UTC)
        job_id = uuid.UUID(payload["j"])
        fingerprint = payload["f"]
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        raise InvalidCursor from None
    if fingerprint != _filters_fingerprint(filters):
        raise CursorFilterMismatch
    return started_at, job_id


def list_jobs(
    db: Session, filters: Filters, cursor: str | None, limit: int
) -> tuple[list[JobReport], str | None]:
    """One page, newest first, read from the database. A position (not a row number) keeps the
    pages stable while new jobs arrive: a job that starts meanwhile sorts before the first page."""
    query = usage_rows_query().where(*_usage_conditions(filters))
    if cursor is not None:
        query = query.where(_before(*_jobs_position(cursor, filters)))
    rows = db.execute(
        query.order_by(JobUsage.started_at.desc(), JobUsage.job_id.desc()).limit(limit + 1)
    ).all()
    page = rows[:limit]
    jobs = list(_with_attempts(db, page).values())
    next_cursor = None
    if len(rows) > limit:
        last = page[-1][0]
        next_cursor = _encode_cursor(
            {
                "s": last.started_at.isoformat(),
                "j": str(last.job_id),
                "f": _filters_fingerprint(filters),
            }
        )
    return jobs, next_cursor


# -- one job ------------------------------------------------------------------------------------


@dataclass
class JobDetail:
    job: JobReport  # with all its attempts: the job's figures never depend on the page shown
    attempts_page: list[UsageAttempt]
    next_cursor: str | None


def _attempts_position(cursor: str, job_id: uuid.UUID) -> int:
    payload = _decode_cursor(cursor)
    seq, owner = payload.get("q"), payload.get("j")
    if type(seq) is not int or not 0 <= seq <= _MAX_SEQ or not isinstance(owner, str):
        raise InvalidCursor
    if owner != str(job_id):
        raise CursorFilterMismatch
    return seq


def job_detail(db: Session, job_id: uuid.UUID, cursor: str | None, limit: int) -> JobDetail | None:
    """A job's usage and one page of its attempts, or None without a usage record. The cursor is
    checked first: a bad one is a bad request whether or not the job has usage."""
    after = 0 if cursor is None else _attempts_position(cursor, job_id)
    rows = db.execute(usage_rows_query().where(JobUsage.job_id == job_id)).all()
    if not rows:
        return None
    job = _with_attempts(db, rows)[job_id]
    attempts = list(
        db.scalars(
            select(UsageAttempt)
            .where(UsageAttempt.job_id == job_id, UsageAttempt.seq > after)
            .order_by(UsageAttempt.seq)
            .limit(limit + 1)
        )
    )
    page = attempts[:limit]
    next_cursor = None
    if len(attempts) > limit:
        next_cursor = _encode_cursor({"j": str(job_id), "q": page[-1].seq})
    return JobDetail(job=job, attempts_page=page, next_cursor=next_cursor)
