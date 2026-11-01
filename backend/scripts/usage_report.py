"""Read-only usage and reference-cost report (local tool, no API, no provider call).

Run from `backend/`. The database comes from `DATABASE_URL` in the environment or the git-ignored
`backend/.env`, never from the command line, and is never printed. The whole run is one
`REPEATABLE READ, READ ONLY` transaction (one consistent snapshot): it cannot create a job,
change a row or call Azure, Cognito or Supadata.

    uv run python -m scripts.usage_report --since 2026-10-01 --until 2026-11-01
    uv run python -m scripts.usage_report --since 2026-10-01 --language japanese --csv jobs.csv
    uv run python -m scripts.usage_report --job <job-id> --attempts-csv attempts.csv
    uv run python -m scripts.usage_report --synthetic        # made-up data, no database

Filters: `--since` (inclusive) and `--until` (exclusive) are ISO dates or datetimes; no zone means
UTC; the filter is on the moment the job started (`job_usage.started_at`). `--job` may repeat.
`--language` is one of the API language values (e.g. `vietnamese`, `mandarin_simplified`).
`--csv` writes one row per job, `--attempts-csv` one per provider request; neither holds
transcripts, translations, SSML, keys, addresses or user identifiers. `--prices` reads another
price file (same format as `app/usage/data/reference_prices.json`).

The text summary separates usage recorded (actual / estimated / unknown), reference cost at
paid-tier list prices, and the invoice (not verified). See docs/USAGE_COSTS.md.
"""

import argparse
import sys
import uuid
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.languages import TargetLanguage
from app.usage.pricing import default_price_book, load_price_book
from app.usage.report import (
    Filters,
    Report,
    build_report,
    parse_instant,
    render_summary,
    write_attempt_csv,
    write_job_csv,
)
from app.usage.synthetic import synthetic_report
from scripts.glossary_candidates import CommandError, database_url

LANGUAGES = [language.value for language in TargetLanguage]


def _filters(args: argparse.Namespace) -> Filters:
    try:
        since = parse_instant(args.since) if args.since else None
        until = parse_instant(args.until) if args.until else None
        jobs = tuple(dict.fromkeys(uuid.UUID(j) for j in args.job))
    except ValueError:
        raise CommandError("--since/--until must be ISO dates and --job a job id") from None
    if since and until and since >= until:
        raise CommandError("--since must be earlier than --until")
    return Filters(since=since, until=until, job_ids=jobs, language=args.language)


def run(argv: Sequence[str], factory: sessionmaker[Session] | None, out=None) -> int:
    out = out or sys.stdout
    args = _parser().parse_args(argv)
    prices = load_price_book(Path(args.prices)) if args.prices else default_price_book()
    if args.synthetic:
        report: Report = synthetic_report(prices)
    else:
        if factory is None:
            raise CommandError("no database")
        filters = _filters(args)
        with factory() as db:
            try:
                report = build_report(db, filters, prices)
            finally:
                db.rollback()
    if args.csv:
        with Path(args.csv).open("w", encoding="utf-8", newline="") as handle:
            write_job_csv(report, handle)
    if args.attempts_csv:
        with Path(args.attempts_csv).open("w", encoding="utf-8", newline="") as handle:
            write_attempt_csv(report, handle)
    if not args.quiet:
        out.write(render_summary(report))
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--since", help="inclusive start (ISO date/datetime, UTC if no zone)")
    parser.add_argument("--until", help="exclusive end (ISO date/datetime, UTC if no zone)")
    parser.add_argument("--job", action="append", default=[], help="job id (repeatable)")
    parser.add_argument("--language", choices=LANGUAGES, help="target language of the job")
    parser.add_argument("--csv", help="write one row per job to this file")
    parser.add_argument("--attempts-csv", help="write one row per provider request to this file")
    parser.add_argument("--prices", help="another reference price file")
    parser.add_argument("--quiet", action="store_true", help="no text summary (CSV only)")
    parser.add_argument("--synthetic", action="store_true", help="made-up data; no database")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    args = sys.argv[1:] if argv is None else argv
    try:
        if "--synthetic" in args:
            return run(args, None)
        engine = create_engine(database_url(), connect_args={"connect_timeout": 10})
        try:
            return run(args, sessionmaker(bind=engine))
        finally:
            engine.dispose()
    except CommandError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"error: {type(exc).__name__}", file=sys.stderr)
        return 1
    except SQLAlchemyError as exc:
        # The driver's message can include the host, user or SQL parameters: type only.
        print(f"error: database operation failed ({type(exc).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
