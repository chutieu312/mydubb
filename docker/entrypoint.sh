#!/bin/sh
# Container entrypoint: apply migrations, then start the single application process.
set -eu

if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  # Safe because exactly one instance runs (see docs/ARCHITECTURE.md).
  alembic upgrade head
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
