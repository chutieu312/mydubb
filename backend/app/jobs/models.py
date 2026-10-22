import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Uuid
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
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Owner session. Set to NULL when the session row is cleaned up, which makes the job
    # unreachable through the API while keeping its metadata.
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("access_sessions.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), index=True)
    voice: Mapped[str] = mapped_column(String(20))
    first_sentence_start_seconds: Mapped[int] = mapped_column(Integer)
    last_sentence_start_seconds: Mapped[int] = mapped_column(Integer)
    target_duration_seconds: Mapped[int] = mapped_column(Integer)
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
