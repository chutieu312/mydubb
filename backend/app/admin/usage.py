"""Usage & Costs: read-only reports of recorded usage and reference costs, for administrators.

Every route depends on `require_admin` (through the router's dependency, solved before anything else
about the request is looked at), returns the connection that check used, and only then reads through
`app.usage.queries`, in its own short read-only snapshot on another. A response holds only the
fields declared here, built before the transaction ends: no transcript, translation, SSML, identity,
address, URL of a video or provider message exists in the usage tables, and a job id gives access to
its usage figures, never to the job.

docs/USAGE_COSTS.md, "The Usage & Costs page".
"""

import logging
import re
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.dependencies import get_db, get_services, require_admin
from app.errors import ApiError
from app.languages import TargetLanguage
from app.services import AppServices
from app.usage import queries
from app.usage.models import UsageAttempt
from app.usage.pricing import PriceBook, default_price_book
from app.usage.report import (
    SERVICES,
    Filters,
    JobReport,
    Totals,
    attempt_cost,
    parse_instant,
)

logger = logging.getLogger(__name__)


def _admin_holding_no_connection(
    _: Annotated[Principal, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """`require_admin`, then its transaction ends and its connection goes back to the pool (`db` is
    the session it used: a request has one `get_db`, and its closing commit then has nothing left).

    A report asks for a connection of its own. Waiting for it while holding this one would let
    requests take the whole pool and wait for each other until the pool times out. Nothing later
    in the request reads through this session, and the check it made stands as for any request."""
    with _report_errors():
        db.commit()


router = APIRouter(
    prefix="/api/admin/usage", tags=["admin"], dependencies=[Depends(_admin_holding_no_connection)]
)

DEFAULT_PERIOD = timedelta(days=7)
MAX_PERIOD = timedelta(days=31)
_MAX_CURSOR = 512
# PostgreSQL's codes for a statement cancelled by statement_timeout and a lock not obtained.
_TIMED_OUT = {"57014", "55P03"}
# Error codes are fixed labels or an exception's type name; anything else is not shown.
_SAFE_CODE = re.compile(r"[A-Za-z0-9_.-]{1,50}")


def _money(value: Decimal) -> str:
    """Exact: the page only rounds for display, and never adds what it shows."""
    return format(value, "f")


def _safe_code(code: str | None) -> str | None:
    if code is None:
        return None
    return code if _SAFE_CODE.fullmatch(code) else "other"


class AppliedFilters(BaseModel):
    """What the figures are for, after defaults and conversion to UTC."""

    since: datetime
    until: datetime
    language: str | None
    job_id: uuid.UUID | None


class ServiceUsage(BaseModel):
    """Characters of one service. A mock request is counted apart and is never usage."""

    service: str
    requests: int
    mock_requests: int
    actual_requests: int
    actual_characters: int
    estimated_requests: int
    estimated_characters: int
    unknown_requests: int
    unknown_sent_characters: int  # a size sent, not a billing figure
    none_requests: int
    outcomes: dict[str, int]
    unpriced_characters: int
    reference_cost: str


class PriceLine(BaseModel):
    service: str
    sku: str
    meter: str
    region: str
    unit: str
    price: str
    currency: str
    effective_from: date
    checked_on: date
    source: str
    characters: int
    amount: str


class ReferenceCost(BaseModel):
    currency: str
    known_total: str
    # True (with why) when the figure is only a lower bound of what was recorded as used.
    partial: bool
    partial_reasons: list[str]
    lines: list[PriceLine]


class SummaryResponse(BaseModel):
    generated_at: datetime
    filters: AppliedFilters
    first_usage_at: datetime | None
    jobs_total: int
    statuses: dict[str, int]
    complete: int
    incomplete: int
    reasons: dict[str, int]
    jobs_with_mock: int
    jobs_without_usage: int
    services: list[ServiceUsage]
    reference_cost: ReferenceCost


class JobRow(BaseModel):
    job_id: uuid.UUID
    started_at: datetime
    finished_at: datetime | None
    language: str
    voice: str
    speed_percent: int
    timing_mode: str
    status: str
    outcome: str | None
    error_code: str | None
    providers: str
    complete: bool
    reasons: list[str]
    services: list[ServiceUsage]
    reference_cost: ReferenceCost
    baseline_seconds: int
    target_audio_seconds: str
    final_audio_seconds: str | None
    audio_processing_ms: int | None
    mp3_bytes: int | None


class JobsResponse(BaseModel):
    generated_at: datetime
    filters: AppliedFilters
    jobs: list[JobRow]
    next_cursor: str | None


class AttemptRow(BaseModel):
    seq: int
    service: str
    provider_kind: str
    outcome: str
    http_status: int | None
    error_code: str | None
    started_at: datetime
    elapsed_ms: int
    usage_amount: int | None
    usage_unit: str
    usage_basis: str
    usage_method: str | None
    reference_cost: str | None
    # mock | none | unknown_usage | no_reference_price: why there is no reference cost.
    no_cost_reason: str | None


class JobDetailResponse(BaseModel):
    generated_at: datetime
    job: JobRow
    method_version: int
    attempts_total: int
    attempts: list[AttemptRow]
    next_cursor: str | None


def _service_usage(totals: Totals, service: str, prices: PriceBook) -> ServiceUsage:
    return ServiceUsage(
        service=service,
        requests=totals.requests[service],
        mock_requests=totals.mock_requests[service],
        actual_requests=totals.basis_requests[(service, "actual")],
        actual_characters=totals.characters(service, "actual"),
        estimated_requests=totals.basis_requests[(service, "estimated")],
        estimated_characters=totals.characters(service, "estimated"),
        unknown_requests=totals.unknown_requests[service],
        unknown_sent_characters=totals.unknown_sent[service],
        none_requests=totals.basis_requests[(service, "none")],
        outcomes={o: n for (s, o), n in totals.outcomes.items() if s == service},
        unpriced_characters=totals.unpriced(service),
        reference_cost=_money(totals.cost(service, prices)),
    )


def _reference_cost(
    totals: Totals, prices: PriceBook, *, incomplete: int, without_usage: int = 0
) -> ReferenceCost:
    lines = totals.cost_lines(prices)
    reasons = []
    if sum(totals.unknown_requests.values()):
        reasons.append("unknown_usage")
    if any(totals.unpriced(service) for service in SERVICES):
        reasons.append("unpriced_usage")
    if incomplete:
        reasons.append("incomplete_jobs")
    if without_usage:
        reasons.append("jobs_without_usage")
    return ReferenceCost(
        currency=prices.currency,
        known_total=_money(sum((line.amount for line in lines), Decimal(0))),
        partial=bool(reasons),
        partial_reasons=reasons,
        lines=[
            PriceLine(
                service=line.service,
                sku=line.price.sku,
                meter=line.price.meter,
                region=line.price.region,
                unit=line.price.unit,
                price=_money(line.price.price),
                currency=line.price.currency,
                effective_from=line.price.effective_from,
                checked_on=line.price.checked_on,
                source=line.price.source,
                characters=line.characters,
                amount=_money(line.amount),
            )
            for line in lines
        ],
    )


def _job_row(job: JobReport, prices: PriceBook) -> JobRow:
    usage = job.usage
    totals = Totals()
    totals.add_job(job, prices)
    final = usage.final_audio_seconds
    return JobRow(
        job_id=usage.job_id,
        started_at=usage.started_at,
        finished_at=usage.finished_at,
        language=usage.target_language,
        voice=usage.voice,
        speed_percent=usage.speed_percent,
        timing_mode=usage.timing_mode,
        status=job.status,
        outcome=usage.outcome,
        error_code=_safe_code(job.error_code),
        providers=job.providers,
        complete=job.complete,
        reasons=job.reasons,
        services=[_service_usage(totals, service, prices) for service in SERVICES],
        reference_cost=_reference_cost(totals, prices, incomplete=int(not job.complete)),
        baseline_seconds=usage.baseline_seconds,
        target_audio_seconds=format(usage.target_audio_seconds, "f"),
        final_audio_seconds=None if final is None else format(final, "f"),
        audio_processing_ms=usage.audio_ms,
        mp3_bytes=usage.mp3_bytes,
    )


def _attempt_row(attempt: UsageAttempt, prices: PriceBook) -> AttemptRow:
    cost, reason = attempt_cost(attempt, prices)
    return AttemptRow(
        seq=attempt.seq,
        service=attempt.service,
        provider_kind=attempt.provider_kind,
        outcome=attempt.outcome,
        http_status=attempt.http_status,
        error_code=_safe_code(attempt.error_code),
        started_at=attempt.started_at,
        elapsed_ms=attempt.elapsed_ms,
        usage_amount=attempt.usage_amount,
        usage_unit=attempt.usage_unit,
        usage_basis=attempt.usage_basis,
        usage_method=attempt.usage_method,
        reference_cost=None if cost is None else _money(cost),
        no_cost_reason=reason,
    )


def _invalid(field: str, message: str) -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "validation_error",
        "The request contains invalid fields.",
        extra={"fields": [{"field": field, "message": message}]},
    )


def _instant(field: str, value: str) -> datetime:
    try:
        return parse_instant(value)
    except (ValueError, OverflowError):
        raise _invalid(field, "Must be an ISO date or date and time.") from None


def _period(since: str | None, until: str | None) -> tuple[datetime, datetime]:
    """`since <= job_usage.started_at < until`, as in the command-line report. By default the last
    seven days. Never clamped: a period that is not allowed is refused."""
    end = _instant("until", until) if until is not None else None
    start = _instant("since", since) if since is not None else None
    if start is None:
        end = end or datetime.now(UTC)
        start = end - DEFAULT_PERIOD
    elif end is None:
        end = datetime.now(UTC)
    if start >= end:
        raise _invalid("since", "Must be earlier than until.")
    if end - start > MAX_PERIOD:
        raise _invalid("until", f"The period can be at most {MAX_PERIOD.days} days.")
    return start, end


class PeriodParams:
    def __init__(
        self,
        since: Annotated[str | None, Query(max_length=64)] = None,
        until: Annotated[str | None, Query(max_length=64)] = None,
        language: TargetLanguage | None = None,
        job_id: uuid.UUID | None = None,
    ) -> None:
        start, end = _period(since, until)
        self.filters = Filters(
            since=start,
            until=end,
            job_ids=(job_id,) if job_id else (),
            language=language.value if language else None,
        )
        self.applied = AppliedFilters(
            since=start,
            until=end,
            language=language.value if language else None,
            job_id=job_id,
        )


@contextmanager
def _report_errors() -> Iterator[None]:
    """A failed report is an error, never an empty report. The exception's text can quote SQL, its
    parameters or the connection: its type alone is logged and nothing of it is returned."""
    try:
        yield
    except queries.SummaryBudgetExceeded:
        logger.warning("Usage report stopped: the summary went over its time budget")
        raise _timed_out() from None
    except SQLAlchemyError as exc:
        logger.warning("Usage report failed (%s)", type(exc).__name__)
        sqlstate = getattr(getattr(exc, "orig", None), "sqlstate", None)
        if sqlstate in _TIMED_OUT or isinstance(exc, PoolTimeoutError):
            raise _timed_out() from None
        raise ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "usage_report_unavailable",
            "The usage report could not be read. Please try again.",
        ) from None


def _timed_out() -> ApiError:
    return ApiError(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "usage_report_timeout",
        "The usage report took too long. Please try again or choose a shorter period.",
    )


def _bad_cursor(exc: ValueError) -> ApiError:
    if isinstance(exc, queries.CursorFilterMismatch):
        return _invalid(
            "cursor", "This cursor belongs to other filters. Start from the first page."
        )
    return _invalid("cursor", "This cursor is not valid. Start from the first page.")


Services = Annotated[AppServices, Depends(get_services)]
Period = Annotated[PeriodParams, Depends()]
Cursor = Annotated[str | None, Query(max_length=_MAX_CURSOR)]


@router.get("/summary", response_model=SummaryResponse)
def usage_summary(period: Period, services: Services) -> dict[str, Any]:
    """The whole filtered period, whatever page of jobs is being shown."""
    prices = default_price_book()
    budget = queries.SummaryBudget()
    with _report_errors(), queries.report_snapshot(services.session_factory) as db:
        summary = queries.summarize_period(db, period.filters, prices, budget)
        totals = summary.totals
        return {
            "generated_at": datetime.now(UTC),
            "filters": period.applied,
            "first_usage_at": summary.first_usage_at,
            "jobs_total": totals.jobs,
            "statuses": dict(summary.statuses),
            "complete": totals.jobs - summary.incomplete,
            "incomplete": summary.incomplete,
            "reasons": dict(summary.reasons),
            "jobs_with_mock": summary.jobs_with_mock,
            "jobs_without_usage": summary.jobs_without_usage,
            "services": [_service_usage(totals, service, prices) for service in SERVICES],
            "reference_cost": _reference_cost(
                totals,
                prices,
                incomplete=summary.incomplete,
                without_usage=summary.jobs_without_usage,
            ),
        }


@router.get("/jobs", response_model=JobsResponse)
def usage_jobs(
    period: Period,
    services: Services,
    cursor: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> dict[str, Any]:
    """Jobs with a usage record: `started_at DESC, job_id DESC`. A next page must be asked for with
    the same filters as the response that gave its cursor, `since` and `until` included."""
    prices = default_price_book()
    with _report_errors(), queries.report_snapshot(services.session_factory) as db:
        try:
            jobs, next_cursor = queries.list_jobs(db, period.filters, cursor, limit)
        except (queries.InvalidCursor, queries.CursorFilterMismatch) as exc:
            raise _bad_cursor(exc) from None
        return {
            "generated_at": datetime.now(UTC),
            "filters": period.applied,
            "jobs": [_job_row(job, prices) for job in jobs],
            "next_cursor": next_cursor,
        }


@router.get("/jobs/{job_id}", response_model=JobDetailResponse)
def usage_job(
    job_id: uuid.UUID,
    services: Services,
    cursor: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, Any]:
    """One job's usage and a page of its attempts (`seq`). The job's own figures always cover all
    its attempts. It is the same answer for a job without a usage record and an unknown id."""
    prices = default_price_book()
    with _report_errors(), queries.report_snapshot(services.session_factory) as db:
        try:
            detail = queries.job_detail(db, job_id, cursor, limit)
        except (queries.InvalidCursor, queries.CursorFilterMismatch) as exc:
            raise _bad_cursor(exc) from None
        if detail is None:
            raise ApiError(
                status.HTTP_404_NOT_FOUND,
                "job_usage_not_found",
                "No usage record is stored for this job.",
            )
        return {
            "generated_at": datetime.now(UTC),
            "job": _job_row(detail.job, prices),
            "method_version": detail.job.usage.method_version,
            "attempts_total": len(detail.job.attempts),
            "attempts": [_attempt_row(a, prices) for a in detail.attempts_page],
            "next_cursor": detail.next_cursor,
        }
