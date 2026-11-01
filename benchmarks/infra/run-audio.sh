#!/usr/bin/env bash
# Audio pipeline benchmark (real JobPipeline + real FFmpeg, fake translation/speech; see
# audio_bench.py). One throwaway container per case, with optional CPU/RAM limits.
#
#   run-audio.sh PROFILE WORKLOAD MODE CONCURRENCY [REPEATS=4]
#     PROFILE   unlimited | cpu0.5-mem512m | cpu0.1-mem512m   (docker --cpus/--memory; a
#               simulation of an instance size, NOT Render itself)
#     WORKLOAD  short | guest_limit | long      MODE plain | timed
# or  run-audio.sh matrix   to run the standard matrix (see docs/INFRA_BENCHMARK.md).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "$RESULTS_DIR"

limits_for() {
  case "$1" in
    unlimited) echo "" ;;
    cpu0.5-mem512m) echo "--cpus=0.5 --memory=512m --memory-swap=512m" ;;
    cpu0.1-mem512m) echo "--cpus=0.1 --memory=512m --memory-swap=512m" ;;
    *) echo "unknown profile $1" >&2; exit 2 ;;
  esac
}

run_case() {  # profile workload mode concurrency repeats
  local profile=$1 workload=$2 mode=$3 conc=$4 reps=${5:-4}
  local name="mydubb-infra-bench-case-$profile-$workload-$mode-c$conc"
  local file="audio-$profile-$workload-$mode-c$conc.jsonl"
  local out="$RESULTS_DIR/$file"
  # docker.exe needs the Windows form of the path (path conversion is off, see common.sh)
  local out_host; out_host="$(cd "$RESULTS_DIR" && (pwd -W 2>/dev/null || pwd))/$file"
  rm -f "$out"; docker rm -f "$name" >/dev/null 2>&1 || true
  echo "== $profile $workload $mode c=$conc x$reps"
  # shellcheck disable=SC2046
  docker run --name "$name" --network "$NET" $(limits_for "$profile") \
    -e APP_ENV=development -e DATABASE_URL="$DB_URL" -e ACCESS_CODE=bench-access-code \
    -e PROVIDER_MODE=mock -e COOKIE_SECURE=false \
    -v "$BENCH_MOUNT:/bench:ro" -v "$BACKEND_MOUNT:/backend_src:ro" \
    --entrypoint python "$IMG" -I -u /bench/audio_bench.py \
    --workload "$workload" --mode "$mode" --concurrency "$conc" --repeats "$reps" \
    --out /tmp/out.jsonl || true
  local oom; oom="$(docker inspect -f '{{.State.OOMKilled}} exit={{.State.ExitCode}}' "$name")"
  if ! docker cp "$name:/tmp/out.jsonl" "$out_host" 2>/dev/null; then
    echo '{"type":"no_output"}' > "$out"; docker logs "$name" 2>&1 | tail -5
  fi
  echo "{\"type\":\"container\",\"profile\":\"$profile\",\"state\":\"$oom\"}" >> "$out"
  docker rm -f "$name" >/dev/null
  echo "   -> $oom"
}

if [ -z "${BENCH_CHILD:-}" ]; then
  trap cleanup_all EXIT
  build_image; cleanup_all; start_db; migrate
fi
# In matrix mode every case runs in a child shell (BENCH_CHILD=1): the database stays up.
case_child() { BENCH_CHILD=1 bash "${BASH_SOURCE[0]}" "$@" </dev/null; }

if [ "${1:-}" = matrix ]; then
  for profile in unlimited cpu0.5-mem512m; do
    for workload in short guest_limit long; do
      for mode in plain timed; do
        for conc in 1 2; do case_child "$profile" "$workload" "$mode" "$conc" "$([ "$profile" = unlimited ] && echo 4 || echo 3)"; done
      done
    done
  done
  # 0.1 CPU is the documented Render Free size: fewer repeats, concurrency 1, no "long" workload
  # (a single run would take many minutes at that size; see docs/INFRA_BENCHMARK.md).
  for workload in short guest_limit; do
    for mode in plain timed; do case_child cpu0.1-mem512m "$workload" "$mode" 1 2; done
  done
else
  run_case "$@"
fi
