from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    ARRAY,
    BigInteger,
    CheckConstraint,
    DateTime,
    Identity,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class CandidateStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"  # accepted for the next glossary pull request; not in use yet
    REJECTED = "rejected"  # stays rejected when seen again (reopen explicitly)
    PROMOTED = "promoted"  # verified in the glossary of a commit merged into main


class CasePolicy(StrEnum):
    INSENSITIVE = "insensitive"  # an ordinary glossary line
    EXACT = "exact"  # a "=TERM" glossary line


class GlossaryCandidate(Base):
    """An English term detected in translations, waiting for (or after) review.

    Holds the term and counters only: no transcript, translation, excerpt, job or session.
    It has no foreign key to `jobs`, so neither result expiry nor any job or session cleanup
    removes it, and it has no retention of its own. Which jobs were counted is recorded on
    the job row instead (`jobs.glossary_candidates_recorded_at`), see `store.py`.
    """

    __tablename__ = "glossary_candidates"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','approved','rejected','promoted')", name="status_valid"
        ),
        CheckConstraint("kind IN ('word','phrase','proper_name','acronym')", name="kind_valid"),
        CheckConstraint(
            "case_policy IS NULL OR case_policy IN ('insensitive','exact')",
            name="case_policy_valid",
        ),
        CheckConstraint("job_count >= 0", name="job_count_valid"),
        CheckConstraint(
            "status NOT IN ('approved','promoted') "
            "OR (canonical_term IS NOT NULL AND case_policy IS NOT NULL)",
            name="approved_has_canonical",
        ),
        CheckConstraint(
            "status <> 'promoted' OR promoted_commit IS NOT NULL", name="promoted_has_commit"
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    # Deduplication key (pronunciation/keys.py); unique, so concurrent jobs share one row.
    term_key: Mapped[str] = mapped_column(String(100), unique=True)
    # Spelling first seen, for review, and up to five distinct spellings seen since.
    display_term: Mapped[str] = mapped_column(String(100))
    spellings: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'::text[]"))
    kind: Mapped[str] = mapped_column(String(20))
    # Completed jobs whose translation kept the term (each job counts once).
    job_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(10), server_default=text("'pending'"), index=True)
    # Review (set when approved or rejected, cleared when reopened).
    canonical_term: Mapped[str | None] = mapped_column(String(100))
    case_policy: Mapped[str | None] = mapped_column(String(12))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[str | None] = mapped_column(String(64))
    review_note: Mapped[str | None] = mapped_column(String(200))
    promoted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    promoted_commit: Mapped[str | None] = mapped_column(String(40))
