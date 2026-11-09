from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class UsageCounter(Base):
    """How many operations of one kind the backend accepted for one subject on one UTC day.

    The only source the usage limits are enforced from (app/quotas/service.py). Not a usage
    report: it holds no job, text or provider figure, and the usage tables (app/usage) are never
    read to enforce anything. Subjects: `user:<user id>` (an account) and `global` (the shared cap
    for everyone but administrators).
    """

    __tablename__ = "usage_counters"
    __table_args__ = (
        CheckConstraint("kind IN ('generate','youtube_import')", name="kind_valid"),
        CheckConstraint("count >= 0", name="count_valid"),
    )

    subject: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    # The UTC day of the admissions (database clock), not of their completion.
    day: Mapped[date] = mapped_column(Date, primary_key=True, index=True)
    count: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
