#!/usr/bin/env bash
# Deployment smoke check of the public production site. Read-only GET requests only.
#
# What it proves: the site answers over HTTPS, the app is alive, the database is reachable and
# the app reports the expected production configuration (all components real).
# What it does NOT prove: which commit is running (that comes from the verified Render
# deployment, not from this script), that login works, or that a job completes with good audio.
# It never logs in, never sends an Access Code (right or wrong), never calls Azure and never
# creates a job, so it costs nothing and cannot use up the failed-login allowance.
#
# Required: BASE_URL, an https:// URL without a path (for example the PRODUCTION_URL variable).
# Optional: SMOKE_ATTEMPTS (6), SMOKE_RETRY_SECONDS (10), GITHUB_STEP_SUMMARY.
# TEST_ALLOW_INSECURE_BASE_URL=1 lets the fake-server tests use http://127.0.0.1.
set -euo pipefail

: "${BASE_URL:?BASE_URL is not set}"
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-6}"
SMOKE_RETRY_SECONDS="${SMOKE_RETRY_SECONDS:-10}"
BASE_URL="${BASE_URL%/}"

results=()
fail() {
  echo "::error::$1" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Production smoke check: FAILED"
      echo
      echo "$1"
      [ "${#results[@]}" -eq 0 ] || printf '%s\n' "" "Passed before the failure:" "${results[@]}"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

if [ "${TEST_ALLOW_INSECURE_BASE_URL:-}" = "1" ]; then
  [[ "$BASE_URL" =~ ^https?://[A-Za-z0-9.:-]+$ ]] || fail "BASE_URL must look like https://host"
  proto='=http,https'
else
  [[ "$BASE_URL" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail "BASE_URL must be an https:// URL with no path (got a different shape)"
  proto='=https'
fi
[[ "$SMOKE_ATTEMPTS" =~ ^[1-9][0-9]*$ && "$SMOKE_RETRY_SECONDS" =~ ^[0-9]+$ ]] || fail "SMOKE_ATTEMPTS / SMOKE_RETRY_SECONDS must be whole numbers"

# Plain GET, no cookies, no credentials. Retried a few times because a freshly started free
# instance can answer 502/503 for a moment; only reads are repeated.
BODY=""
get() { # get <path> -> sets BODY, returns non-zero on a non-200 answer after all attempts
  local path="$1" attempt=1 out code
  while :; do
    if out=$(curl -sS --max-time 30 --connect-timeout 15 --proto "$proto" --proto-redir "$proto" \
      --max-redirs 3 -L -w '\n%{http_code}' "$BASE_URL$path" 2>/dev/null); then
      code="${out##*$'\n'}"
      BODY="${out%$'\n'*}"
      [ "$code" = "200" ] && return 0
    else
      code="000"
    fi
    echo "  ${path}: HTTP ${code} (attempt ${attempt} of ${SMOKE_ATTEMPTS})" >&2
    [ "$attempt" -lt "$SMOKE_ATTEMPTS" ] || return 1
    attempt=$((attempt + 1))
    sleep "$SMOKE_RETRY_SECONDS"
  done
}
pass() { echo "ok: $1"; results+=("- $1"); }

echo "Smoke check of ${BASE_URL} (read-only, no login, no Azure)"

get "/" || fail "GET / did not return 200"
grep -q '<title>MyDubb</title>' <<< "$BODY" || fail "GET / returned 200 but not the MyDubb page"
pass "GET / returns the MyDubb page over HTTPS"

get "/api/health" || fail "GET /api/health did not return 200"
jq -e '.status == "ok"' <<< "$BODY" > /dev/null 2>&1 || fail "/api/health did not report status ok"
pass "GET /api/health: status ok"

get "/api/ready" || fail "GET /api/ready did not return 200"
jq -e '.status == "ready" and .checks.database == "ok"' <<< "$BODY" > /dev/null 2>&1 \
  || fail "/api/ready did not report ready with the database ok"
pass "GET /api/ready: ready, database ok"

get "/api/meta" || fail "GET /api/meta did not return 200"
jq -e '.providers.translation == "azure" and .providers.speech == "azure" and .providers.audio == "ffmpeg"
  and .mock_mode == false and .provider_mode == "azure"' <<< "$BODY" > /dev/null 2>&1 \
  || fail "/api/meta does not report the expected production configuration (translation=azure, speech=azure, audio=ffmpeg, mock_mode=false, provider_mode=azure); got: $(jq -c '{provider_mode, mock_mode, providers}' <<< "$BODY" 2>/dev/null || echo 'unparseable')"
pass "GET /api/meta: translation=azure, speech=azure, audio=ffmpeg, mock_mode=false, provider_mode=azure"

echo "Production smoke check passed."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Production smoke check: passed"
    echo
    printf '%s\n' "${results[@]}"
    echo
    echo "Deployment smoke check only: no login, no Azure call, no job. It does not replace the authenticated end-to-end check or listening to the audio, and it does not identify the running commit (the verified Render deployment does)."
  } >> "$GITHUB_STEP_SUMMARY"
fi
