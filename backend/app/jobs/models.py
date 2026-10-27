import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class JobStatus(StrEnum):
    QUEUED = "queued"
    TRANSLATING = "translating"
    SYNTHESIZING = "synthesizing"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


ACTIVE_STATUSES = (
    JobStatus.QUEUED,
    JobStatus.TRANSLATING,
    JobStatus.SYNTHESIZING,
    JobStatus.PROCESSING,
)
TERMINAL_STATUSES = (JobStatus.COMPLETED, JobStatus.FAILED)


class Job(Base):
    """Job metadata. Transcript and result content are intentionally NOT stored here."""

    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','translating','synthesizing','processing','completed','failed')",
            name="status_valid",
        ),
        CheckConstraint(
            "last_sentence_start_seconds > first_sentence_start_seconds",
            name="timestamps_ordered",
        ),
        CheckConstraint(
            "audio_speed_percent IN (50, 75, 100, 125, 150, 175, 200)",
            name="audio_speed_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Owner session. Set to NULL when the session row is cleaned up, which makes the job
    # unreachable through the API while keeping its metadata.
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("access_sessions.id", ondelete="SET NULL"), index=True
    )
    # Owner user in Cognito mode (then `session_id` is NULL). Access Code jobs keep NULL here,
    # so they are never visible to a Cognito user.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # Owner guest session ("Try as guest"; then `session_id` and `user_id` are NULL). Guest jobs
    # are never visible to an account or an Access Code session, nor theirs to a guest.
    guest_session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("guest_sessions.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), index=True)
    # Instance (process) that accepted and runs the job, and its last liveness signal.
    # Nullable so the schema change stays backward compatible with older code.
    runner_id: Mapped[str | None] = mapped_column(String(64))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    voice: Mapped[str] = mapped_column(String(20))
    first_sentence_start_seconds: Mapped[int] = mapped_column(Integer)
    last_sentence_start_seconds: Mapped[int] = mapped_column(Integer)
    # Baseline duration: last - first sentence start (whole seconds). With a speed other than
    # 1x the audio is NOT this long; the output length is baseline / speed (audio/speed.py).
    target_duration_seconds: Mapped[int] = mapped_column(Integer)
    # Audio speed chosen at submission, in percent (100 = 1x). Rows from before the option
    # existed read as 100 through the column default.
    audio_speed_percent: Mapped[int] = mapped_column(
        SmallInteger, server_default=text("100"), default=100
    )
    transcript_char_count: Mapped[int] = mapped_column(Integer)
    translation_provider: Mapped[str] = mapped_column(String(50))
    speech_provider: Mapped[str] = mapped_column(String(50))
    audio_processor: Mapped[str] = mapped_column(String(50))
    error_code: Mapped[str | None] = mapped_column(String(50))
    error_message: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When this job's glossary candidates were counted (at most once per job; NULL = never).
    glossary_candidates_recorded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
