#!/bin/sh
# Check a container started with TRANSLATION_PROVIDER=azure (fake key; Azure is never called):
# the image contains the glossary and HTTP client, startup succeeds, and /api/meta labels each
# component. Does not create jobs, so no request leaves the machine.
# Usage: BASE_URL=http://127.0.0.1:8082 docker/azure-mode-check.sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
fail() { echo "FAIL: $1" >&2; exit 1; }

i=0
until curl -fsS "$BASE_URL/api/ready" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 45 ] && fail "service did not become ready"
  sleep 2
done

meta=$(curl -fsS "$BASE_URL/api/meta") || fail "meta request failed"
echo "$meta" | grep -q '"providers":{"translation":"azure","speech":"mock","audio":"mock"}' \
  || fail "providers not reported per component"
echo "$meta" | grep -q '"mock_mode":true' || fail "mock_mode (speech/audio) not reported"

echo "azure translation mode OK: translation=azure, speech=mock, audio=mock"
