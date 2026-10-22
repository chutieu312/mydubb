#!/bin/sh
# Container entrypoint: apply migrations, then start the single application process.
set -eu

if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  # Migrations are expand-only, so the previous instance can keep serving while they run
  # during a deploy (see docs/ARCHITECTURE.md). Any failure stops the container.
  if ! alembic upgrade head; then
    echo "ERROR: database migration failed; the application was not started." >&2
    echo "If the error is \"Can't locate revision\", the database schema is newer than this" >&2
    echo "image (e.g. a rollback to a commit before the latest migration). The database" >&2
    echo "was not changed. See docs/DEPLOYMENT.md, section \"Rolling back\"." >&2
    exit 1
  fi
fi

# One worker process: job execution state is in-process (single-instance design).
# FORWARDED_ALLOW_IPS must list the trusted reverse proxy (e.g. "*" behind Render's proxy)
# so client IPs used for Access Code brute-force protection are correct.
exec uvicorn app.main:create_app --factory \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --workers 1 \
  --proxy-headers \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" \
  --no-server-header
