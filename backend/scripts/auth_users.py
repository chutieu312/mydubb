"""MyDubb-side administration of Cognito users (local tool, no API).

Cognito owns accounts and passwords (invite, reset, disable them in the AWS console). MyDubb
keeps its own sessions, which Cognito cannot end: disabling a user in Cognito stops new sign-ins
but leaves existing MyDubb sessions valid until they expire. This tool closes that gap.

Run from `backend/`. The database comes from `DATABASE_URL` in the environment or the
git-ignored `backend/.env`; it is never taken from the command line and never printed (see
docs/AUTHENTICATION.md, "Disabling a user").

    uv run python -m scripts.auth_users list [--limit N] [--role admin|user]
    uv run python -m scripts.auth_users disable USER          # blocks access, signs out everywhere
    uv run python -m scripts.auth_users enable USER           # new sign-ins only
    uv run python -m scripts.auth_users revoke-sessions USER  # signs out everywhere
    uv run python -m scripts.auth_users lookup EMAIL          # every account with this email
    uv run python -m scripts.auth_users role USER_ID          # role and its recorded changes
    uv run python -m scripts.auth_users grant-admin USER_ID --confirm-email EMAIL
    uv run python -m scripts.auth_users revoke-admin USER_ID

`revoke-sessions` and `disable` end the user's sessions *and* every sign-in or pending sign-in
step (new password, email verification) that started before the command ran (database clock):
such a sign-in cannot create a session afterwards, even if it already passed Cognito. Sign-ins
that start after the command work normally (unless the user is disabled). `enable` only allows
new sign-ins again; it never revives a session or a sign-in that started before the revocation.
Other users are not affected.

USER is the MyDubb user id (from `list`) or the email address; an email shared by several
accounts must be given as an id.

MyDubb's admin role (docs/AUTHENTICATION.md, "Administrators") is not an AWS or Cognito role. Role
changes take exactly one USER_ID, never an email, and apply from that user's next request; sessions
are not touched. `grant-admin` also needs the account's current email (see `lookup`), as a check
that the id is the intended one. Each change is recorded in `user_role_events`.
"""

import argparse
import getpass
import sys
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.models import User, UserRole, UserRoleEvent, UserSession
from app.auth.service import (
    RoleChangeRefused,
    enable_user,
    grant_admin,
    normalize_email,
    revoke_admin,
    revoke_user_access,
)
from app.db import session_scope
from scripts.glossary_candidates import CommandError, database_url

# Lines of role history printed by `role`.
_ROLE_HISTORY = 20


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
    return (
        f"{user.id}  {state:<8} role={user.role:<5} sessions={active:<3} "
        f"last_login={last}  {user.email}"
    )


def _user_id(ref: str) -> uuid.UUID:
    try:
        return uuid.UUID(ref)
    except ValueError:
        raise CommandError("USER_ID must be a user id; find it with `lookup EMAIL`") from None


def _operator() -> str:
    """Who ran the tool, as this machine reports it: a trace, not an authenticated identity."""
    try:
        return f"auth_users:{getpass.getuser()}"
    except (OSError, KeyError, ImportError):
        return "auth_users:unknown"


def _role_command(db: Session, args: argparse.Namespace, out) -> int:
    user_id = _user_id(args.user_id)
    verb = "role"
    try:
        if args.command == "grant-admin":
            changed = grant_admin(
                db, user_id, confirm_email=args.confirm_email, changed_by=_operator()
            )
            verb = "admin granted" if changed else "already an admin, nothing changed"
        elif args.command == "revoke-admin":
            changed = revoke_admin(db, user_id, changed_by=_operator())
            verb = "admin revoked" if changed else "not an admin, nothing changed"
    except RoleChangeRefused as exc:
        raise CommandError(str(exc)) from None
    user = db.get(User, user_id, populate_existing=True)
    if user is None:
        raise CommandError("no such user")
    print(f"{verb}: {_row(db, user)}", file=out)
    if args.command == "role":
        events = db.scalars(
            select(UserRoleEvent)
            .where(UserRoleEvent.user_id == user_id)
            .order_by(UserRoleEvent.id.desc())
            .limit(_ROLE_HISTORY)
        )
        for event in events:
            print(
                f"  {event.changed_at.astimezone(UTC):%Y-%m-%d %H:%M} UTC  "
                f"{event.old_role} -> {event.new_role}  by {event.changed_by}",
                file=out,
            )
    return 0


def run(argv: Sequence[str], factory: sessionmaker[Session], out=sys.stdout) -> int:
    args = _parser().parse_args(argv)
    with session_scope(factory) as db:
        if args.command == "list":
            query = select(User).order_by(User.created_at.desc()).limit(args.limit)
            if args.role:
                query = query.where(User.role == args.role)
            for user in db.scalars(query):
                print(_row(db, user), file=out)
            return 0
        if args.command == "lookup":
            matches = list(
                db.scalars(
                    select(User)
                    .where(User.email_normalized == normalize_email(args.email))
                    .order_by(User.created_at.desc())
                )
            )
            if not matches:
                raise CommandError("no user has this email")
            for user in matches:
                print(_row(db, user), file=out)
            return 0
        if args.command in ("role", "grant-admin", "revoke-admin"):
            return _role_command(db, args, out)
        user_id = find_user(db, args.user).id
        if args.command == "disable":
            revoked = revoke_user_access(db, user_id, disable=True)
            verb = f"disabled; {revoked} session(s) revoked"
        elif args.command == "enable":
            enable_user(db, user_id)
            verb = "enabled"
        else:  # revoke-sessions
            revoked = revoke_user_access(db, user_id)
            verb = f"{revoked} session(s) revoked, earlier sign-ins cancelled"
        user = db.get(User, user_id, populate_existing=True)
        assert user is not None
        print(f"{verb}: {_row(db, user)}", file=out)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="users, newest first")
    listing.add_argument("--limit", type=int, default=100)
    listing.add_argument("--role", choices=[role.value for role in UserRole])
    for name, help_text in (
        ("disable", "block MyDubb access; end sessions and earlier sign-ins in progress"),
        ("enable", "allow new sign-ins again (Cognito must allow sign-in too)"),
        ("revoke-sessions", "end the user's sessions and earlier sign-ins in progress"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("user", help="user id or email")
    lookup = commands.add_parser("lookup", help="every account with this email")
    lookup.add_argument("email")
    role = commands.add_parser("role", help="one user's role and its recorded changes")
    role.add_argument("user_id", help="user id (not an email)")
    grant = commands.add_parser("grant-admin", help="make one user an administrator")
    grant.add_argument("user_id", help="user id (not an email)")
    grant.add_argument(
        "--confirm-email", required=True, help="the account's current email, checked against the id"
    )
    revoke = commands.add_parser("revoke-admin", help="make one user an ordinary user again")
    revoke.add_argument("user_id", help="user id (not an email)")
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
