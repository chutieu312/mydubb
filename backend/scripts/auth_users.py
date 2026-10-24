"""MyDubb-side administration of Cognito users (local tool, no API).

Cognito owns accounts and passwords (invite, reset, disable them in the AWS console). MyDubb
keeps its own sessions, which Cognito cannot end: disabling a user in Cognito stops new sign-ins
but leaves existing MyDubb sessions valid until they expire. This tool closes that gap.

Run from `backend/`. The database comes from `DATABASE_URL` in the environment or the
git-ignored `backend/.env`; it is never taken from the command line and never printed (see
docs/AUTHENTICATION.md, "Disabling a user").

    uv run python -m scripts.auth_users list [--limit N]
    uv run python -m scripts.auth_users disable USER       # blocks MyDubb access, ends sessions
    uv run python -m scripts.auth_users enable USER
    uv run python -m scripts.auth_users revoke-sessions USER

USER is the MyDubb user id (from `list`) or the email address; an email shared by several
accounts must be given as an id.
"""

import argparse
import sys
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User, UserSession
from app.auth.service import normalize_email, revoke_user_sessions
from app.db import session_scope
from scripts.glossary_candidates import CommandError, database_url


def find_user(db: Session, ref: str) -> User:
    try:
        user = db.get(User, uuid.UUID(ref))
    except ValueError:
        matches = list(
            db.scalars(select(User).where(User.email_normalized == normalize_email(ref)))
        )
        if len(matches) > 1:
            raise CommandError("several users have this email; use the id from `list`") from None
        user = matches[0] if matches else None
    if user is None:
        raise CommandError("no such user")
    return user


def _row(db: Session, user: User) -> str:
    now = datetime.now(UTC)
    active = db.scalar(
        select(func.count())
        .select_from(UserSession)
        .where(
            UserSession.user_id == user.id,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > now,
        )
    )
    state = "DISABLED" if user.disabled_at else "active"
    last = f"{user.last_login_at:%Y-%m-%d %H:%M}" if user.last_login_at else "never"
    return f"{user.id}  {state:<8} sessions={active:<3} last_login={last}  {user.email}"


def run(argv: Sequence[str], factory: sessionmaker[Session], out=sys.stdout) -> int:
    args = _parser().parse_args(argv)
    with session_scope(factory) as db:
        if args.command == "list":
            users = db.scalars(select(User).order_by(User.created_at.desc()).limit(args.limit))
            for user in users:
                print(_row(db, user), file=out)
            return 0
        user = find_user(db, args.user)
        now = datetime.now(UTC)
        if args.command == "disable":
            user.disabled_at, user.updated_at = now, now
            revoked = revoke_user_sessions(db, [user.id])
            print(f"disabled; {revoked} session(s) revoked: {_row(db, user)}", file=out)
        elif args.command == "enable":
            user.disabled_at, user.updated_at = None, now
            print(f"enabled: {_row(db, user)}", file=out)
        elif args.command == "revoke-sessions":
            revoked = revoke_user_sessions(db, [user.id])
            print(f"{revoked} session(s) revoked: {_row(db, user)}", file=out)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="users, newest first")
    listing.add_argument("--limit", type=int, default=100)
    for name, help_text in (
        ("disable", "block MyDubb access and revoke the user's sessions"),
        ("enable", "allow MyDubb access again (Cognito must allow sign-in too)"),
        ("revoke-sessions", "sign the user out everywhere"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("user", help="user id or email")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    try:
        engine = create_engine(database_url(), connect_args={"connect_timeout": 10})
        try:
            return run(sys.argv[1:] if argv is None else argv, sessionmaker(bind=engine))
        finally:
            engine.dispose()
    except CommandError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except SQLAlchemyError as exc:
        # The driver's message can include the host, user or SQL parameters: type only.
        print(f"error: database operation failed ({type(exc).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
