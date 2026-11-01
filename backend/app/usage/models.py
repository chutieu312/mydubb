"""Usage tables: one summary row per job and one row per provider attempt.

Deliberately independent of `jobs`: no foreign key and no cascade, so usage outlives the job row
(the long-term data the cost model needs) and a future cleanup of job metadata cannot delete it.
Usage is deleted only by its own retention cleanup (`store.delete_usage_older_than`). Rows hold
counts, sizes, timings and fixed labels, never transcript, translation, SSML, keys, addresses or
user identifiers.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class JobUsage(Base):
    """What a job did that costs something, written when the job starts and completed when it
    ends. A row with `finished_at` NULL is a job that did not report an ending (crash, restart)."""

    __tablename__ = "job_usage"
    __table_args__ = (
        CheckConstraint("timing_mode IN ('plain','timed')", name="timing_mode_valid"),
        CheckConstraint(
            "outcome IS NULL OR outcome IN ('completed','failed','superseded')",
            name="outcome_valid",
        ),
        Index("ix_job_usage_started_at", "started_at"),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Fixed labels: web | extension, and invitation | guest | access_code (never an identity).
    client: Mapped[str] = mapped_column(String(16))
    access: Mapped[str] = mapped_column(String(16))
    target_language: Mapped[str] = mapped_column(String(32), index=True)
    voice: Mapped[str] = mapped_column(String(20))
    speed_percent: Mapped[int] = mapped_column(SmallInteger)
    timing_mode: Mapped[str] = mapped_column(String(5))
    # Names of the providers that actually ran (the mock ones are named "mock-...").
    translation_provider: Mapped[str] = mapped_column(String(50))
    speech_provider: Mapped[str] = mapped_column(String(50))
    audio_processor: Mapped[str] = mapped_column(String(50))
    # Baseline = last - first sentence start (a timestamp difference, NOT a text length); the
    # target is baseline / speed. The final length is measured on the MP3 when it can be.
    baseline_seconds: Mapped[int] = mapped_column(Integer)
    target_audio_seconds: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    final_audio_seconds: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    source_chars: Mapped[int] = mapped_column(Integer)
    blocks: Mapped[int | None] = mapped_column(Integer)  # timed mode only
    # Wall time of the audio processing stage (FFmpeg with the ffmpeg processor) and the MP3 size.
    audio_ms: Mapped[int | None] = mapped_column(Integer)
    mp3_bytes: Mapped[int | None] = mapped_column(BigInteger)
    outcome: Mapped[str | None] = mapped_column(String(10))
    error_code: Mapped[str | None] = mapped_column(String(50))
    # How many attempts this process meant to record, and how many writes failed: the report
    # compares the first with the rows it finds.
    attempts_expected: Mapped[int | None] = mapped_column(Integer)
    write_errors: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    method_version: Mapped[int] = mapped_column(SmallInteger, default=1, server_default="1")


class UsageAttempt(Base):
    """One request sent to a provider (a request holding many blocks is one attempt)."""

    __tablename__ = "job_usage_attempts"
    __table_args__ = (
        CheckConstraint("service IN ('translator','speech')", name="service_valid"),
        CheckConstraint("provider_kind IN ('azure','mock')", name="provider_kind_valid"),
        CheckConstraint(
            "outcome IN ('ok','http_error','timeout','network_error','cancelled',"
            "'unusable_response','failed')",
            name="outcome_valid",
        ),
        CheckConstraint(
            "usage_basis IN ('actual','estimated','unknown','none')", name="usage_basis_valid"
        ),
        Index("ix_job_usage_attempts_started_at", "started_at"),
    )

    # (job_id, seq) is the identity of an attempt: writing it twice changes nothing.
    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    service: Mapped[str] = mapped_column(String(10))
    provider_kind: Mapped[str] = mapped_column(String(5))
    operation: Mapped[str] = mapped_column(String(24))
    outcome: Mapped[str] = mapped_column(String(20))
    http_status: Mapped[int | None] = mapped_column(SmallInteger)
    error_code: Mapped[str | None] = mapped_column(String(50))
    items: Mapped[int] = mapped_column(Integer, default=1)  # elements / blocks in the request
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    elapsed_ms: Mapped[int] = mapped_column(Integer)
    # What was sent, in its own unit; not necessarily what is billed.
    sent_amount: Mapped[int | None] = mapped_column(BigInteger)
    sent_unit: Mapped[str | None] = mapped_column(String(48))
    # What is billed: actual (provider-reported), estimated (our reading of the rules), unknown
    # (NULL amount: never 0), or none (nothing was sent, or a mock that is not billed).
    usage_amount: Mapped[int | None] = mapped_column(BigInteger)
    usage_unit: Mapped[str] = mapped_column(String(16), default="characters")
    usage_basis: Mapped[str] = mapped_column(String(10))
    usage_method: Mapped[str | None] = mapped_column(String(48))
