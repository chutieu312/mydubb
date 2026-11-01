#!/usr/bin/env bash
# Audio pipeline benchmark (real JobPipeline + real FFmpeg, fake translation/speech; see
# audio_bench.py). One throwaway container per case, with optional CPU/RAM limits.
#
#   run-audio.sh PROFILE WORKLOAD MODE CONCURRENCY [REPEATS=4]
#     PROFILE   unlimited | cpu0.5-mem512m | cpu0.1-mem512m   (docker --cpus/--memory; a
#               simulation of an instance size, NOT Render itself)
#     WORKLOAD  short | guest_limit | long      MODE plain | timed
# or  run-audio.sh matrix   to run the standard matrix (see docs/INFRA_BENCHMARK.md).
#
# Exit status: 0 only if every case produced every expected run/job/output and passed every check
# (check_case.py). A case fails when the container exits nonzero, is OOM-killed, times out
# (BENCH_CASE_TIMEOUT), leaves no output, or the output is incomplete or invalid. The matrix
# continues after a failed case to collect diagnostics and exits nonzero at the end.
# BENCH_HARNESS (default /bench/audio_bench.py) and BENCH_HARNESS_EXTRA (more harness arguments,
# e.g. "--max-temp-mb 5 --run-timeout 20") exist for tests.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

HARNESS="${BENCH_HARNESS:-/bench/audio_bench.py}"
CASE_TIMEOUT="${BENCH_CASE_TIMEOUT:-4500}"
PY="$(command -v python3 || command -v python || true)"

limits_for() {
  case "$1" in
    unlimited) echo "" ;;
    cpu0.5-mem512m) echo "--cpus=0.5 --memory=512m --memory-swap=512m" ;;
    cpu0.1-mem512m) echo "--cpus=0.1 --memory=512m --memory-swap=512m" ;;
    *) echo "unknown profile $1" >&2; return 2 ;;
  esac
}

run_case() {  # profile workload mode concurrency repeats ; returns nonzero if the case failed
  local profile=$1 workload=$2 mode=$3 conc=$4 reps=${5:-4}
  local limits; limits="$(limits_for "$profile")" || return 2
  local name="$PREFIX-case-$profile-$workload-$mode-c$conc"
  local file="audio-$profile-$workload-$mode-c$conc.jsonl"
  local out="$RESULTS_DIR/$file"
  # docker.exe needs the Windows form of the path (path conversion is off, see common.sh)
  local out_host; out_host="$(cd "$RESULTS_DIR" && (pwd -W 2>/dev/null || pwd))/$file"
  if [ -e "$out" ]; then echo "ERROR: $out already exists; refusing to overwrite" >&2; return 1; fi
  echo "== $profile $workload $mode c=$conc x$reps"
  local rc=0
  # shellcheck disable=SC2086
  timeout "$CASE_TIMEOUT" docker run --name "$name" --label "$LABEL" --network "$NET" $limits \
    -e APP_ENV=development -e DATABASE_URL="$DB_URL" -e ACCESS_CODE=bench-access-code \
    -e PROVIDER_MODE=mock -e COOKIE_SECURE=false -e FAKE_MODE \
    -v "$BENCH_MOUNT:/bench:ro" -v "$BACKEND_MOUNT:/backend_src:ro" \
    --entrypoint python "$IMG" -I -u "$HARNESS" \
    --workload "$workload" --mode "$mode" --concurrency "$conc" --repeats "$reps" \
    --out /tmp/out.jsonl ${BENCH_HARNESS_EXTRA:-} </dev/null || rc=$?
  # What Docker says about the container: its own exit code and whether the kernel OOM-killed it.
  local inspected exit_code oom
  inspected="$(docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' "$name" 2>/dev/null || echo '-1 unknown')"
  exit_code="${inspected% *}"; oom="${inspected#* }"
  local cp_ok=true
  docker cp "$name:/tmp/out.jsonl" "$out_host" >/dev/null 2>&1 || cp_ok=false
  [ -f "$out" ] || : > "$out"
  printf '{"type":"container","profile":"%s","exit_code":%s,"oom_killed":%s,"docker_run_rc":%s,"output_copied":%s}\n' \
    "$profile" "$exit_code" "$([ "$oom" = true ] && echo true || echo false)" "$rc" "$cp_ok" >> "$out"
  local ok=true
  if [ "$rc" -ne 0 ] || [ "$exit_code" != 0 ] || [ "$oom" != false ] || [ "$cp_ok" != true ]; then ok=false; fi
  "$PY" -I "$BENCH_MOUNT/check_case.py" "$out_host" "$reps" "$conc" || ok=false
  if [ "$ok" != true ]; then
    echo "   -> FAILED (docker run rc=$rc, container exit=$exit_code, oom=$oom, output copied=$cp_ok)" >&2
    show_diag "$name"
  else
    echo "   -> ok"
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$ok" = true ]
}

matrix_cases() {  # profile workload mode concurrency repeats, one case per line
  local profile workload mode conc reps
  for profile in unlimited cpu0.5-mem512m; do
    for workload in short guest_limit long; do
      for mode in plain timed; do
        for conc in 1 2; do
          reps=3; [ "$profile" = unlimited ] && reps=4
          echo "$profile $workload $mode $conc $reps"
        done
      done
    done
  done
  # 0.1 CPU is the documented Render Free size: fewer repeats, concurrency 1, no "long" workload
  # (a single run would take many minutes at that size; see docs/INFRA_BENCHMARK.md).
  for workload in short guest_limit; do
    for mode in plain timed; do echo "cpu0.1-mem512m $workload $mode 1 2"; done
  done
}

case_child() {  # one matrix case in a child shell (BENCH_CHILD=1): the database stays up
  BENCH_CHILD=1 bash "${BASH_SOURCE[0]}" "$@" </dev/null
}

main() {
  if [ -z "$PY" ]; then echo "ERROR: python3 or python is needed on the host (result checks)" >&2; return 1; fi
  if [ -z "${BENCH_CHILD:-}" ]; then
    claim_run || return 1
    trap cleanup_all EXIT
    claim_results_dir || return 1
    build_image || return 1
    start_db || return 1
    migrate || return 1
  else
    mkdir -p "$RESULTS_DIR"
  fi
  if [ "${1:-}" = matrix ]; then
    local failed=() profile workload mode conc reps
    while read -r profile workload mode conc reps; do
      case_child "$profile" "$workload" "$mode" "$conc" "$reps"         || failed+=("$profile/$workload/$mode/c$conc")
    done < <(matrix_cases)
    if [ "${#failed[@]}" -gt 0 ]; then
      echo "MATRIX FAILED: ${#failed[@]} case(s): ${failed[*]}" >&2
      return 1
    fi
    echo "matrix: all cases ok"
  else
    run_case "$@"
  fi
}

# Run only when executed (tests source this file to call functions).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
