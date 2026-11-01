"""A small made-up data set for the report's documentation and `--synthetic` demo.

Nothing here is real: the ids are fixed constants, the numbers were invented to show every case a
report has to handle (complete, failed with an unknown request, interrupted, mock, missing
attempts). It builds in-memory objects only, so the demo needs no database.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from app.usage.pricing import PriceBook, default_price_book
from app.usage.report import Filters, JobReport, Report, _reasons

T0 = datetime(2026, 10, 20, 9, 0, tzinfo=UTC)


def _job(n: int, **values) -> JobReport:
    from app.usage.models import JobUsage

    started = T0 + timedelta(hours=n)
    base = dict(
        job_id=uuid.UUID(int=n),
        started_at=started,
        finished_at=started + timedelta(minutes=2),
        client="web",
        access="invitation",
        target_language="vietnamese",
        voice="AndrewMultilingual",
        speed_percent=100,
        timing_mode="plain",
        translation_provider="azure-translator",
        speech_provider="azure-speech",
        audio_processor="ffmpeg-audio",
        baseline_seconds=300,
        target_audio_seconds=Decimal("300.000"),
        final_audio_seconds=Decimal("300.000"),
        source_chars=4200,
        blocks=None,
        audio_ms=2100,
        mp3_bytes=1_200_000,
        outcome="completed",
        error_code=None,
        attempts_expected=0,
        write_errors=0,
        method_version=1,
    )
    base.update(values)
    return JobReport(JobUsage(**base), base["outcome"] or "failed", base["error_code"])


def _attempt(job: JobReport, service: str, **values) -> None:
    from app.usage.models import UsageAttempt

    seq = len(job.attempts) + 1
    base = dict(
        job_id=job.usage.job_id,
        seq=seq,
        service=service,
        provider_kind="azure",
        operation="translate" if service == "translator" else "synthesize",
        outcome="ok",
        http_status=200,
        error_code=None,
        items=1,
        started_at=job.usage.started_at + timedelta(seconds=seq),
        elapsed_ms=900,
        sent_amount=0,
        sent_unit="characters",
        usage_amount=None,
        usage_unit="characters",
        usage_basis="unknown",
        usage_method=None,
    )
    base.update(values)
    job.attempts.append(UsageAttempt(**base))


def _translator(job: JobReport, charged: int | None, **values) -> None:
    basis = {"usage_amount": charged, "usage_basis": "actual" if charged is not None else "unknown"}
    _attempt(job, "translator", sent_amount=(charged or 0) + 600, **basis, **values)


def _speech(job: JobReport, estimate: int, **values) -> None:
    _attempt(
        job, "speech", sent_amount=estimate - 40, usage_amount=estimate, usage_basis="estimated",
        usage_method="azure-speech-ssml-characters-v1", **values,
    )  # fmt: skip


def synthetic_report(prices: PriceBook | None = None) -> Report:
    jobs = []

    vi = _job(1, attempts_expected=4)  # complete: 1 translator request, 3 speech requests
    _translator(vi, 4_950)
    for chars in (6_100, 6_000, 3_300):
        _speech(vi, chars)
    jobs.append(vi)

    ja = _job(
        2, target_language="japanese", timing_mode="timed", blocks=40, client="extension",
        speed_percent=150, baseline_seconds=600, target_audio_seconds=Decimal("400.000"),
        final_audio_seconds=Decimal("400.000"), source_chars=9000, attempts_expected=3,
    )  # fmt: skip
    _translator(ja, 9_650)
    _speech(ja, 11_800, items=22)  # Han characters count twice
    _speech(ja, 10_900, items=18)
    jobs.append(ja)

    failed = _job(
        3, outcome="failed", error_code="translation_timeout", final_audio_seconds=None,
        mp3_bytes=None, audio_ms=None, attempts_expected=1, access="guest",
    )  # fmt: skip
    _translator(failed, None, outcome="timeout", http_status=None, error_code="translation_timeout")
    jobs.append(failed)

    partial = _job(
        4, outcome="failed", error_code="speech_timeout", final_audio_seconds=None, mp3_bytes=None,
        audio_ms=None, attempts_expected=3, target_language="spanish",
    )  # fmt: skip
    _translator(partial, 5_200)
    _speech(partial, 6_200)
    _attempt(
        partial, "speech", outcome="timeout", http_status=None, error_code="speech_timeout",
        sent_amount=6_000,
    )  # fmt: skip
    jobs.append(partial)

    interrupted = _job(5, finished_at=None, outcome=None, attempts_expected=None, mp3_bytes=None)
    interrupted.status = "failed"
    _translator(interrupted, 4_000)
    jobs.append(interrupted)

    mock = _job(
        6, translation_provider="mock-translation", speech_provider="mock-speech",
        audio_processor="mock-audio", final_audio_seconds=None, attempts_expected=2,
    )  # fmt: skip
    for service in ("translator", "speech"):
        _attempt(
            mock, service, provider_kind="mock", usage_basis="none", usage_method="mock-not-billed",
            sent_amount=4_200,
        )  # fmt: skip
    jobs.append(mock)

    lost = _job(7, attempts_expected=3, write_errors=1)  # one speech row could not be written
    _translator(lost, 3_100)
    _speech(lost, 4_000)
    lost.attempts[1].seq = 3  # seq 2 is the gap
    jobs.append(lost)

    for job in jobs:
        job.reasons = _reasons(job)
    return Report(
        filters=Filters(
            since=datetime(2026, 10, 1, tzinfo=UTC), until=datetime(2026, 11, 1, tzinfo=UTC)
        ),
        prices=prices or default_price_book(),
        jobs=jobs,
        jobs_without_usage=2,
        first_usage_at=T0,
        generated_at=datetime(2026, 11, 1, 12, 0, tzinfo=UTC),
    )
