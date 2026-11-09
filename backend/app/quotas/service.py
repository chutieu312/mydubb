"""Daily usage limits: the Free plan's quotas, the shared cap for everyone but administrators,
and the administrator exemption (docs/API.md, "Usage limits").

**Who is limited.** An account's plan sets its quotas (`PLAN_LIMITS`; only Free today). An
administrator (`users.role`, read from the database by the request) is exempt from every MyDubb
usage limit here, whatever the plan; capacity, timeouts and the providers' own limits still apply.
The shared cap (`UsageCaps`, off unless configured) applies to every caller that is not an
administrator: accounts, guests and Access Code sessions. Guests keep their own quotas on top
(app/guest), with their own give-back rules.

**When an operation counts.** At admission, once: `admit` adds one to each counter that applies,
in the caller's transaction, and the caller commits before the work starts (a job's row is written
in the same transaction; an import commits before its provider is called). Nothing is given back
afterwards: an accepted job that fails or an import whose provider fails still counts. A refusal
(a limit reached, or anything that rolls the transaction back) leaves every counter as it was,
because all of them change in that one transaction.

**Atomicity.** Each counter is one row per (subject, kind, UTC day), changed by a single
`INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit`: concurrent admissions of one subject
serialize on that row (any session, client or instance), so together they can never pass a limit.
Lock order is always the subject's own locks first (account counter; or the guest locks), then the
shared `global` counter, so two admissions never wait for each other in a cycle. The row locks are
held only until the caller's short transaction ends; nothing is held while a provider works.

**Time.** The day is the UTC date of the database clock at admission, shared by every instance;
it resets at 00:00 UTC. A job accepted at 23:59 counts on that day whenever it finishes. Counts
live in the database, so a sign-in, another device, a restart or a deploy changes nothing.
"""

import math
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from enum import StrEnum

from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth.models import AccountPlan
from app.auth.principal import Principal
from app.auth.service import database_now
from app.config import Settings
from app.quotas.models import UsageCounter

GLOBAL_SUBJECT = "global"
# Daily counts are needed for today only; a month is kept to look back at recent days.
COUNTER_RETENTION_DAYS = 31
_LOCK_TIMEOUT = "5s"


class QuotaKind(StrEnum):
    GENERATE = "generate"
    YOUTUBE_IMPORT = "youtube_import"


@dataclass(frozen=True)
class PlanLimits:
    generates_per_day: int
    youtube_imports_per_day: int
    # Per job: words of the text sent for translation (timestamps not counted), and the output
    # length (baseline / speed) in seconds.
    max_words: int
    max_output_seconds: int

    def per_day(self, kind: QuotaKind) -> int:
        return (
            self.generates_per_day if kind is QuotaKind.GENERATE else self.youtube_imports_per_day
        )


PLAN_LIMITS: dict[str, PlanLimits] = {
    AccountPlan.FREE.value: PlanLimits(
        generates_per_day=20, youtube_imports_per_day=5, max_words=1000, max_output_seconds=600
    ),
}


def plan_limits(plan: str) -> PlanLimits:
    """The plan's limits. A plan this version does not know gets Free's, never none."""
    return PLAN_LIMITS.get(plan, PLAN_LIMITS[AccountPlan.FREE.value])


@dataclass(frozen=True)
class UsageCaps:
    """The shared daily cap for everyone but administrators (USAGE_CAPS_ENABLED)."""

    generates_per_day: int
    youtube_imports_per_day: int

    def per_day(self, kind: QuotaKind) -> int:
        return (
            self.generates_per_day if kind is QuotaKind.GENERATE else self.youtube_imports_per_day
        )

    @classmethod
    def from_settings(cls, settings: Settings) -> "UsageCaps | None":
        if not settings.usage_caps_enabled:
            return None
        # Settings validation guarantees both numbers once the caps are on.
        assert settings.usage_cap_generates_per_day is not None
        assert settings.usage_cap_youtube_imports_per_day is not None
        return cls(
            generates_per_day=settings.usage_cap_generates_per_day,
            youtube_imports_per_day=settings.usage_cap_youtube_imports_per_day,
        )


class AccountQuotaExhausted(Exception):
    """The account used all of today's operations of this kind that its plan allows."""

    def __init__(
        self, kind: QuotaKind, limit: int, plan: str, resets_at: datetime, retry_after: int
    ) -> None:
        super().__init__(f"account {kind} quota exhausted")
        self.kind = kind
        self.limit = limit
        self.plan = plan
        self.resets_at = resets_at
        self.retry_after = retry_after  # whole seconds until `resets_at`


class UsageCapReached(Exception):
    """The shared daily cap of this kind is reached for everyone but administrators."""

    def __init__(self, kind: QuotaKind, resets_at: datetime, retry_after: int) -> None:
        super().__init__(f"shared {kind} cap reached")
        self.kind = kind
        self.resets_at = resets_at
        self.retry_after = retry_after  # whole seconds until `resets_at`


def account_subject(user_id: uuid.UUID) -> str:
    return f"user:{user_id}"


def utc_day(moment: datetime) -> date:
    return moment.astimezone(UTC).date()


def resets_at(day: date) -> datetime:
    """00:00 UTC after `day`."""
    return datetime.combine(day + timedelta(days=1), time(0), UTC)


def _seconds_until(moment: datetime, now: datetime) -> int:
    return max(1, math.ceil((moment - now).total_seconds()))


def current_time(db: Session) -> datetime:
    """The database clock (the same on every instance). Tests replace it."""
    return database_now(db)


def limit_lock_waits(db: Session) -> None:
    """Bound how long the admission transaction may wait for a counter row (callers whose
    transaction already bounds it, like the guest import runner, do not call this)."""
    db.execute(text(f"SET LOCAL lock_timeout = '{_LOCK_TIMEOUT}'"))


def _count_one(
    db: Session, subject: str, kind: QuotaKind, day: date, limit: int | None, now: datetime
) -> bool:
    """Add one to the counter unless it already reached `limit` (None: no limit, only counted).
    Returns False, changing nothing, when the limit is reached."""
    statement = (
        insert(UsageCounter)
        .values(subject=subject, kind=kind.value, day=day, count=1, updated_at=now)
        .on_conflict_do_update(
            index_elements=[UsageCounter.subject, UsageCounter.kind, UsageCounter.day],
            set_={"count": UsageCounter.count + 1, "updated_at": now},
            where=None if limit is None else UsageCounter.count < limit,
        )
        .returning(UsageCounter.count)
    )
    return db.scalar(statement) is not None


def admit(db: Session, principal: Principal, kind: QuotaKind, caps: UsageCaps | None) -> None:
    """Count one accepted operation for this caller, or refuse it.

    Raises AccountQuotaExhausted or UsageCapReached; the caller then rolls back, so a refusal by
    the shared cap also undoes the account's count. The caller commits on success, before the
    work starts. An administrator's operation is counted on the account (it shows in its usage)
    but never limited, and never counted in the shared cap.
    """
    now = current_time(db)
    day = utc_day(now)
    reset = resets_at(day)
    if principal.user is not None:
        limits = plan_limits(principal.plan)
        limit = None if principal.quota_exempt else limits.per_day(kind)
        if not _count_one(db, account_subject(principal.user.id), kind, day, limit, now):
            assert limit is not None
            raise AccountQuotaExhausted(
                kind, limit, principal.plan, reset, _seconds_until(reset, now)
            )
    if principal.quota_exempt or caps is None:
        return
    if not _count_one(db, GLOBAL_SUBJECT, kind, day, caps.per_day(kind), now):
        raise UsageCapReached(kind, reset, _seconds_until(reset, now))


@dataclass(frozen=True)
class KindUsage:
    used: int
    limit: int | None  # None: not limited (an administrator)

    @property
    def remaining(self) -> int | None:
        return None if self.limit is None else max(0, self.limit - self.used)


@dataclass(frozen=True)
class AccountUsage:
    plan: str
    exempt: bool
    day: date
    resets_at: datetime
    generate: KindUsage
    youtube_import: KindUsage
    limits: PlanLimits


def account_usage(db: Session, principal: Principal) -> AccountUsage:
    """Today's counts of an account (read only)."""
    assert principal.user is not None
    day = utc_day(current_time(db))
    counts = dict(
        db.execute(
            select(UsageCounter.kind, UsageCounter.count).where(
                UsageCounter.subject == account_subject(principal.user.id),
                UsageCounter.day == day,
            )
        ).all()
    )
    limits = plan_limits(principal.plan)

    def usage(kind: QuotaKind) -> KindUsage:
        limit = None if principal.quota_exempt else limits.per_day(kind)
        return KindUsage(used=counts.get(kind.value, 0), limit=limit)

    return AccountUsage(
        plan=principal.plan,
        exempt=principal.quota_exempt,
        day=day,
        resets_at=resets_at(day),
        generate=usage(QuotaKind.GENERATE),
        youtube_import=usage(QuotaKind.YOUTUBE_IMPORT),
        limits=limits,
    )


def delete_old_counters(db: Session) -> int:
    """Retention: counters of days that ended more than COUNTER_RETENTION_DAYS ago."""
    cutoff = utc_day(current_time(db)) - timedelta(days=COUNTER_RETENTION_DAYS)
    result = db.execute(
        delete(UsageCounter)
        .where(UsageCounter.day < cutoff)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0  # type: ignore[attr-defined]
