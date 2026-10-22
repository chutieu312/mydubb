#!/bin/sh
# Check a container running the production configuration (APP_ENV=production with the
# explicit mock opt-in): readiness, security headers, disabled API docs, mock banner flag
# and a Secure/HttpOnly/SameSite=Strict session cookie. Works over plain HTTP.
# Usage: BASE_URL=http://127.0.0.1:8081 ACCESS_CODE=... docker/production-config-check.sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
: "${ACCESS_CODE:?ACCESS_CODE must be set}"

fail() { echo "FAIL: $1" >&2; exit 1; }

i=0
until curl -fsS "$BASE_URL/api/ready" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 45 ] && fail "service did not become ready"
  sleep 2
done

headers=$(curl -fsS -D - -o /dev/null "$BASE_URL/api/health") || fail "health check failed"
echo "$headers" | grep -qi '^strict-transport-security: max-age=' || fail "HSTS header missing"
curl -fsS "$BASE_URL/api/meta" | grep -q '"mock_mode":true' || fail "mock_mode not reported"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/docs")
[ "$status" = "404" ] || fail "API docs exposed (HTTP $status)"

cookie=$(curl -fsS -D - -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d "{\"access_code\":\"$ACCESS_CODE\"}" "$BASE_URL/api/session" | grep -i '^set-cookie:') \
  || fail "login did not set a session cookie"
for attribute in secure httponly 'samesite=strict'; do
  echo "$cookie" | grep -qi "$attribute" || fail "session cookie lacks $attribute"
done

echo "production configuration OK: HSTS, docs disabled, mock flagged, secure session cookie"
