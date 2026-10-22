#!/usr/bin/env bash
# Run the browser E2E suite against an isolated, throwaway Docker stack.
#
#   e2e/run-e2e.sh                         all tests (desktop + mobile Chromium)
#   e2e/run-e2e.sh --project=mobile        Playwright arguments are passed through
#   E2E_KEEP_STACK=1 e2e/run-e2e.sh        leave the stack running for debugging
#
# Destructive scope: only the "mydubb-e2e" Compose project (its containers and its
# tmpfs database) is created and removed. The development database is not touched.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d node_modules/@playwright/test ]; then
  echo "Error: run 'npm ci' and 'npx playwright install chromium' in e2e/ first." >&2
  exit 1
fi

if [ -z "${E2E_ACCESS_CODE:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    E2E_ACCESS_CODE="e2e-$(openssl rand -hex 12)"
  else
    E2E_ACCESS_CODE="e2e-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  fi
fi
export E2E_ACCESS_CODE
export E2E_PORT="${E2E_PORT:-8001}"
export E2E_BASE_URL="http://127.0.0.1:${E2E_PORT}"

compose() { docker compose -f docker-compose.e2e.yml "$@"; }

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  if [ "${E2E_KEEP_STACK:-0}" = "1" ]; then
    echo "E2E stack left running at ${E2E_BASE_URL} (remove: docker compose -f e2e/docker-compose.e2e.yml down -v)"
  else
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Building the application image..."
compose build --quiet app
echo "Starting isolated E2E stack on ${E2E_BASE_URL}..."
if ! compose up -d --wait; then
  echo "Error: the E2E stack did not become healthy. Recent app logs:" >&2
  compose logs --tail 60 app >&2 || true
  exit 1
fi

status=0
npx playwright test "$@" || status=$?
if [ "$status" -ne 0 ]; then
  echo "E2E tests failed. Recent app logs:" >&2
  compose logs --tail 60 app >&2 || true
fi
exit "$status"
