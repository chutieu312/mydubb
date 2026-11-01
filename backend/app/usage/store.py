"""Usage persistence: idempotent writes and the retention cleanup."""

import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.usage.models import JobUsage, UsageAttempt

# Written once when the job starts and never changed afterwards.
_IMMUTABLE = ("job_id", "started_at")


def upsert_summary(db: Session, job_id: uuid.UUID, values: Mapping[str, Any]) -> None:
    """Insert the job's summary row, or update the fields given (never `started_at`).

    `values` must be a whole row (Postgres checks NOT NULL on the proposed insert before it looks
    for the conflict); the pipeline always passes the job's full facts."""
    row = {**values, "job_id": job_id}
    statement = insert(JobUsage).values(**row)
    changes = {key: statement.excluded[key] for key in row if key not in _IMMUTABLE}
    if changes:
        statement = statement.on_conflict_do_update(index_elements=["job_id"], set_=changes)
    else:
        statement = statement.on_conflict_do_nothing(index_elements=["job_id"])
    db.execute(statement)


def insert_attempts(db: Session, rows: Sequence[Mapping[str, Any]]) -> None:
    """Insert attempts; one already stored under the same (job, seq) is left as it is, so a
    write repeated after an uncertain commit never counts an attempt twice."""
    if rows:
        db.execute(
            insert(UsageAttempt)
            .values([dict(row) for row in rows])
            .on_conflict_do_nothing(index_elements=["job_id", "seq"])
        )


def delete_usage_older_than(db: Session, cutoff: datetime) -> tuple[int, int]:
    """Retention cleanup: (summaries, attempts) started before `cutoff`.

    Touches only the two usage tables; jobs and every other table are never read or changed.
    """
    attempts = db.execute(delete(UsageAttempt).where(UsageAttempt.started_at < cutoff))
    summaries = db.execute(delete(JobUsage).where(JobUsage.started_at < cutoff))
    return (summaries.rowcount or 0), (attempts.rowcount or 0)  # type: ignore[attr-defined]
