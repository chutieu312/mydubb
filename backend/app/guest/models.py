import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class GuestSession(Base):
    """A guest's browser session ("Try as guest"): no account, no Cognito identity.

    Like the other session tables, only the SHA-256 hash of the cookie token is stored. `ip_key`
    is a keyed hash (HMAC with GUEST_IP_HASH_KEY) of the client network that started it, kept
    only to limit how many guest sessions one network can start; the raw IP is never stored.
    The lifetime is absolute: nothing ever extends `expires_at`.
    """

    __tablename__ = "guest_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    ip_key: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_guest_sessions_ip_key_created_at", "ip_key", "created_at"),)


class QuotaState(StrEnum):
    # Held from acceptance until the job ends; counts against both quotas.
    RESERVED = "reserved"
    # The job completed: a used job of the session and of the network.
    USED = "used"
    # The job failed (provider, system, interruption): given back, counts for nothing.
    RELEASED = "released"


class GuestJobQuota(Base):
    """One guest job's place in the guest quotas (per session and per client network).

    Written in the same transaction as the job row, and settled in the same transaction as the
    job's terminal status, only from `reserved` (so it is charged or given back exactly once).
    `charged_at` is when it started counting in the network's sliding window: acceptance while
    reserved, completion once used.
    """

    __tablename__ = "guest_job_quota"
    __table_args__ = (
        CheckConstraint("state IN ('reserved','used','released')", name="state_valid"),
        Index("ix_guest_job_quota_ip_key_charged_at", "ip_key", "charged_at"),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
    )
    # NULL once the (expired) guest session row is cleaned up; the network count remains.
    guest_session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("guest_sessions.id", ondelete="SET NULL"), index=True
    )
    ip_key: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(10), index=True)
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    charged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GuestImportQuota(Base):
    """One guest YouTube caption import (an "operation") and its place in the guest import quotas
    (per session and per client network), apart from the job quotas.

    Written (`reserved`) in its own short transaction before the caption provider is called, and
    settled once, only from `reserved`: `used` when the captions were fetched, checked and
    written as a transcript (before the answer is sent), `released` when the import failed.
    `runner_id` and `heartbeat_at` tell whether the instance running it is still alive, so
    recovery releases only operations whose worker is gone. No link, video, caption or transcript
    is stored: the row only counts.
    """

    __tablename__ = "guest_import_quota"
    __table_args__ = (
        CheckConstraint("state IN ('reserved','used','released')", name="state_valid"),
        Index("ix_guest_import_quota_ip_key_charged_at", "ip_key", "charged_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # NULL once the (expired) guest session row is cleaned up; the network count remains.
    guest_session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("guest_sessions.id", ondelete="SET NULL"), index=True
    )
    ip_key: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(10), index=True)
    # The instance (AppServices.instance_id) running the import, and its last sign of life.
    runner_id: Mapped[str] = mapped_column(String(64))
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # When it started counting in the network's sliding window: acceptance while reserved, the
    # successful end once used.
    charged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
