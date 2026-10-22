#!/usr/bin/env bash
# Start MyDubb end to end (PostgreSQL + application container) with Docker Compose.
#
#   ./run-app.sh            build (if needed) and start; prints the URL when ready
#   ./stop-app.sh           stop it again
#
# The Access Code comes from $ACCESS_CODE or ACCESS_CODE in the root .env file. If neither
# exists, a random code is generated and saved to .env (git-ignored); it is not printed.
set -euo pipefail

cd "$(dirname "$0")"

APP_URL="http://127.0.0.1:8000"
READY_TIMEOUT_SECONDS=120

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not on PATH." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Error: the Docker daemon is not running. Start Docker Desktop and try again." >&2
  exit 1
fi

# Docker Compose reads ACCESS_CODE from the shell or from ./.env.
if [ -z "${ACCESS_CODE:-}" ] && ! grep -qE '^ACCESS_CODE=.{8,}' .env 2>/dev/null; then
  if command -v openssl >/dev/null 2>&1; then
    code="$(openssl rand -hex 16)"
  else
    code="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  [ -s .env ] && [ -n "$(tail -c1 .env)" ] && echo >> .env
  echo "ACCESS_CODE=${code}" >> .env
  echo "Generated a new Access Code and saved it to .env (ACCESS_CODE=...)."
fi

echo "Building and starting PostgreSQL and the application..."
docker compose up -d --build

echo "Waiting for the application to become ready (up to ${READY_TIMEOUT_SECONDS}s)..."
elapsed=0
until curl -fsS "${APP_URL}/api/ready" >/dev/null 2>&1; do
  if [ "$(docker compose ps -q app | xargs -r docker inspect -f '{{.State.Running}}' 2>/dev/null)" != "true" ]; then
    echo "Error: the application container stopped. Recent logs:" >&2
    docker compose logs --tail 40 app >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$READY_TIMEOUT_SECONDS" ]; then
    echo "Error: the application did not become ready in time. Recent logs:" >&2
    docker compose logs --tail 40 app >&2
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo
echo "MyDubb is running (development mock mode): ${APP_URL}"
echo "Log in with the Access Code from your ACCESS_CODE variable or the .env file."
echo "Logs: docker compose logs -f app    Stop: ./stop-app.sh"
