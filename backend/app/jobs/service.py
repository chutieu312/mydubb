"""Job metadata persistence and guarded status transitions."""

import uuid
from collections.abc import Collection
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.audio.speed import DEFAULT_SPEED, AudioSpeed
from app.jobs.models import ACTIVE_STATUSES, Job, JobStatus
from app.transcript.timestamps import target_duration_seconds

INTERRUPTED_CODE = "interrupted"
INTERRUPTED_MESSAGE = (
    "Processing was interrupted because the server restarted, shut down or was redeployed. "
    "The job was not retried automatically; please submit the transcript again."
)


def create_job(
    db: Session,
    *,
    session_id: uuid.UUID | None,
    voice: str,
    first_sentence_start_seconds: int,
    last_sentence_start_seconds: int,
    transcript_char_count: int,
    translation_provider: str,
    speech_provider: str,
    audio_processor: str,
    runner_id: str,
    audio_speed: AudioSpeed = DEFAULT_SPEED,
    user_id: uuid.UUID | None = None,
) -> Job:
    now = datetime.now(UTC)
    job = Job(
        session_id=session_id,
        user_id=user_id,
        status=JobStatus.QUEUED,
        runner_id=runner_id,
        heartbeat_at=now,
        voice=voice,
        first_sentence_start_seconds=first_sentence_start_seconds,
        last_sentence_start_seconds=last_sentence_start_seconds,
        target_duration_seconds=target_duration_seconds(
            first_sentence_start_seconds, last_sentence_start_seconds
        ),
        audio_speed_percent=audio_speed.value,
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


def get_owned_job(
    db: Session, job_id: uuid.UUID, *, session_id: uuid.UUID, user_id: uuid.UUID | None
) -> Job | None:
    """Return the job only if it belongs to the caller.

    Cognito mode (`user_id` set): jobs of that user, from any of their sessions. Access Code
    mode: jobs of that session that belong to no user. A job ID alone never grants access;
    other callers' jobs look like missing jobs.
    """
    if user_id is not None:
        owner = Job.user_id == user_id
    else:
        owner = (Job.session_id == session_id) & Job.user_id.is_(None)
    return db.scalar(select(Job).where(Job.id == job_id, owner))


def transition(
    db: Session, job_id: uuid.UUID, expected: JobStatus, new: JobStatus, **fields: Any
) -> bool:
    """Compare-and-set status change. Returns False if the job is no longer in `expected`
    (e.g. it was marked failed by restart recovery), so stale workers cannot overwrite it."""
    now = datetime.now(UTC)
    result = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.status == expected)
        .values(status=new, updated_at=now, heartbeat_at=now, **fields)
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


def fail_interrupted_jobs(db: Session, job_ids: Collection[uuid.UUID]) -> int:
    """At shutdown: fail the given active jobs (accepted by this process, not finished)."""
    if not job_ids:
        return 0
    return _fail_active(db, Job.id.in_(list(job_ids)))


def heartbeat_jobs(db: Session, runner_id: str, job_ids: Collection[uuid.UUID]) -> int:
    """Refresh the liveness signal of the active jobs this instance still owns.

    `job_ids` must be the jobs the process currently has queued or running. A job whose
    worker is gone without recording a terminal state (e.g. the database was down when it
    failed) is deliberately not refreshed, so it goes stale and `fail_stale_jobs` marks it
    interrupted. Terminal jobs are never touched.
    """
    if not job_ids:
        return 0
    result = db.execute(
        update(Job)
        .where(
            Job.runner_id == runner_id,
            Job.id.in_(list(job_ids)),
            Job.status.in_(ACTIVE_STATUSES),
        )
        .values(heartbeat_at=datetime.now(UTC))
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]


def fail_stale_jobs(db: Session, stale_after_seconds: int) -> int:
    """Fail active jobs whose owning instance stopped sending heartbeats.

    Live instances refresh `heartbeat_at` well within `stale_after_seconds`, so jobs still
    running on another instance (e.g. the old instance during an overlapping deploy) are
    left alone. Jobs from a crashed or stopped instance are failed with an interruption
    reason once their heartbeat is stale. Rows written before heartbeats existed fall back
    to `updated_at`. Jobs are never re-run automatically because provider call outcomes
    are unknown.
    """
    cutoff = datetime.now(UTC) - timedelta(seconds=stale_after_seconds)
    last_seen = func.coalesce(Job.heartbeat_at, Job.updated_at)
    return _fail_active(db, last_seen < cutoff)


def _fail_active(db: Session, condition: Any) -> int:
    now = datetime.now(UTC)
    result = db.execute(
        update(Job)
        .where(Job.status.in_(ACTIVE_STATUSES), condition)
        .values(
            status=JobStatus.FAILED,
            error_code=INTERRUPTED_CODE,
            error_message=INTERRUPTED_MESSAGE,
            updated_at=now,
            completed_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]
