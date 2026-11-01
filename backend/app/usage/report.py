"""Usage report: reads the usage tables (and, for status only, `jobs`) and never writes.

Three things are kept apart everywhere, in the text and in the CSV:

* **usage recorded**: characters per attempt, labelled `actual` (provider-reported
  `X-metered-usage`), `estimated` (our reading of the Speech rules, `metering.py`) or `unknown`
  (never counted as 0);
* **reference cost**: that usage at the paid-tier list prices of `reference_prices.json`; the
  services currently run on the Free tier, so this is not what was invoiced;
* **invoice**: not verified, and not computed here.

Conventions. All times are UTC. A period filter is half-open, `since <= job_usage.started_at <
until` (the moment the pipeline began the job). Money is `Decimal`: characters x price / 1,000,000
is exact, sums are exact, and only the display rounds (half up, 4 decimals; the CSV keeps every
digit). Seconds are shown to 3 decimals. Mock-provider attempts are counted apart and excluded from
usage and cost.
"""

import csv
import statistics
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import TextIO

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.jobs.models import Job
from app.usage.models import JobUsage, UsageAttempt
from app.usage.pricing import PriceBook, ReferencePrice, default_price_book

SERVICES = ("translator", "speech")
NOT_INCLUDED = (
    "Supadata YouTube import (a separate operation, not a dubbing job), Render, Neon, payments, "
    "taxes and anything else the application costs."
)
INVOICE_NOTE = (
    "Actual invoice: not verified. Translator and Speech currently run on the Free (F0) tier "
    "(Product Owner); the free allowance is NOT deducted from the reference cost."
)
_CENT = Decimal("0.0001")


@dataclass(frozen=True)
class Filters:
    since: datetime | None = None
    until: datetime | None = None
    job_ids: tuple[uuid.UUID, ...] = ()
    language: str | None = None


@dataclass
class JobReport:
    usage: JobUsage
    status: str  # the job's own status when its row still exists, else the recorded outcome
    error_code: str | None
    attempts: list[UsageAttempt] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.reasons

    @property
    def providers(self) -> str:
        kinds = {a.provider_kind for a in self.attempts}
        if not kinds:
            return "none"
        return "real" if kinds == {"azure"} else "mock" if kinds == {"mock"} else "mixed"


@dataclass
class Totals:
    """Usage of a group of jobs. Only real (non-mock) attempts feed the character sums."""

    jobs: int = 0
    requests: Counter = field(default_factory=Counter)  # service -> attempts (real)
    outcomes: Counter = field(default_factory=Counter)  # (service, outcome) -> attempts (real)
    mock_requests: Counter = field(default_factory=Counter)
    chars: Counter = field(default_factory=Counter)  # (service, basis, price key) -> characters
    unknown_requests: Counter = field(default_factory=Counter)
    unknown_sent: Counter = field(default_factory=Counter)  # service -> chars sent, not billing

    def add_job(self, job: JobReport, prices: PriceBook) -> None:
        self.jobs += 1
        for a in job.attempts:
            if a.provider_kind == "mock":
                self.mock_requests[a.service] += 1
                continue
            self.requests[a.service] += 1
            self.outcomes[(a.service, a.outcome)] += 1
            if a.usage_basis in ("actual", "estimated") and a.usage_amount is not None:
                price = prices.price_for(a.service, a.started_at.astimezone(UTC).date())
                self.chars[(a.service, a.usage_basis, _price_key(price))] += a.usage_amount
            elif a.usage_basis == "unknown":
                self.unknown_requests[a.service] += 1
                self.unknown_sent[a.service] += a.sent_amount or 0

    def characters(self, service: str, basis: str) -> int:
        return sum(n for (s, b, _), n in self.chars.items() if s == service and b == basis)

    def cost(self, service: str, prices: PriceBook) -> Decimal:
        """Reference cost of the known (actual + estimated) characters of a service."""
        return sum(
            (
                _price_of(prices, service, key).cost(n)
                for (s, _, key), n in self.chars.items()
                if s == service and key is not None
            ),
            Decimal(0),
        )

    def unpriced(self, service: str) -> int:
        return sum(n for (s, _, key), n in self.chars.items() if s == service and key is None)


def _price_key(price: ReferencePrice | None) -> tuple[str, str, str, str] | None:
    return (
        None
        if price is None
        else (price.service, price.sku, price.region, str(price.effective_from))
    )


def _price_of(prices: PriceBook, service: str, key: tuple[str, str, str, str]) -> ReferencePrice:
    day = date.fromisoformat(key[3])
    price = prices.price_for(service, day)
    assert price is not None
    return price


@dataclass
class Report:
    filters: Filters
    prices: PriceBook
    jobs: list[JobReport]
    jobs_without_usage: int
    first_usage_at: datetime | None
    generated_at: datetime

    def totals(self) -> Totals:
        totals = Totals()
        for job in self.jobs:
            totals.add_job(job, self.prices)
        return totals


def build_report(db: Session, filters: Filters, prices: PriceBook | None = None) -> Report:
    prices = prices or default_price_book()
    conditions = _usage_conditions(filters)
    rows = db.execute(
        select(JobUsage, Job.status, Job.error_code)
        .outerjoin(Job, Job.id == JobUsage.job_id)
        .where(*conditions)
        .order_by(JobUsage.started_at, JobUsage.job_id)
    ).all()
    jobs = {
        usage.job_id: JobReport(
            usage, status or usage.outcome or "unknown", job_code or usage.error_code
        )
        for usage, status, job_code in rows
    }
    attempts = db.scalars(
        select(UsageAttempt)
        .join(JobUsage, JobUsage.job_id == UsageAttempt.job_id)
        .where(*conditions)
        .order_by(UsageAttempt.job_id, UsageAttempt.seq)
    )
    seen: set[tuple[uuid.UUID, int]] = set()
    for attempt in attempts:
        key = (attempt.job_id, attempt.seq)
        if key in seen:  # the primary key forbids it; a report never adds an attempt twice
            continue
        seen.add(key)
        jobs[attempt.job_id].attempts.append(attempt)
    for job in jobs.values():
        job.reasons = _reasons(job)
    first_usage_at = db.scalar(select(func.min(JobUsage.started_at)))
    without_usage = _jobs_without_usage(db, filters)
    # The report outlives the session (and its rollback): keep every loaded value on the objects.
    db.expunge_all()
    return Report(
        filters=filters,
        prices=prices,
        jobs=list(jobs.values()),
        jobs_without_usage=without_usage,
        first_usage_at=first_usage_at,
        generated_at=datetime.now(UTC),
    )


def _usage_conditions(f: Filters) -> list:
    conditions = []
    if f.since is not None:
        conditions.append(JobUsage.started_at >= f.since)
    if f.until is not None:
        conditions.append(JobUsage.started_at < f.until)
    if f.job_ids:
        conditions.append(JobUsage.job_id.in_(f.job_ids))
    if f.language:
        conditions.append(JobUsage.target_language == f.language)
    return conditions


def _jobs_without_usage(db: Session, f: Filters) -> int:
    """Jobs of the period with no usage row at all (created before recording existed, or the
    record could not be written). Matched on `jobs.created_at`, so a job at the edge of the
    period can be counted here and found in the other period."""
    conditions = [~select(JobUsage.job_id).where(JobUsage.job_id == Job.id).exists()]
    if f.since is not None:
        conditions.append(Job.created_at >= f.since)
    if f.until is not None:
        conditions.append(Job.created_at < f.until)
    if f.job_ids:
        conditions.append(Job.id.in_(f.job_ids))
    if f.language:
        conditions.append(Job.target_language == f.language)
    return db.scalar(select(func.count()).select_from(Job).where(and_(*conditions))) or 0


def _reasons(job: JobReport) -> list[str]:
    u, attempts = job.usage, job.attempts
    reasons = []
    if u.finished_at is None:
        reasons.append("no_ending_recorded")  # crash/restart: the last request may be missing
    seqs = sorted(a.seq for a in attempts)
    fewer_than_expected = u.attempts_expected is not None and len(seqs) < u.attempts_expected
    if fewer_than_expected or (seqs and seqs != list(range(1, len(seqs) + 1))):
        reasons.append("attempts_missing")
    if u.write_errors:
        reasons.append("write_errors")
    if any(a.provider_kind == "azure" and a.usage_basis == "unknown" for a in attempts):
        reasons.append("usage_unknown")
    if u.outcome == "completed":
        for service, provider in (
            ("translator", u.translation_provider),
            ("speech", u.speech_provider),
        ):
            if not provider.startswith("mock") and not any(a.service == service for a in attempts):
                reasons.append(f"no_{service}_attempt")
    return reasons


# -- text summary ---------------------------------------------------------------------------


def _money(value: Decimal) -> str:
    return f"{value.quantize(_CENT, rounding=ROUND_HALF_UP):,}"


def _n(value: int) -> str:
    return f"{value:,}"


def _iso(value: datetime | None) -> str:
    return "-" if value is None else value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def render_summary(report: Report) -> str:
    f, book = report.filters, report.prices
    all_totals = report.totals()
    jobs = report.jobs
    lines = [
        "MyDubb usage report - recorded usage and REFERENCE costs, not an invoice",
        f"Generated {_iso(report.generated_at)}. All times UTC; since <= started < until.",
        f"Period: since {_iso(f.since)} until {_iso(f.until)}"
        + (f"; language {f.language}" if f.language else "")
        + (f"; {len(f.job_ids)} job id filter(s)" if f.job_ids else ""),
        f"Usage recording began (first record in the database): {_iso(report.first_usage_at)}",
        "",
    ]
    statuses = Counter(j.status for j in report.jobs)
    complete = sum(j.complete for j in report.jobs)
    reasons = Counter(r for j in report.jobs for r in j.reasons)
    lines += [
        f"Jobs with a usage record: {_n(len(report.jobs))}  "
        + ", ".join(f"{k} {_n(v)}" for k, v in sorted(statuses.items())),
        f"  complete {_n(complete)}, incomplete {_n(len(report.jobs) - complete)}"
        + (
            " (" + ", ".join(f"{k} {_n(v)}" for k, v in sorted(reasons.items())) + ")"
            if reasons
            else ""
        ),
        f"  jobs created in the period WITHOUT any usage record: {_n(report.jobs_without_usage)}"
        " (made before recording began, or the record could not be written)",
        f"  jobs with mock providers: {_n(sum(j.providers in ('mock', 'mixed') for j in jobs))}"
        f" ({_n(sum(all_totals.mock_requests.values()))} mock request(s), excluded below)",
        "",
    ]
    for service, title, basis in (
        ("translator", "Translator (characters)", "actual"),
        ("speech", "Speech (characters)", "estimated"),
    ):
        lines += _service_block(all_totals, service, title, basis, book)
    lines += _cost_block(all_totals, book)
    lines += _breakdown(report, "language", lambda j: j.usage.target_language)
    lines += _breakdown(report, "timing mode", lambda j: j.usage.timing_mode)
    lines += _breakdown(report, "client", lambda j: j.usage.client)
    lines += _audio_block(report)
    lines += [
        "",
        "NOT included: " + NOT_INCLUDED,
        INVOICE_NOTE,
        "Method: Translator usage is the provider's X-metered-usage header (actual); Speech is an"
        " estimate from the SSML rules of Microsoft's pricing note (method"
        " azure-speech-ssml-characters-v1). Neither is read from an invoice.",
        "Output minutes are not a cost measure: baseline = last - first sentence start (a"
        " timestamp difference), not a text length. Cost follows characters.",
    ]
    return "\n".join(lines) + "\n"


def _service_block(t: Totals, service: str, title: str, basis: str, book: PriceBook) -> list[str]:
    outcomes = ", ".join(f"{o} {_n(n)}" for (s, o), n in sorted(t.outcomes.items()) if s == service)
    known = t.characters(service, basis)
    label = "actual (X-metered-usage)" if basis == "actual" else "estimated (SSML rules)"
    lines = [
        title,
        f"  requests: {_n(t.requests[service])}" + (f"  [{outcomes}]" if outcomes else ""),
        f"  characters, {label}: {_n(known)}",
        f"  requests with UNKNOWN usage: {_n(t.unknown_requests[service])}"
        + (
            f" (sent {_n(t.unknown_sent[service])} characters; a size sent, not a billing figure)"
            if t.unknown_requests[service]
            else ""
        ),
    ]
    if t.unpriced(service):
        lines.append(
            f"  {_n(t.unpriced(service))} characters have no reference price for their date"
        )
    return [*lines, ""]


def _cost_block(t: Totals, book: PriceBook) -> list[str]:
    lines = [f"Reference cost at paid-tier list prices ({book.currency}; services are on Free)"]
    total = Decimal(0)
    for service in SERVICES:
        keys = sorted({k for (s, _, k) in t.chars if s == service and k is not None}, key=str)
        for key in keys:
            price = _price_of(book, service, key)
            chars = sum(n for (s, _, k), n in t.chars.items() if s == service and k == key)
            amount = price.cost(chars)
            total += amount
            lines.append(
                f"  {service} {price.sku} {price.region} {price.price}/1M chars"
                f" (effective {price.effective_from}, checked {price.checked_on}):"
                f" {_n(chars)} chars = {_money(amount)}"
            )
    unknown = sum(t.unknown_requests.values())
    lines.append(
        f"  total of KNOWN usage: {_money(total)} {book.currency}"
        + (f"  -- a lower bound: {_n(unknown)} request(s) have unknown usage" if unknown else "")
    )
    lines.append("  This is not the application's total cost: see NOT included below.")
    return [*lines, ""]


def _breakdown(report: Report, title: str, key) -> list[str]:
    groups: dict[str, list[JobReport]] = defaultdict(list)
    for job in report.jobs:
        groups[key(job)].append(job)
    if len(groups) < 2:
        return []
    lines = [
        f"By {title}: jobs, translator actual chars, speech estimated chars, reference cost known"
    ]
    for name, members in sorted(groups.items()):
        t = Totals()
        for job in members:
            t.add_job(job, report.prices)
        cost = sum((t.cost(s, report.prices) for s in SERVICES), Decimal(0))
        lines.append(
            f"  {name:<22} {_n(t.jobs):>6} {_n(t.characters('translator', 'actual')):>12}"
            f" {_n(t.characters('speech', 'estimated')):>12} {_money(cost):>12}"
        )
    return [*lines, ""]


def _audio_block(report: Report) -> list[str]:
    done = [j for j in report.jobs if j.usage.outcome == "completed"]
    baseline = sum(j.usage.baseline_seconds for j in done)
    target = sum(j.usage.target_audio_seconds for j in done)
    finals = [j.usage.final_audio_seconds for j in done if j.usage.final_audio_seconds is not None]
    per_minute = []
    for job in done:
        chars = sum(
            a.usage_amount or 0
            for a in job.attempts
            if a.service == "speech" and a.usage_basis == "estimated"
        )
        if chars and job.usage.target_audio_seconds > 0 and job.complete:
            per_minute.append(float(chars) / (float(job.usage.target_audio_seconds) / 60))
    lines = [
        "Audio of completed jobs",
        f"  jobs {_n(len(done))}; baseline {baseline:,}s; target {target:,.3f}s;"
        f" final audio measured on {_n(len(finals))} job(s): {sum(finals, Decimal(0)):,.3f}s",
        f"  mp3 bytes known for {_n(sum(j.usage.mp3_bytes is not None for j in done))} job(s):"
        f" {_n(sum(j.usage.mp3_bytes or 0 for j in done))}",
        f"  audio-stage time (FFmpeg with the ffmpeg processor): "
        f"{_n(sum(j.usage.audio_ms or 0 for j in done))} ms "
        f"on {_n(sum(j.usage.audio_ms is not None for j in done))} job(s)",
    ]
    if per_minute:
        lines.append(
            "  speech characters per output minute (complete jobs): "
            f"min {min(per_minute):,.0f}, median {statistics.median(per_minute):,.0f}, "
            f"max {max(per_minute):,.0f}  (n={len(per_minute)})"
        )
    return lines


# -- CSV ------------------------------------------------------------------------------------

JOB_COLUMNS = (
    "job_id", "started_at_utc", "finished_at_utc", "status", "outcome", "error_code",
    "client", "access", "language", "voice", "speed_percent", "timing_mode",
    "translation_provider", "speech_provider", "audio_processor", "providers",
    "baseline_seconds", "target_audio_seconds", "final_audio_seconds", "source_chars", "blocks",
    "translator_requests", "translator_unknown_requests", "translator_chars_actual",
    "translator_chars_sent_unknown", "speech_requests", "speech_unknown_requests",
    "speech_chars_estimated", "speech_chars_sent_unknown", "audio_ms", "mp3_bytes",
    "attempts_expected", "attempts_found", "write_errors", "complete", "reasons",
    "ref_cost_translator", "ref_cost_speech", "ref_cost_known", "currency",
)  # fmt: skip
ATTEMPT_COLUMNS = (
    "job_id", "seq", "service", "provider_kind", "operation", "outcome", "http_status",
    "error_code", "items", "started_at_utc", "elapsed_ms", "sent_amount", "sent_unit",
    "usage_amount", "usage_unit", "usage_basis", "usage_method",
)  # fmt: skip


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return _iso(value)
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def write_job_csv(report: Report, out: TextIO) -> None:
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(JOB_COLUMNS)
    for job in report.jobs:
        u = job.usage
        t = Totals()
        t.add_job(job, report.prices)
        cost_t = t.cost("translator", report.prices)
        cost_s = t.cost("speech", report.prices)
        row = {
            "job_id": u.job_id,
            "started_at_utc": u.started_at,
            "finished_at_utc": u.finished_at,
            "status": job.status,
            "outcome": u.outcome,
            "error_code": job.error_code,
            "client": u.client,
            "access": u.access,
            "language": u.target_language,
            "voice": u.voice,
            "speed_percent": u.speed_percent,
            "timing_mode": u.timing_mode,
            "translation_provider": u.translation_provider,
            "speech_provider": u.speech_provider,
            "audio_processor": u.audio_processor,
            "providers": job.providers,
            "baseline_seconds": u.baseline_seconds,
            "target_audio_seconds": u.target_audio_seconds,
            "final_audio_seconds": u.final_audio_seconds,
            "source_chars": u.source_chars,
            "blocks": u.blocks,
            "translator_requests": t.requests["translator"],
            "translator_unknown_requests": t.unknown_requests["translator"],
            "translator_chars_actual": t.characters("translator", "actual"),
            "translator_chars_sent_unknown": t.unknown_sent["translator"],
            "speech_requests": t.requests["speech"],
            "speech_unknown_requests": t.unknown_requests["speech"],
            "speech_chars_estimated": t.characters("speech", "estimated"),
            "speech_chars_sent_unknown": t.unknown_sent["speech"],
            "audio_ms": u.audio_ms,
            "mp3_bytes": u.mp3_bytes,
            "attempts_expected": u.attempts_expected,
            "attempts_found": len(job.attempts),
            "write_errors": u.write_errors,
            "complete": "yes" if job.complete else "no",
            "reasons": ";".join(job.reasons),
            "ref_cost_translator": cost_t,
            "ref_cost_speech": cost_s,
            "ref_cost_known": cost_t + cost_s,
            "currency": report.prices.currency,
        }
        writer.writerow(_cell(row[column]) for column in JOB_COLUMNS)


def write_attempt_csv(report: Report, out: TextIO) -> None:
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(ATTEMPT_COLUMNS)
    for job in report.jobs:
        for a in job.attempts:
            row = {
                "job_id": a.job_id,
                "seq": a.seq,
                "service": a.service,
                "provider_kind": a.provider_kind,
                "operation": a.operation,
                "outcome": a.outcome,
                "http_status": a.http_status,
                "error_code": a.error_code,
                "items": a.items,
                "started_at_utc": a.started_at,
                "elapsed_ms": a.elapsed_ms,
                "sent_amount": a.sent_amount,
                "sent_unit": a.sent_unit,
                "usage_amount": a.usage_amount,
                "usage_unit": a.usage_unit,
                "usage_basis": a.usage_basis,
                "usage_method": a.usage_method,
            }
            writer.writerow(_cell(row[column]) for column in ATTEMPT_COLUMNS)


def parse_instant(value: str) -> datetime:
    """`2026-10-01`, `2026-10-01T08:30`, `...Z` or with an offset -> UTC. No zone means UTC."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC)
