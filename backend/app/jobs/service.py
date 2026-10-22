"""Job metadata persistence and guarded status transitions."""

import uuid
from collections.abc import Collection
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.jobs.models import ACTIVE_STATUSES, Job, JobStatus
from app.transcript.timestamps import target_duration_seconds

INTERRUPTED_CODE = "interrupted"
INTERRUPTED_MESSAGE = (
    "Processing was interrupted because the server restarted or shut down. "
    "The job was not retried automatically; please submit the transcript again."
)


def create_job(
    db: Session,
    *,
    session_id: uuid.UUID,
    voice: str,
    first_sentence_start_seconds: int,
    last_sentence_start_seconds: int,
    transcript_char_count: int,
    translation_provider: str,
    speech_provider: str,
    audio_processor: str,
) -> Job:
    now = datetime.now(UTC)
    job = Job(
        session_id=session_id,
        status=JobStatus.QUEUED,
        voice=voice,
        first_sentence_start_seconds=first_sentence_start_seconds,
        last_sentence_start_seconds=last_sentence_start_seconds,
        target_duration_seconds=target_duration_seconds(
            first_sentence_start_seconds, last_sentence_start_seconds
        ),
        transcript_char_count=transcript_char_count,
        translation_provider=translation_provider,
        speech_provider=speech_provider,
        audio_processor=audio_processor,
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    db.flush()
    return job


def get_owned_job(db: Session, job_id: uuid.UUID, session_id: uuid.UUID) -> Job | None:
    """Return the job only if it belongs to the given session.

    A job ID alone never grants access; other sessions' jobs look like missing jobs.
    """
    return db.scalar(select(Job).where(Job.id == job_id, Job.session_id == session_id))


def transition(
    db: Session, job_id: uuid.UUID, expected: JobStatus, new: JobStatus, **fields: Any
) -> bool:
    """Compare-and-set status change. Returns False if the job is no longer in `expected`
    (e.g. it was marked failed by restart recovery), so stale workers cannot overwrite it."""
    result = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.status == expected)
        .values(status=new, updated_at=datetime.now(UTC), **fields)
    )
    return (result.rowcount or 0) == 1  # type: ignore[attr-defined]


def mark_failed(db: Session, job_id: uuid.UUID, code: str, message: str) -> bool:
    now = datetime.now(UTC)
    result = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.status.in_(ACTIVE_STATUSES))
        .values(
            status=JobStatus.FAILED,
            error_code=code,
            error_message=message[:500],
            updated_at=now,
            completed_at=now,
        )
    )
    return (result.rowcount or 0) == 1  # type: ignore[attr-defined]


def fail_interrupted_jobs(db: Session, job_ids: Collection[uuid.UUID] | None = None) -> int:
    """Mark active jobs as failed with an interruption reason.

    With `job_ids=None` (startup): in the single-instance model, every active job in the
    database lost its in-memory execution (and its transcript) when the previous process
    ended. With `job_ids` (shutdown): only the jobs this process accepted.
    Jobs are never re-run automatically because provider call outcomes are unknown.
    """
    now = datetime.now(UTC)
    condition = Job.status.in_(ACTIVE_STATUSES)
    if job_ids is not None:
        condition = condition & Job.id.in_(list(job_ids))
    result = db.execute(
        update(Job)
        .where(condition)
        .values(
            status=JobStatus.FAILED,
            error_code=INTERRUPTED_CODE,
            error_message=INTERRUPTED_MESSAGE,
            updated_at=now,
            completed_at=now,
        )
    )
    return result.rowcount or 0  # type: ignore[attr-defined]
