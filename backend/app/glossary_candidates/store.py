"""Glossary candidates in PostgreSQL: counting per job and the batch review.

Two layers, never mixed:

* The **official glossary** (`translation/data/glossary.txt`) is the only list the app uses
  at runtime. It changes only through a reviewed pull request.
* The **candidate store** (table `glossary_candidates`) only collects what jobs saw, for that
  review. Nothing here edits the glossary, opens a pull request, or approves a candidate.

Counting (`record_job_candidates`), one transaction per completed job:

1. Mark the job: `UPDATE jobs SET glossary_candidates_recorded_at = now() WHERE id = :job AND
   glossary_candidates_recorded_at IS NULL`. If no row changes, the job was already counted
   (or no longer exists) and nothing else happens, so recording the same job again never
   counts twice. The marker lives on the job row, which already exists, instead of a
   job-term table that would have to keep every pair forever; it goes away with the job if
   jobs are ever cleaned up, and a job that is gone can no longer be recorded anyway.
2. One `INSERT ... ON CONFLICT (term_key) DO UPDATE SET job_count = job_count + 1` for the
   job's distinct terms (the detection already removed duplicates within the job). Rows are
   locked in key order, so concurrent jobs cannot deadlock, and the row lock serializes their
   increments, so no count is lost and no duplicate row appears.
3. `status`, the review fields and `display_term` are never changed by counting: a rejected
   term stays rejected and an approved one stays approved, only its count and last-seen move.

Short statement and lock timeouts keep a slow database from holding a worker. Any error rolls
the whole batch back (nothing half-counted, job not marked) and leaves the job untouched.
"""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import any_, case, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.glossary_candidates.models import CandidateStatus, CasePolicy, GlossaryCandidate
from app.jobs.models import Job
from app.pronunciation.detector import Candidate, CandidateKind
from app.pronunciation.keys import display_form
from app.translation.glossary import Glossary, GlossaryError

MAX_SPELLINGS = 5
_RECORD_TIMEOUT = "5s"


def record_job_candidates(
    db: Session, job_id: uuid.UUID, candidates: Iterable[Candidate], now: datetime | None = None
) -> bool:
    """Count each candidate once for this job. False when the job was already counted."""
    now = now or datetime.now(UTC)
    by_key: dict[str, Candidate] = {}
    for candidate in candidates:
        by_key.setdefault(candidate.key, candidate)
    db.execute(text(f"SET LOCAL statement_timeout = '{_RECORD_TIMEOUT}'"))
    db.execute(text(f"SET LOCAL lock_timeout = '{_RECORD_TIMEOUT}'"))
    marked = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.glossary_candidates_recorded_at.is_(None))
        .values(glossary_candidates_recorded_at=now)
        .returning(Job.id)
        .execution_options(synchronize_session=False)
    ).first()
    if marked is None:
        return False
    if not by_key:
        return True
    rows = [
        {
            "term_key": key,
            "display_term": by_key[key].term,
            "spellings": [by_key[key].term],
            "kind": by_key[key].kind.value,
            "job_count": 1,
            "first_seen_at": now,
            "last_seen_at": now,
        }
        for key in sorted(by_key)
    ]
    table = GlossaryCandidate.__table__
    stmt = insert(table).values(rows)
    new = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=[table.c.term_key],
        set_={
            "job_count": table.c.job_count + 1,
            "last_seen_at": func.greatest(table.c.last_seen_at, new.last_seen_at),
            "spellings": case(
                (
                    (new.display_term == any_(table.c.spellings))
                    | (func.cardinality(table.c.spellings) >= MAX_SPELLINGS),
                    table.c.spellings,
                ),
                else_=func.array_append(table.c.spellings, new.display_term),
            ),
            # A capitalized sighting inside a sentence is better evidence of a name.
            "kind": case(
                (
                    (new.kind == CandidateKind.PROPER_NAME.value)
                    & (table.c.kind == CandidateKind.WORD.value),
                    new.kind,
                ),
                else_=table.c.kind,
            ),
        },
    )
    db.execute(stmt)
    return True


# --- Review (local administration tool, scripts/glossary_candidates.py) -------------------


class ReviewError(ValueError):
    """A review action that is not allowed; the message is meant for the administrator."""


def list_candidates(
    db: Session, status: CandidateStatus | None, limit: int
) -> list[GlossaryCandidate]:
    """Most frequent first, then most recently seen. Frequency only orders the review."""
    query = select(GlossaryCandidate)
    if status is not None:
        query = query.where(GlossaryCandidate.status == status.value)
    query = query.order_by(
        GlossaryCandidate.job_count.desc(),
        GlossaryCandidate.last_seen_at.desc(),
        GlossaryCandidate.id,
    ).limit(limit)
    return list(db.scalars(query))


def _locked(db: Session, candidate_id: int) -> GlossaryCandidate:
    candidate = db.scalars(
        select(GlossaryCandidate).where(GlossaryCandidate.id == candidate_id).with_for_update()
    ).first()
    if candidate is None:
        raise ReviewError(f"candidate {candidate_id} does not exist")
    return candidate


def glossary_line(term: str, policy: CasePolicy) -> str:
    return f"={term}" if policy is CasePolicy.EXACT else term


def glossary_key(term: str, policy: CasePolicy) -> tuple[str, bool]:
    """The identity the glossary itself uses to reject duplicates."""
    exact = policy is CasePolicy.EXACT
    return (term if exact else term.casefold(), exact)


def _validated_term(term: str, policy: CasePolicy) -> str:
    term = display_form(term)
    if term.startswith(("=", "#")):
        raise ReviewError("the canonical term cannot start with '=' or '#'")
    try:
        parsed = Glossary.from_text(glossary_line(term, policy)).terms()
    except GlossaryError:
        parsed = []
    if parsed != [(term, policy is CasePolicy.EXACT)]:
        raise ReviewError(
            "the canonical term is not a valid glossary line (empty, longer than 100 "
            "characters, or containing <, >, & or control characters)"
        )
    return term


def _covers(term: str, policy: CasePolicy, spelling: str) -> bool:
    matches = Glossary([(term, policy is CasePolicy.EXACT)]).find_matches(spelling)
    return any(m.start == 0 and m.end == len(spelling) for m in matches)


def approve(
    db: Session,
    candidate_id: int,
    *,
    canonical_term: str,
    case_policy: CasePolicy,
    reviewed_by: str | None,
    note: str | None,
    now: datetime | None = None,
) -> GlossaryCandidate:
    """Pending -> approved, with the spelling and case policy the glossary line will use.

    The canonical term must match, by the glossary's own rules (case policy, plural "s"),
    at least one spelling that was actually seen, so an approval cannot drift to another word.
    """
    candidate = _locked(db, candidate_id)
    if candidate.status != CandidateStatus.PENDING:
        raise ReviewError(
            f"candidate {candidate_id} is {candidate.status}; only pending candidates can be "
            "approved (reopen it first)"
        )
    term = _validated_term(canonical_term, case_policy)
    seen = {candidate.display_term, *candidate.spellings}
    if not any(_covers(term, case_policy, spelling) for spelling in seen):
        raise ReviewError(
            "the canonical term does not match any spelling seen for this candidate "
            "with that case policy"
        )
    candidate.status = CandidateStatus.APPROVED.value
    candidate.canonical_term = term
    candidate.case_policy = case_policy.value
    _reviewed(candidate, reviewed_by, note, now)
    return candidate


def reject(
    db: Session,
    candidate_id: int,
    *,
    reviewed_by: str | None,
    note: str | None,
    now: datetime | None = None,
) -> GlossaryCandidate:
    """Pending or approved -> rejected. Later sightings only update its count."""
    candidate = _locked(db, candidate_id)
    if candidate.status not in (CandidateStatus.PENDING, CandidateStatus.APPROVED):
        raise ReviewError(
            f"candidate {candidate_id} is {candidate.status}; only pending or approved "
            "candidates can be rejected"
        )
    candidate.status = CandidateStatus.REJECTED.value
    candidate.canonical_term = None
    candidate.case_policy = None
    _reviewed(candidate, reviewed_by, note, now)
    return candidate


def reopen(db: Session, candidate_id: int) -> GlossaryCandidate:
    """Rejected or approved -> pending, clearing the review. Promoted terms are in the
    glossary; removing one is a glossary pull request, not a status change."""
    candidate = _locked(db, candidate_id)
    if candidate.status not in (CandidateStatus.REJECTED, CandidateStatus.APPROVED):
        raise ReviewError(
            f"candidate {candidate_id} is {candidate.status}; only rejected or approved "
            "candidates can be reopened"
        )
    candidate.status = CandidateStatus.PENDING.value
    candidate.canonical_term = None
    candidate.case_policy = None
    candidate.reviewed_at = None
    candidate.reviewed_by = None
    candidate.review_note = None
    return candidate


def _reviewed(
    candidate: GlossaryCandidate, reviewed_by: str | None, note: str | None, now: datetime | None
) -> None:
    candidate.reviewed_at = now or datetime.now(UTC)
    candidate.reviewed_by = (reviewed_by or "").strip()[:64] or None
    candidate.review_note = (note or "").strip()[:200] or None


@dataclass(frozen=True)
class Export:
    lines: list[tuple[GlossaryCandidate, str]]  # what to propose, in review order
    warnings: list[str]  # for the person preparing the pull request
    errors: list[str]  # conflicts to resolve first; nothing is exported while there are any


def build_export(approved: Sequence[GlossaryCandidate], glossary_text: str) -> Export:
    """Glossary lines for the approved candidates, checked against the glossary and each other.

    Read-only: exporting never marks anything promoted (see `promote`).
    """
    current = Glossary.from_text(glossary_text)
    current_keys = {glossary_key(t, _policy(cs)): t for t, cs in current.terms()}
    lines: list[tuple[GlossaryCandidate, str]] = []
    warnings: list[str] = []
    errors: list[str] = []
    seen: dict[tuple[str, bool], int] = {}
    for candidate in approved:
        assert candidate.canonical_term is not None and candidate.case_policy is not None
        term, policy = candidate.canonical_term, CasePolicy(candidate.case_policy)
        key = glossary_key(term, policy)
        label = f"#{candidate.id} {glossary_line(term, policy)!r}"
        if key in current_keys:
            warnings.append(f"{label} is already in the glossary: not exported (promote it)")
            continue
        if key in seen:
            errors.append(f"{label} duplicates #{seen[key]}: reopen or reject one of them")
            continue
        seen[key] = candidate.id
        covering = [
            other
            for other, cs in current.terms()
            if _covers(other, _policy(cs), term) and glossary_key(other, _policy(cs)) != key
        ]
        if covering:
            warnings.append(f"{label} is already matched by glossary term {covering[0]!r}")
        if policy is CasePolicy.INSENSITIVE:
            for other, cs in current.terms():
                if cs and other.casefold() == term.casefold():
                    warnings.append(
                        f"{label} ignores case and also matches every capitalization of the "
                        f"exact term {other!r}"
                    )
            if " " not in term and term == term.lower():
                warnings.append(
                    f"{label} is a single lowercase word: the glossary keeps everyday words "
                    "out (check that it has no ordinary meaning, or use a phrase)"
                )
        lines.append((candidate, glossary_line(term, policy)))
    if not errors:
        try:
            Glossary.from_text("\n".join([glossary_text, *(line for _, line in lines)]))
        except GlossaryError as exc:
            errors.append(f"the glossary would not load with these lines: {exc}")
    return Export(lines=[] if errors else lines, warnings=warnings, errors=errors)


def _policy(case_sensitive: bool) -> CasePolicy:
    return CasePolicy.EXACT if case_sensitive else CasePolicy.INSENSITIVE


def promote(
    db: Session, glossary_text: str, commit: str, now: datetime | None = None
) -> list[GlossaryCandidate]:
    """Approved -> promoted for each candidate whose exact line (term and case policy) is in
    `glossary_text`, the glossary file of `commit`. The caller verifies that the commit is
    merged into main; approved candidates that are not in that file stay approved."""
    official = {glossary_key(t, _policy(cs)) for t, cs in Glossary.from_text(glossary_text).terms()}
    approved = db.scalars(
        select(GlossaryCandidate)
        .where(GlossaryCandidate.status == CandidateStatus.APPROVED.value)
        .order_by(GlossaryCandidate.id)
        .with_for_update()
    ).all()
    promoted = []
    for candidate in approved:
        assert candidate.canonical_term is not None and candidate.case_policy is not None
        if glossary_key(candidate.canonical_term, CasePolicy(candidate.case_policy)) in official:
            candidate.status = CandidateStatus.PROMOTED.value
            candidate.promoted_at = now or datetime.now(UTC)
            candidate.promoted_commit = commit
            promoted.append(candidate)
    return promoted
