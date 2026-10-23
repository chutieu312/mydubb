#!/bin/sh
# Container smoke test: health, readiness, SPA, and one mock job end to end.
# Usage: BASE_URL=http://127.0.0.1:8000 ACCESS_CODE=... docker/smoke-test.sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
: "${ACCESS_CODE:?ACCESS_CODE must be set}"
PY="${PYTHON:-python3}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

json() { "$PY" -c "import sys, json; print(json.load(sys.stdin)$1)"; }

# Catch paste problems before spending a login attempt (e.g. Ctrl+V in Git Bash inserts a
# control character instead of pasting). The value itself is never printed.
if printf '%s' "$ACCESS_CODE" | LC_ALL=C grep -q '[[:cntrl:][:space:]]'; then
  echo "ACCESS_CODE contains whitespace or control characters (paste problem?); not sent" >&2
  exit 1
fi

echo "Waiting for readiness..."
i=0
until curl -fsS "$BASE_URL/api/ready" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 45 ]; then echo "Service did not become ready" >&2; exit 1; fi
  sleep 2
done

curl -fsS "$BASE_URL/api/health" | grep -q '"ok"'
curl -fsS "$BASE_URL/api/ready" | grep -q '"ready"'
curl -fsS "$BASE_URL/" | grep -q '<div id="root">'
echo "health, readiness and frontend OK"

# A wrong code counts against the brute-force limit (5 failures per client per 15 min).
# Skip this check against production with SMOKE_SKIP_WRONG_CODE_CHECK=1.
if [ "${SMOKE_SKIP_WRONG_CODE_CHECK:-0}" != "1" ]; then
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{"access_code":"definitely-wrong"}' "$BASE_URL/api/session")
  [ "$status" = "401" ] || { echo "wrong Access Code returned $status" >&2; exit 1; }
fi

# Error responses carry only a code and message, never the submitted Access Code.
login_body="$(mktemp)"
# Build the JSON with Python so any character in the code is encoded correctly.
login_payload=$("$PY" -c 'import json, os; print(json.dumps({"access_code": os.environ["ACCESS_CODE"]}))')
status=$(printf '%s' "$login_payload" | curl -s -o "$login_body" -w '%{http_code}' -c "$JAR" \
  -X POST -H 'Content-Type: application/json' --data-binary @- "$BASE_URL/api/session")
if [ "$status" != "200" ]; then
  echo "login failed: HTTP $status $(cat "$login_body")" >&2
  rm -f "$login_body"
  exit 1
fi
csrf=$(json '["csrf_token"]' < "$login_body")
rm -f "$login_body"

job_id=$(curl -fsS -b "$JAR" -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  -d '{"transcript":"Smoke test transcript.","first_sentence_start":"00:00:10","last_sentence_start":"00:06:10","voice":"AndrewMultilingual"}' \
  "$BASE_URL/api/jobs" | json '["id"]')

i=0
while :; do
  job_status=$(curl -fsS -b "$JAR" "$BASE_URL/api/jobs/$job_id" | json '["status"]')
  [ "$job_status" = "completed" ] && break
  [ "$job_status" = "failed" ] && { echo "job failed" >&2; exit 1; }
  i=$((i + 1))
  [ "$i" -ge 60 ] && { echo "job did not finish" >&2; exit 1; }
  sleep 1
done

curl -fsS -b "$JAR" "$BASE_URL/api/jobs/$job_id/result" | grep -q '"is_illustrative":true'
curl -fsS -b "$JAR" -o /dev/null "$BASE_URL/api/jobs/$job_id/result/audio"
echo "mock job $job_id completed; result and audio retrievable"
