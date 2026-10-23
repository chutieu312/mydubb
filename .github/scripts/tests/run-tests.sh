#!/usr/bin/env bash
# Tests of render-deploy.sh and production-smoke.sh against a fake Render/GitHub/MyDubb server
# on 127.0.0.1. No real credentials, no network, nothing is deployed.
# Needs: bash, curl, jq, python3. Run from anywhere: bash .github/scripts/tests/run-tests.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$here/.."
work="$(mktemp -d)"
trap 'kill "${server_pid:-0}" 2>/dev/null; rm -rf "$work"' EXIT

FAKE_KEY="rnd_FAKEKEYFORTESTS0123456789"
FAKE_TOKEN="ghs_FAKETOKENFORTESTS0123456789"
SHA="$(printf 'a%.0s' $(seq 40))"
port=18100
checks=0
failures=0

ok() { checks=$((checks + 1)); echo "  PASS $1"; }
bad() { checks=$((checks + 1)); failures=$((failures + 1)); echo "  FAIL $1"; }
expect() { # expect <description> <command...>
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

start_server() { # start_server <scenario>
  port=$((port + 1))
  : > "$work/log"
  "${PYTHON:-python3}" "$here/fake_api.py" "$port" "$1" "$work/log" &
  server_pid=$!
  local _
  for _ in $(seq 50); do
    curl -s -o /dev/null "http://127.0.0.1:$port/__up" && return 0
    sleep 0.1
  done
  echo "fake server did not start" >&2
  exit 2
}
stop_server() { kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; server_pid=0; }

deploy_run() { # deploy_run <scenario> [VAR=value...] -> sets rc, OUT, GH_OUT, SUMMARY
  local scenario="$1"
  shift
  start_server "$scenario"
  : > "$work/gh_out"
  : > "$work/summary"
  OUT="$(env -i PATH="$PATH" \
    RENDER_API_KEY="$FAKE_KEY" RENDER_SERVICE_ID=srv-testservice DEPLOY_SHA="$SHA" \
    GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN="$FAKE_TOKEN" \
    GITHUB_OUTPUT="$work/gh_out" GITHUB_STEP_SUMMARY="$work/summary" \
    RENDER_API_BASE="http://127.0.0.1:$port/v1" GITHUB_API_BASE="http://127.0.0.1:$port" \
    TEST_ALLOW_API_BASE_OVERRIDE=1 POLL_INTERVAL_SECONDS=0 LOOKUP_INTERVAL_SECONDS=0 \
    DEPLOY_TIMEOUT_SECONDS=300 "$@" bash "$scripts/render-deploy.sh" 2>&1)"
  rc=$?
  GH_OUT="$(cat "$work/gh_out")"
  SUMMARY="$(cat "$work/summary")"
  stop_server
}
posts() { grep -c '^POST ' "$work/log" || true; }
no_secret_leak() { ! grep -qF "$FAKE_KEY" <<< "$OUT$SUMMARY$GH_OUT" && ! grep -qF "$FAKE_TOKEN" <<< "$OUT$SUMMARY$GH_OUT"; }
only_get_or_deploy_post() { ! grep -E '^(DELETE|PUT|PATCH) ' "$work/log" && ! grep -E '^POST ' "$work/log" | grep -vq "/v1/services/srv-testservice/deploys auth=yes"; }
no_cancel_or_rollback() { ! grep -Eqi 'cancel|rollback|suspend|resume' "$work/log"; }

echo "== render-deploy.sh =="

echo "happy path: deploys the exact SHA and waits for the same deployment id"
deploy_run happy
expect "exits 0" test "$rc" -eq 0
expect "reports deployed=true and the deployment id" grep -q "deployed=true" <<< "$GH_OUT"
expect "outputs the deployment id" grep -q "deploy_id=dep-newdeploy" <<< "$GH_OUT"
expect "created exactly one deployment" test "$(posts)" -eq 1
expect "request body names the exact commit" grep -q "\"commitId\":\"$SHA\"" "$work/log"
expect "polled the new deployment, not 'latest'" grep -q "GET /v1/services/srv-testservice/deploys/dep-newdeploy" "$work/log"
expect "sent the Authorization header" grep -q "auth=yes" "$work/log"
expect "no secret in logs, outputs or summary" no_secret_leak
expect "only GETs and the one create POST were sent" only_get_or_deploy_post

echo "no live deployment yet: still deploys"
deploy_run no_live
expect "exits 0 and deploys" test "$rc" -eq 0 -a "$(posts)" -eq 1

echo "Render auto-deploy still on: refuses (would deploy twice)"
deploy_run autodeploy_on
expect "fails" test "$rc" -ne 0
expect "no deployment created" test "$(posts)" -eq 0
expect "says auto-deploy is enabled" grep -qi "auto-deploy is still enabled" <<< "$OUT"
deploy_run legacy_autodeploy_yes
expect "legacy autoDeploy=yes also refused" test "$rc" -ne 0 -a "$(posts)" -eq 0
deploy_run suspended
expect "suspended service refused" test "$rc" -ne 0 -a "$(posts)" -eq 0
deploy_run service_401
expect "bad API key / service id fails without deploying" test "$rc" -ne 0 -a "$(posts)" -eq 0

echo "stale run: a newer commit is already live"
deploy_run stale
expect "exits 0 (skipped, not a failure)" test "$rc" -eq 0
expect "no deployment created" test "$(posts)" -eq 0
expect "reports skipped=true, deployed=false" grep -q "deployed=false" <<< "$GH_OUT"
expect "explains the reason" grep -qi "stale" <<< "$OUT"

echo "same commit already live"
deploy_run same_live
expect "skipped without deploying" test "$rc" -eq 0 -a "$(posts)" -eq 0
expect "explains the reason" grep -qi "already live" <<< "$OUT"

echo "diverged history / cannot compare"
deploy_run diverged
expect "fails without deploying" test "$rc" -ne 0 -a "$(posts)" -eq 0
deploy_run compare_404
expect "unknown live commit fails without deploying" test "$rc" -ne 0 -a "$(posts)" -eq 0

echo "another deployment is running on Render"
deploy_run busy
expect "fails without deploying" test "$rc" -ne 0 -a "$(posts)" -eq 0
expect "names the running deployment" grep -q "dep-manual" <<< "$OUT"
expect "never cancels it" no_cancel_or_rollback

echo "deployment outcomes that must fail the job"
for s in build_failed update_failed canceled deactivated sha_mismatch live_no_commit; do
  deploy_run "$s"
  expect "$s: job fails" test "$rc" -ne 0
  # shellcheck disable=SC2016 # $1 is expanded by the inner bash on purpose
  expect "$s: not reported as deployed" bash -c '! grep -q "deployed=true" <<< "$1"' _ "$GH_OUT"
  expect "$s: created once, no cancel/rollback calls" test "$(posts)" -eq 1 -a -z "$(grep -Ei 'cancel|rollback' "$work/log")"
done
deploy_run sha_mismatch
expect "sha_mismatch: message says the commit differs" grep -qi "not ${SHA:0:7}" <<< "$OUT"

echo "timeout: finite, and the deployment is left alone"
deploy_run timeout DEPLOY_TIMEOUT_SECONDS=2 POLL_INTERVAL_SECONDS=1
expect "fails" test "$rc" -ne 0
expect "says it timed out and was not cancelled" grep -q "Timed out.*NOT cancelled" <<< "$OUT"
expect "no cancel/rollback calls" no_cancel_or_rollback

echo "polling survives short API failures but not endless ones"
deploy_run poll_500_then_ok
expect "recovers and succeeds" test "$rc" -eq 0
deploy_run poll_500_forever
expect "gives up with a clear error" test "$rc" -ne 0
expect "mentions the deployment may still be running" grep -qi "may still be running" <<< "$OUT"

echo "create request with an unknown outcome: never sent twice"
deploy_run post_500_created
expect "found the created deployment and succeeded" test "$rc" -eq 0 -a "$(posts)" -eq 1
deploy_run post_202
expect "202 without body: looked it up, one POST" test "$rc" -eq 0 -a "$(posts)" -eq 1
deploy_run post_drop_created
expect "connection dropped after creation: looked it up, one POST" test "$rc" -eq 0 -a "$(posts)" -eq 1
deploy_run post_500_none LOOKUP_ATTEMPTS=3
expect "nothing found: fails, one POST" test "$rc" -ne 0 -a "$(posts)" -eq 1
expect "says it is unknown and was not retried" grep -qi "Unknown whether.*not retried" <<< "$OUT"
deploy_run lookup_two
expect "two matching deployments: refuses to guess, fails" test "$rc" -ne 0 -a "$(posts)" -eq 1
deploy_run post_400
expect "HTTP 400 on create fails, one POST" test "$rc" -ne 0 -a "$(posts)" -eq 1
deploy_run post_409
expect "HTTP 409 on create fails, one POST" test "$rc" -ne 0 -a "$(posts)" -eq 1

echo "input validation"
deploy_run happy DEPLOY_SHA=main
expect "a branch name is not accepted as SHA" test "$rc" -ne 0 -a "$(posts)" -eq 0
deploy_run happy RENDER_SERVICE_ID=../x
expect "a malformed service id is rejected" test "$rc" -ne 0 -a "$(posts)" -eq 0
start_server happy
out="$(env -i PATH="$PATH" RENDER_API_KEY=k RENDER_SERVICE_ID=srv-testservice DEPLOY_SHA="$SHA" GITHUB_REPOSITORY=o/r GITHUB_TOKEN=t \
  RENDER_API_BASE="http://127.0.0.1:$port/v1" bash "$scripts/render-deploy.sh" 2>&1)"
rc=$?
stop_server
expect "API base override is refused without the test flag" test "$rc" -ne 0
expect "and no request reached the fake" test "$(grep -c '^GET /v1' "$work/log" || true)" -eq 0

echo
echo "== production-smoke.sh =="

smoke_run() { # smoke_run <scenario> [VAR=value...]
  local scenario="$1"
  shift
  start_server "$scenario"
  : > "$work/summary"
  OUT="$(env -i PATH="$PATH" BASE_URL="http://127.0.0.1:$port" TEST_ALLOW_INSECURE_BASE_URL=1 \
    SMOKE_RETRY_SECONDS=0 SMOKE_ATTEMPTS=3 GITHUB_STEP_SUMMARY="$work/summary" "$@" \
    bash "$scripts/production-smoke.sh" 2>&1)"
  rc=$?
  SUMMARY="$(cat "$work/summary")"
  stop_server
}

smoke_run smoke_ok
expect "healthy production passes" test "$rc" -eq 0
expect "summary says it is only a deployment smoke check" grep -qi "does not replace the authenticated" <<< "$SUMMARY"
# shellcheck disable=SC2016 # $1 is expanded by the inner bash on purpose
expect "only the four read-only GETs, no credentials sent" bash -c '
  ! grep -Ev "^(GET (/|/api/health|/api/ready|/api/meta|/__up) auth=no cookie=no)$" "$1" | grep -v "^$" | grep -q .' _ "$work/log"
for s in smoke_home_wrong smoke_home_500 smoke_health_bad smoke_ready_503 smoke_audio_mock smoke_mock_mode smoke_provider_mock; do
  smoke_run "$s"
  expect "$s fails the check" test "$rc" -ne 0
done
smoke_run smoke_audio_mock
expect "names the mismatch" grep -q "audio" <<< "$OUT"
smoke_run smoke_ready_flaky
expect "a brief 503 on /api/ready is retried and passes" test "$rc" -eq 0
env -i PATH="$PATH" BASE_URL="http://example.com" bash "$scripts/production-smoke.sh" > /dev/null 2>&1
expect "plain http BASE_URL is refused" test "$?" -ne 0
env -i PATH="$PATH" BASE_URL="https://example.com/some/path" bash "$scripts/production-smoke.sh" > /dev/null 2>&1
expect "BASE_URL with a path is refused" test "$?" -ne 0

echo
echo "$checks checks, $failures failed"
[ "$failures" -eq 0 ]
