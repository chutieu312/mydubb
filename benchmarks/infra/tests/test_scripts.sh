#!/usr/bin/env bash
# Regression tests for the shell side of the benchmark: startup deadlines, container exit early,
# credential masking, run isolation, and exit codes of run-audio.sh. Needs Docker and the postgres
# image used by the scripts; uses a fake harness (tests/fake_harness.py), so no benchmark runs.
# Every wait is bounded. Usage: BENCH_IMAGE=<app image> bash tests/test_scripts.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
export BENCH_IMAGE="${BENCH_IMAGE:-mydubb-infra-bench:cb71cd2}"
docker image inspect "$BENCH_IMAGE" >/dev/null 2>&1 || { echo "need image $BENCH_IMAGE"; exit 2; }
SUFFIX="t$$"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check() { if [ "$1" = 0 ]; then ok "$2"; else bad "$2"; fi; }
BASE="$(mktemp -d)"
cleanup() {
  local ids; ids="$(docker ps -aq --filter "label=mydubb-infra-bench-run" --filter "label=mydubb-infra-bench-test=$SUFFIX" 2>/dev/null)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  for n in $(docker network ls -q --filter "label=mydubb-infra-bench-test=$SUFFIX" 2>/dev/null); do docker network rm "$n" >/dev/null 2>&1; done
  rm -rf "$BASE" 2>/dev/null
}
trap cleanup EXIT
newdir() { mktemp -d "$BASE/d.XXXXXX"; }
# containers/networks made directly by this test carry the test label as well as a run label
carrier() {  # carrier NAME RUN_ID [entrypoint args...]: a postgres-image container running a command
  local name=$1 run=$2; shift 2
  docker run -d --name "$name" --label "mydubb-infra-bench-run=$run" --label "mydubb-infra-bench-test=$SUFFIX" \
    --entrypoint "$1" postgres:17-alpine "${@:2}" >/dev/null
}

echo "== startup deadlines"
(
  export BENCH_RUN_ID="s1-$SUFFIX"; source "$INFRA/common.sh"; set +e
  carrier "$PREFIX-sleeper" "$RUN_ID" sleep 300
  start=$SECONDS
  out="$(wait_ready "$PREFIX-sleeper" 3 "demo service" false 2>&1)"; rc=$?
  elapsed=$((SECONDS-start))
  [ $rc -ne 0 ] && [ $elapsed -le 10 ] && echo "$out" | grep -q "not ready after 3s"
) ; check $? "container that never becomes ready: nonzero within the deadline"
(
  export BENCH_RUN_ID="s2-$SUFFIX"; source "$INFRA/common.sh"; set +e
  docker run -d --name "$PREFIX-dies" --label "mydubb-infra-bench-run=$RUN_ID" --label "mydubb-infra-bench-test=$SUFFIX" \
    --entrypoint sh postgres:17-alpine -c 'echo "boot failed postgresql://user:s3cretpw@host/db password=hunter2" >&2; exit 3' >/dev/null
  start=$SECONDS
  out="$(wait_ready "$PREFIX-dies" 60 "demo service" true 2>&1)"; rc=$?
  elapsed=$((SECONDS-start))
  [ $rc -ne 0 ] && [ $elapsed -le 15 ] && echo "$out" | grep -q "stopped before it was ready" \
    && echo "$out" | grep -q "postgresql://\*\*\*" && ! echo "$out" | grep -q -e s3cretpw -e hunter2
) ; check $? "container that exits early: detected at once, diagnostics shown, credentials masked"
(
  # run-idle.sh with an "app" image that exits at once: must fail fast and leave nothing behind
  export BENCH_RUN_ID="s3-$SUFFIX" BENCH_IMAGE=postgres:17-alpine BENCH_APP_TIMEOUT=20 RESULTS_DIR="$(newdir)/r"
  start=$SECONDS
  timeout 120 bash "$INFRA/run-idle.sh" 5 >/dev/null 2>&1; rc=$?
  left="$(docker ps -aq --filter "label=mydubb-infra-bench-run=$BENCH_RUN_ID")"
  [ $rc -ne 0 ] && [ $((SECONDS-start)) -le 90 ] && [ -z "$left" ]
) ; check $? "run-idle.sh: early-exit app fails fast and cleans up its own resources"

echo "== run isolation"
(
  export BENCH_RUN_ID="iso-a-$SUFFIX"; source "$INFRA/common.sh"; set +e
  other="mydubb-infra-bench-iso-b-$SUFFIX-keep"
  carrier "$other" "iso-b-$SUFFIX" sleep 120
  carrier "$PREFIX-mine" "$RUN_ID" sleep 120
  cleanup_all
  mine="$(docker ps -aq --filter "name=$PREFIX-mine")"
  theirs="$(docker ps -q --filter "name=$other")"
  [ -z "$mine" ] && [ -n "$theirs" ]
) ; check $? "cleanup removes only the containers of its own run id"
(
  export BENCH_RUN_ID="iso-c-$SUFFIX"; source "$INFRA/common.sh"; set +e
  carrier "$PREFIX-live" "$RUN_ID" sleep 120
  claim_run 2>/dev/null; rc1=$?
  export BENCH_RUN_ID="iso-d-$SUFFIX"; source "$INFRA/common.sh"; set +e
  claim_run 2>/dev/null; rc2=$?
  [ $rc1 -ne 0 ] && [ $rc2 -eq 0 ]
) ; check $? "a second start with a run id in use is refused; a free id is accepted"
(
  export BENCH_RUN_ID="iso-e-$SUFFIX"; d="$(newdir)"; export RESULTS_DIR="$d"; source "$INFRA/common.sh"; set +e
  claim_results_dir 2>/dev/null; rc1=$?
  echo x > "$d/audio-existing.jsonl"
  claim_results_dir 2>/dev/null; rc2=$?
  [ $rc1 -eq 0 ] && [ $rc2 -ne 0 ]
) ; check $? "a non-empty results directory is refused (no overwrite)"

echo "== run-audio.sh exit codes (fake harness, no benchmark)"
(
  export BENCH_RUN_ID="rc-$SUFFIX" BENCH_HARNESS=/bench/tests/fake_harness.py
  source "$INFRA/run-audio.sh"; set +e
  docker network create --label "$LABEL" --label "mydubb-infra-bench-test=$SUFFIX" "$NET" >/dev/null
  trap cleanup_all EXIT
  results=0
  expect() {  # expect MODE WANT(0|nonzero) DESCRIPTION
    export FAKE_MODE=$1; export RESULTS_DIR; RESULTS_DIR="$(newdir)"
    run_case unlimited short plain 1 2 >/dev/null 2>&1; local rc=$?
    if { [ "$2" = 0 ] && [ $rc -eq 0 ]; } || { [ "$2" != 0 ] && [ $rc -ne 0 ]; }; then ok "$3"; else bad "$3 (rc=$rc)"; results=1; fi
  }
  expect ok 0 "valid case returns 0"
  expect crash nz "harness crash (exit 1, no output) is a failure"
  expect noout nz "exit 0 with no output file is a failure"
  expect jobfail nz "failed job is a failure"
  expect jobfail0 nz "failed job reported as ok by a faulty harness is still a failure"
  expect samples_none nz "missing sample counts (None == None) are a failure"
  expect samples_off nz "wrong sample count is a failure"
  expect short_runs nz "fewer runs than requested is a failure"
  expect stuck nz "timeout of a stuck workload is a failure"
  exit $results
) ; rc=$?; [ $rc -eq 0 ] || FAIL=$((FAIL+1))

echo "== matrix and exit status through the EXIT trap"
(
  export BENCH_RUN_ID="mx-$SUFFIX" BENCH_HARNESS=/bench/tests/fake_harness.py RESULTS_DIR="$(newdir)/m"
  export FAKE_MODE=crash_c2 BENCH_DB_TIMEOUT=60
  # two cases: c1 ok, c2 fails; the matrix must run both, then exit nonzero
  cat > "$RESULTS_DIR.sh" <<EOS
source "$INFRA/run-audio.sh"
matrix_cases() { echo "unlimited short plain 1 2"; echo "unlimited short plain 2 2"; }
main matrix
EOS
  timeout 300 bash "$RESULTS_DIR.sh" >"$RESULTS_DIR.out" 2>&1; rc=$?
  [ $rc -ne 0 ] && grep -q "MATRIX FAILED: 1 case" "$RESULTS_DIR.out" \
    && [ -s "$RESULTS_DIR/audio-unlimited-short-plain-c1.jsonl" ] \
    && [ -z "$(docker ps -aq --filter "label=mydubb-infra-bench-run=$BENCH_RUN_ID")" ]
) ; check $? "matrix runs every case, exits nonzero when one fails, cleans up"

echo
echo "passed(checks outside subshell blocks)=$PASS failed blocks/checks=$FAIL"
[ "$FAIL" -eq 0 ]
