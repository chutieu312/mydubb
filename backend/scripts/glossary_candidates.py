"""Batch review of glossary candidates (local administration tool, no API).

Run from `backend/`. The database comes from `DATABASE_URL` in the environment or the
git-ignored `backend/.env`; it is never taken from the command line and never printed. For
production, type the Neon connection string into the shell without echo (see
docs/DEPLOYMENT.md, "Glossary candidates") instead of passing it as an argument.

    uv run python -m scripts.glossary_candidates list [--status pending|approved|...|all]
    uv run python -m scripts.glossary_candidates approve ID --term TERM --case insensitive|exact
    uv run python -m scripts.glossary_candidates reject ID [--note TEXT]
    uv run python -m scripts.glossary_candidates reopen ID
    uv run python -m scripts.glossary_candidates export [--output FILE]
    uv run python -m scripts.glossary_candidates promote --ref origin/main [--dry-run]

`export` prints glossary lines for the approved candidates (with conflict checks) for a pull
request against `app/translation/data/glossary.txt`; it changes nothing in the database.
`promote` marks approved candidates promoted only when their line is in the glossary file of a
commit that is already merged into `origin/main` (run `git fetch` first). Nothing here edits the
glossary, pushes, opens a pull request or merges.
"""

import argparse
import os
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

from dotenv import dotenv_values
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.config import to_sqlalchemy_url
from app.db import session_scope
from app.glossary_candidates.models import CandidateStatus, CasePolicy, GlossaryCandidate
from app.glossary_candidates.store import (
    ReviewError,
    approve,
    build_export,
    list_candidates,
    promote,
    reject,
    reopen,
)
from app.translation.glossary import DEFAULT_GLOSSARY_PATH

BACKEND_DIR = Path(__file__).resolve().parent.parent
GLOSSARY_IN_REPO = "backend/app/translation/data/glossary.txt"
MAIN_REF = "origin/main"


class CommandError(Exception):
    """A failure to report in one line, without secrets or raw database messages."""


def database_url() -> str:
    url = os.environ.get("DATABASE_URL") or dotenv_values(BACKEND_DIR / ".env").get("DATABASE_URL")
    if not url:
        raise CommandError("DATABASE_URL is not set (environment or backend/.env)")
    return to_sqlalchemy_url(url)


def git(*args: str) -> str:
    try:
        result = subprocess.run(  # noqa: S603 (fixed program, argument list, no shell)
            ["git", *args],  # noqa: S607
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CommandError("git is not available") from None
    if result.returncode != 0:
        raise CommandError(f"git {args[0]} failed")
    return result.stdout


def merged_glossary(ref: str, run_git: Callable[..., str] | None = None) -> tuple[str, str]:
    """(commit SHA, glossary text) of `ref`, which must be merged into origin/main."""
    run_git = run_git or git
    sha = run_git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").strip()
    if len(sha) != 40:
        raise CommandError(f"{ref} is not a commit (run git fetch first)")
    try:
        run_git("merge-base", "--is-ancestor", sha, MAIN_REF)
    except CommandError:
        raise CommandError(
            f"{sha[:12]} is not merged into {MAIN_REF}: promote only from merged commits "
            "(git fetch, then use origin/main or a commit on it)"
        ) from None
    return sha, run_git("show", f"{sha}:{GLOSSARY_IN_REPO}")


def _row(candidate: GlossaryCandidate) -> str:
    spellings = ", ".join(s for s in candidate.spellings if s != candidate.display_term)
    review = ""
    if candidate.canonical_term:
        review = f"  -> {candidate.canonical_term!r} ({candidate.case_policy})"
    if candidate.promoted_commit:
        review += f" in {candidate.promoted_commit[:12]}"
    return (
        f"#{candidate.id:<5} {candidate.job_count:>5} jobs  {candidate.status:<9} "
        f"{candidate.kind:<12} {candidate.last_seen_at:%Y-%m-%d}  {candidate.display_term!r}"
        + (f" (also: {spellings})" if spellings else "")
        + review
    )


def run(argv: Sequence[str], factory: sessionmaker[Session], out=sys.stdout) -> int:
    args = _parser().parse_args(argv)
    with session_scope(factory) as db:
        if args.command == "list":
            status = None if args.status == "all" else CandidateStatus(args.status)
            rows = list_candidates(db, status, args.limit)
            print(f"{len(rows)} candidate(s), most jobs first:", file=out)
            for candidate in rows:
                print(_row(candidate), file=out)
        elif args.command == "approve":
            candidate = approve(
                db,
                args.id,
                canonical_term=args.term,
                case_policy=CasePolicy(args.case),
                reviewed_by=args.by,
                note=args.note,
            )
            print(f"approved (not in the glossary yet): {_row(candidate)}", file=out)
        elif args.command == "reject":
            candidate = reject(db, args.id, reviewed_by=args.by, note=args.note)
            print(f"rejected: {_row(candidate)}", file=out)
        elif args.command == "reopen":
            print(f"reopened: {_row(reopen(db, args.id))}", file=out)
        elif args.command == "export":
            return _export(db, args, out)
        elif args.command == "promote":
            sha, glossary_text = merged_glossary(args.ref)
            promoted = promote(db, glossary_text, sha)
            for candidate in promoted:
                verb = "would promote" if args.dry_run else "promoted"
                print(f"{verb}: {_row(candidate)}", file=out)
            print(
                f"{len(promoted)} candidate(s) found in the glossary of {sha[:12]}"
                + (" (dry run, nothing saved)" if args.dry_run else ""),
                file=out,
            )
            if args.dry_run:
                db.rollback()
    return 0


def _export(db: Session, args: argparse.Namespace, out) -> int:
    approved = list_candidates(db, CandidateStatus.APPROVED, limit=10_000)
    glossary_text = Path(args.glossary).read_text(encoding="utf-8")
    export = build_export(approved, glossary_text)
    for warning in export.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    for error in export.errors:
        print(f"error: {error}", file=sys.stderr)
    if export.errors:
        print("nothing exported; resolve the errors first", file=sys.stderr)
        return 1
    lines = [
        "# Approved glossary candidates (scripts/glossary_candidates.py export).",
        "# Review each line, add it to app/translation/data/glossary.txt in its section, and",
        "# open ONE pull request. After it is merged: git fetch && ... promote --ref origin/main",
    ]
    for candidate, line in export.lines:
        lines.append(f"# #{candidate.id}: {candidate.job_count} job(s), {candidate.kind}")
        lines.append(line)
    text = "\n".join(lines) + "\n"
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"wrote {len(export.lines)} line(s) to {args.output}", file=out)
    else:
        out.write(text)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    listing = commands.add_parser("list", help="candidates, most jobs and most recent first")
    listing.add_argument(
        "--status", choices=[s.value for s in CandidateStatus] + ["all"], default="pending"
    )
    listing.add_argument("--limit", type=int, default=100)

    approving = commands.add_parser("approve", help="pending -> approved")
    approving.add_argument("id", type=int)
    approving.add_argument("--term", required=True, help="canonical spelling for the glossary")
    approving.add_argument("--case", required=True, choices=[p.value for p in CasePolicy])
    approving.add_argument("--by", help="reviewer name to record")
    approving.add_argument("--note")

    rejecting = commands.add_parser("reject", help="pending or approved -> rejected")
    rejecting.add_argument("id", type=int)
    rejecting.add_argument("--by")
    rejecting.add_argument("--note")

    reopening = commands.add_parser("reopen", help="rejected or approved -> pending")
    reopening.add_argument("id", type=int)

    exporting = commands.add_parser("export", help="glossary lines for approved candidates")
    exporting.add_argument("--output", help="file to write (default: standard output)")
    exporting.add_argument("--glossary", default=str(DEFAULT_GLOSSARY_PATH))

    promoting = commands.add_parser("promote", help="approved -> promoted, from a merged commit")
    promoting.add_argument("--ref", default=MAIN_REF)
    promoting.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    try:
        engine = create_engine(database_url(), connect_args={"connect_timeout": 10})
        try:
            return run(sys.argv[1:] if argv is None else argv, sessionmaker(bind=engine))
        finally:
            engine.dispose()
    except (CommandError, ReviewError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except SQLAlchemyError as exc:
        # The driver's message can include the host, user or SQL parameters: type only.
        print(f"error: database operation failed ({type(exc).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
