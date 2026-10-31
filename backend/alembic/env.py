import os
from logging.config import fileConfig

from alembic import context
from dotenv import dotenv_values
from sqlalchemy import create_engine, pool

from app.access.models import AccessSession  # noqa: F401  (register models)
from app.auth.models import (  # noqa: F401
    AuthChallenge,
    ExtensionAuthCode,
    PasswordResetAttempt,
    PasswordResetEvent,
    User,
    UserSession,
)
from app.config import to_sqlalchemy_url
from app.db import Base
from app.glossary_candidates.models import GlossaryCandidate  # noqa: F401
from app.guest.models import GuestImportQuota, GuestJobQuota, GuestSession  # noqa: F401
from app.jobs.models import Job  # noqa: F401

target_metadata = Base.metadata

# Log migration progress when run from the CLI (e.g. container start). Programmatic callers
# such as the test suite pass the URL as an attribute and keep their own logging setup.
if context.config.config_file_name and "database_url" not in context.config.attributes:
    fileConfig(context.config.config_file_name, disable_existing_loggers=False)


def _database_url() -> str:
    url = (
        context.config.attributes.get("database_url")
        or os.environ.get("DATABASE_URL")
        # Same local .env file the application reads in development.
        or dotenv_values(".env").get("DATABASE_URL")
    )
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return to_sqlalchemy_url(url)


def run_migrations_offline() -> None:
    context.configure(url=_database_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
