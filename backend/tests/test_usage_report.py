"""The usage report and CLI: filters, duplicates, missing data, money, read-only, privacy.

Rows are written with the same store functions the pipeline uses, from synthetic values.
"""

import csv
import io
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import InternalError, ProgrammingError
from sqlalchemy.orm import sessionmaker

from app.db import session_scope
from app.usage import store
from app.usage.pricing import default_price_book, load_price_book
from app.usage.report import (
    Filters,
    build_report,
    parse_instant,
    render_summary,
    write_attempt_csv,
    write_job_csv,
)
from app.usage.synthetic import synthetic_report
from scripts import usage_report as cli
from tests.test_job_liveness import new_job

T = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)


def summary_values(started: datetime, **overrides) -> dict:
    values = dict(
        started_at=started,
        finished_at=started + timedelta(minutes=1),
        client="web",
        access="invitation",
        target_language="vietnamese",
        voice="AndrewMultilingual",
        speed_percent=100,
        timing_mode="plain",
        translation_provider="azure-translator",
        speech_provider="azure-speech",
        audio_processor="ffmpeg-audio",
        baseline_seconds=60,
        target_audio_seconds=Decimal("60.000"),
        final_audio_seconds=Decimal("60.000"),
        source_chars=1000,
        outcome="completed",
        attempts_expected=2,
        write_errors=0,
        method_version=1,
    )
    values.update(overrides)
    return values


def attempt_values(seq: int, service: str, amount: int | None, started: datetime, **extra) -> dict:
    actual = service == "translator"
    values = dict(
        seq=seq,
        service=service,
        provider_kind="azure",
        operation="translate" if actual else "synthesize",
        outcome="ok" if amount is not None else "timeout",
        http_status=200 if amount is not None else None,
        error_code=None,
        items=1,
        started_at=started,
        elapsed_ms=500,
        sent_amount=(amount or 100) + 10,
        sent_unit="characters",
        usage_amount=amount,
        usage_unit="characters",
        usage_basis=("actual" if actual else "estimated") if amount is not None else "unknown",
        usage_method="m",
    )
    values.update(extra)
    return values


def add_job(
    engine: Engine,
    started: datetime = T,
    translator: int | None = 1000,
    speech: int | None = 2000,
    job_id: uuid.UUID | None = None,
    **overrides,
) -> uuid.UUID:
    job_id = job_id or uuid.uuid4()
    factory = sessionmaker(bind=engine)
    with session_scope(factory) as db:
        store.upsert_summary(db, job_id, summary_values(started, **overrides))
        rows = [
            {"job_id": job_id, **attempt_values(1, "translator", translator, started)},
            {"job_id": job_id, **attempt_values(2, "speech", speech, started)},
        ]
        store.insert_attempts(db, rows)
    return job_id


def report(engine: Engine, **filters):
    with sessionmaker(bind=engine)() as db:
        return build_report(db, Filters(**filters))


# --- filters --------------------------------------------------------------------------------------


def test_the_period_is_half_open_in_utc(db_engine):
    inside = add_job(db_engine, T)
    edge = add_job(db_engine, T + timedelta(days=1))
    before = add_job(db_engine, T - timedelta(seconds=1))
    found = report(db_engine, since=T, until=T + timedelta(days=1))
    assert {j.usage.job_id for j in found.jobs} == {inside}
    # `until` is exclusive and `since` inclusive: the edge job belongs to the next period only.
    nxt = report(db_engine, since=T + timedelta(days=1))
    assert {j.usage.job_id for j in nxt.jobs} == {edge}
    assert before not in {j.usage.job_id for j in found.jobs}


def test_filter_by_job_and_language(db_engine):
    vi = add_job(db_engine)
    ja = add_job(db_engine, target_language="japanese")
    assert [j.usage.job_id for j in report(db_engine, language="japanese").jobs] == [ja]
    assert [j.usage.job_id for j in report(db_engine, job_ids=(vi,)).jobs] == [vi]
    assert report(db_engine, job_ids=(uuid.uuid4(),)).jobs == []


def test_dates_without_a_zone_are_utc_and_offsets_are_converted():
    assert parse_instant("2026-10-01") == datetime(2026, 10, 1, tzinfo=UTC)
    assert parse_instant("2026-10-01T08:30") == datetime(2026, 10, 1, 8, 30, tzinfo=UTC)
    assert parse_instant("2026-10-01T08:30:00Z") == datetime(2026, 10, 1, 8, 30, tzinfo=UTC)
    assert parse_instant("2026-10-01T08:30:00+07:00") == datetime(2026, 10, 1, 1, 30, tzinfo=UTC)


# --- totals, unknown and incomplete ---------------------------------------------------------------


def test_totals_keep_actual_estimated_and_unknown_apart(db_engine):
    add_job(db_engine, translator=1000, speech=2000)
    # The speech request of the second job timed out (a later start keeps the order fixed).
    add_job(db_engine, T + timedelta(seconds=1), translator=500, speech=None)
    r = report(db_engine)
    t = r.totals()
    assert t.characters("translator", "actual") == 1500
    assert t.characters("speech", "estimated") == 2000
    assert t.unknown_requests["speech"] == 1 and t.unknown_requests["translator"] == 0
    assert t.unknown_sent["speech"] == 110  # reported as a size sent, separately
    assert [j.complete for j in r.jobs] == [True, False]
    assert r.jobs[1].reasons == ["usage_unknown"]
    text_report = render_summary(r)
    assert "requests with UNKNOWN usage: 1" in text_report
    assert "a lower bound" in text_report and "NOT included" in text_report
    assert "not verified" in text_report and "Supadata" in text_report


def test_a_job_that_never_ended_and_missing_attempts_are_incomplete(db_engine):
    crashed = add_job(db_engine, finished_at=None, outcome=None, attempts_expected=None)
    lost = add_job(db_engine, attempts_expected=3, write_errors=1)  # a third row never arrived
    gap = add_job(db_engine, attempts_expected=2)
    factory = sessionmaker(bind=db_engine)
    with session_scope(factory) as db:  # seq 2 removed: a hole in the numbering
        db.execute(
            text("UPDATE job_usage_attempts SET seq = 3 WHERE job_id = :id AND seq = 2"),
            {"id": gap},
        )
    by_id = {j.usage.job_id: j for j in report(db_engine).jobs}
    assert by_id[crashed].reasons == ["no_ending_recorded"]
    assert by_id[lost].reasons == ["attempts_missing", "write_errors"]
    assert by_id[gap].reasons == ["attempts_missing"]


def test_a_completed_real_job_without_any_attempt_of_a_service_is_incomplete(db_engine):
    job_id = uuid.uuid4()
    with session_scope(sessionmaker(bind=db_engine)) as db:
        store.upsert_summary(db, job_id, summary_values(T, attempts_expected=0))
    assert report(db_engine).jobs[0].reasons == ["no_translator_attempt", "no_speech_attempt"]


def test_jobs_without_a_usage_record_are_counted(db_engine, make_client):
    client = make_client(usage_recording_enabled=True)
    services = client.app.state.services
    old = new_job(services)  # a job row with no usage row, like one made before recording
    add_job(db_engine, started=datetime.now(UTC))
    r = report(db_engine)
    assert r.jobs_without_usage == 1 and old.job_id
    assert "WITHOUT any usage record: 1" in render_summary(r)


def test_mock_attempts_are_counted_apart_and_never_become_cost(db_engine):
    job_id = uuid.uuid4()
    with session_scope(sessionmaker(bind=db_engine)) as db:
        store.upsert_summary(
            db,
            job_id,
            summary_values(
                T, translation_provider="mock-translation", speech_provider="mock-speech"
            ),
        )
        store.insert_attempts(
            db,
            [
                {
                    "job_id": job_id,
                    **attempt_values(
                        n,
                        service,
                        None,
                        T,
                        provider_kind="mock",
                        usage_basis="none",
                        outcome="ok",
                        sent_amount=900,
                        usage_method="mock-not-billed",
                    ),
                }
                for n, service in ((1, "translator"), (2, "speech"))
            ],
        )
    r = report(db_engine)
    t = r.totals()
    assert t.mock_requests["translator"] == 1 and t.requests["translator"] == 0
    assert t.cost("translator", r.prices) == 0 and t.cost("speech", r.prices) == 0
    assert r.jobs[0].providers == "mock" and r.jobs[0].complete
    assert "jobs with mock providers: 1" in render_summary(r)


# --- duplicates -----------------------------------------------------------------------------------


def test_writing_the_same_attempt_twice_counts_it_once(db_engine):
    job_id = add_job(db_engine, translator=1000, speech=2000)
    with session_scope(sessionmaker(bind=db_engine)) as db:
        store.insert_attempts(
            db, [{"job_id": job_id, **attempt_values(1, "translator", 1000, T)}]
        )  # a repeated write, even with a different figure
        store.insert_attempts(db, [{"job_id": job_id, **attempt_values(1, "translator", 9999, T)}])
        store.upsert_summary(db, job_id, summary_values(T + timedelta(days=9)))
    r = report(db_engine)
    assert r.totals().characters("translator", "actual") == 1000
    (job,) = r.jobs
    assert len(job.attempts) == 2
    assert job.usage.started_at == T  # the start of a job is never overwritten


# --- money ----------------------------------------------------------------------------------------


def test_cost_is_exact_decimal_and_the_display_rounds_half_up(db_engine):
    add_job(db_engine, translator=333_333, speech=5)  # 333,333 x $10/1M, 5 x $15/1M
    r = report(db_engine)
    t = r.totals()
    assert t.cost("translator", r.prices) == Decimal("3.33333")
    assert t.cost("speech", r.prices) == Decimal("0.000075")
    out = io.StringIO()
    write_job_csv(r, out)
    row = next(csv.DictReader(io.StringIO(out.getvalue())))
    assert row["ref_cost_translator"] == "3.33333" and row["ref_cost_speech"] == "0.000075"
    assert row["ref_cost_known"] == "3.333405"  # exact sum, no float noise
    text_report = render_summary(r)
    assert "= 3.3333" in text_report  # 4 decimals in the text
    assert "= 0.0001" in text_report  # 0.000075 rounds half up, not to even/down


def test_a_price_applies_from_its_effective_date(db_engine, tmp_path):
    book = default_price_book()
    assert book.price_for("translator", date(2025, 4, 30)) is None
    assert book.price_for("translator", date(2025, 5, 1)).price == Decimal("10.00")
    early = add_job(db_engine, started=datetime(2025, 4, 30, 10, tzinfo=UTC))
    r = report(db_engine)
    assert r.totals().unpriced("translator") == 1000
    assert r.jobs[0].usage.job_id == early
    assert "no reference price" in render_summary(r)


def test_the_price_file_is_complete_and_sourced():
    book = default_price_book()
    assert book.currency == "USD"
    assert {p.service for p in book.prices} == {"translator", "speech"}
    for price in book.prices:
        assert price.sku and price.region and price.meter
        assert price.source.startswith("https://") and price.checked_on and price.effective_from
        assert price.price > 0
    assert all(a.source.startswith("https://") for a in book.allowances)


def test_a_price_file_with_a_bad_unit_is_refused(tmp_path):
    path = tmp_path / "prices.json"
    path.write_text(
        '{"schema":1,"currency":"USD","prices":[{"service":"speech","sku":"S1","meter":"m",'
        '"region":"r","unit":"1K characters","price":"1","effective_from":"2026-01-01",'
        '"checked_on":"2026-01-01","source":"https://x"}]}'
    )
    with pytest.raises(ValueError):
        load_price_book(path)


# --- CLI and CSV ----------------------------------------------------------------------------------


def run_cli(engine: Engine, *args: str) -> str:
    out = io.StringIO()
    assert cli.run(list(args), sessionmaker(bind=engine), out) == 0
    return out.getvalue()


def test_the_cli_writes_a_summary_and_both_csv_files(db_engine, tmp_path):
    job_id = add_job(db_engine)
    jobs_csv, attempts_csv = tmp_path / "jobs.csv", tmp_path / "attempts.csv"
    out = run_cli(
        db_engine,
        "--since",
        "2026-10-01",
        "--until",
        "2026-11-01",
        "--language",
        "vietnamese",
        "--csv",
        str(jobs_csv),
        "--attempts-csv",
        str(attempts_csv),
    )
    assert "Jobs with a usage record: 1" in out and "Reference cost" in out
    jobs = list(csv.DictReader(jobs_csv.open(encoding="utf-8")))
    assert [j["job_id"] for j in jobs] == [str(job_id)]
    assert jobs[0]["translator_chars_actual"] == "1000" and jobs[0]["complete"] == "yes"
    assert len(list(csv.DictReader(attempts_csv.open(encoding="utf-8")))) == 2


def test_the_cli_changes_nothing_and_cannot_write(db_engine, tmp_path):
    add_job(db_engine)
    with db_engine.connect() as conn:
        before = conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one()
    run_cli(db_engine, "--quiet", "--csv", str(tmp_path / "x.csv"))
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one() == before
    # The mechanism the CLI uses: a write after SET TRANSACTION READ ONLY is refused by Postgres.
    with sessionmaker(bind=db_engine)() as db:
        db.execute(text("SET TRANSACTION READ ONLY"))
        with pytest.raises((InternalError, ProgrammingError)):
            db.execute(text("DELETE FROM job_usage"))
        db.rollback()
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one() == before


def test_the_cli_rejects_a_reversed_period_and_a_bad_job_id(db_engine):
    factory = sessionmaker(bind=db_engine)
    for args in (
        ["--since", "2026-11-01", "--until", "2026-10-01"],
        ["--job", "not-a-uuid"],
        ["--since", "yesterday"],
    ):
        with pytest.raises(cli.CommandError):
            cli.run(args, factory, io.StringIO())


def test_synthetic_mode_needs_no_database_and_shows_every_case():
    buffer = io.StringIO()
    assert cli.run(["--synthetic"], None, buffer) == 0
    out = buffer.getvalue()
    for expected in (
        "no_ending_recorded",
        "attempts_missing",
        "write_errors",
        "usage_unknown",
        "jobs with mock providers: 1",
        "japanese",
    ):
        assert expected in out


def test_csv_files_hold_only_numbers_labels_and_ids():
    r = synthetic_report()
    jobs, attempts = io.StringIO(), io.StringIO()
    write_job_csv(r, jobs)
    write_attempt_csv(r, attempts)
    header = next(csv.reader(io.StringIO(jobs.getvalue())))
    header += next(csv.reader(io.StringIO(attempts.getvalue())))
    for forbidden in ("transcript", "text", "ssml", "email", "user", "ip", "token", "key", "url"):
        assert not any(
            forbidden == column or column.startswith(forbidden + "_") for column in header
        )
    rows = list(csv.DictReader(io.StringIO(jobs.getvalue())))
    assert len(rows) == 7
    assert {row["complete"] for row in rows} == {"yes", "no"}
