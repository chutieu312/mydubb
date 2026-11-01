# Shared settings for the MyDubb infrastructure benchmark scripts. Source it; do not run it.
#
# Isolation: every run has a RUN_ID (BENCH_RUN_ID, or generated). All containers and the network of
# a run are named mydubb-infra-bench-<RUN_ID>-* and carry the label mydubb-infra-bench-run=<RUN_ID>;
# cleanup removes exactly the resources with that label, never another run's or another project's.
# Matrix children inherit BENCH_RUN_ID. A second start with a RUN_ID that is still in use is refused.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: do not rewrite /container/paths

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$BENCH_DIR/../.." && pwd)"
if pwd -W >/dev/null 2>&1; then  # Windows host path form for bind mounts and docker cp
  BENCH_MOUNT="$(cd "$BENCH_DIR" && pwd -W)"; BACKEND_MOUNT="$(cd "$REPO_DIR/backend" && pwd -W)"
else
  BENCH_MOUNT="$BENCH_DIR"; BACKEND_MOUNT="$REPO_DIR/backend"
fi
COMMIT="$(cd "$REPO_DIR" && git rev-parse --short=7 HEAD)"
IMG="${BENCH_IMAGE:-mydubb-infra-bench:$COMMIT}"

RUN_ID="${BENCH_RUN_ID:-$(date +%m%d%H%M%S)-$$}"
if ! [[ "$RUN_ID" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; then
  echo "ERROR: BENCH_RUN_ID must match [a-z0-9][a-z0-9-]{0,30}" >&2; exit 2
fi
export BENCH_RUN_ID="$RUN_ID"
LABEL="mydubb-infra-bench-run=$RUN_ID"
PREFIX="mydubb-infra-bench-$RUN_ID"
NET="$PREFIX-net"
DB="$PREFIX-db"
APP="$PREFIX-app"
DB_IMAGE=postgres:17-alpine
DB_URL="postgresql://bench:bench_local@$DB:5432/bench"
# Each default results directory is private to its run.
RESULTS_DIR="${RESULTS_DIR:-$BENCH_DIR/results/$COMMIT/run-$RUN_ID}"

# Finite deadlines (seconds) for every startup step.
BUILD_TIMEOUT="${BENCH_BUILD_TIMEOUT:-1800}"
DB_TIMEOUT="${BENCH_DB_TIMEOUT:-60}"
MIGRATE_TIMEOUT="${BENCH_MIGRATE_TIMEOUT:-120}"
APP_TIMEOUT="${BENCH_APP_TIMEOUT:-90}"

mask() {  # hide connection strings and credentials in text that is printed
  sed -E 's#(postgres(ql)?://)[^[:space:]]+#\1***#g; s#([A-Za-z_]*(password|passwd|secret|key|token|access_code)[A-Za-z_]*[=:] ?)[^[:space:]]+#\1***#gI'
}

show_diag() {  # last log lines of a container, masked
  echo "--- last log lines of $1 (credentials masked) ---" >&2
  docker logs --tail 15 "$1" 2>&1 | mask >&2 || true
}

# wait_ready CONTAINER TIMEOUT_SECONDS DESCRIPTION CHECK_COMMAND...
# Returns 0 when the check succeeds; 1 (with diagnostics) when the container is not running any
# more, or the deadline passes. Never waits without a limit.
wait_ready() {
  local name=$1 timeout=$2 what=$3; shift 3
  local end=$((SECONDS + timeout))
  while :; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" != true ]; then
      echo "ERROR: $what: the container stopped before it was ready" >&2
      show_diag "$name"; return 1
    fi
    if "$@" >/dev/null 2>&1; then return 0; fi
    if [ "$SECONDS" -ge "$end" ]; then
      echo "ERROR: $what: not ready after ${timeout}s" >&2
      show_diag "$name"; return 1
    fi
    sleep 1
  done
}

build_image() {
  docker image inspect "$IMG" >/dev/null 2>&1 && return 0
  timeout "$BUILD_TIMEOUT" docker build -t "$IMG" "$REPO_DIR" || {
    echo "ERROR: image build failed or took longer than ${BUILD_TIMEOUT}s" >&2; return 1; }
}

run_in_use() {  # does anything with this run's label exist?
  [ -n "$(docker ps -aq --filter "label=$LABEL" 2>/dev/null)" ]
}

claim_run() {  # refuse a RUN_ID that is still in use, before changing anything
  if run_in_use; then
    echo "ERROR: run id $RUN_ID is already in use (containers labelled $LABEL exist)." >&2
    echo "       Wait for that run, or choose another BENCH_RUN_ID." >&2
    return 1
  fi
}

claim_results_dir() {  # never write into a results directory that already has content
  mkdir -p "$RESULTS_DIR"
  if [ -n "$(ls -A "$RESULTS_DIR" 2>/dev/null)" ]; then
    echo "ERROR: results directory $RESULTS_DIR is not empty; choose another RESULTS_DIR." >&2
    return 1
  fi
}

start_db() {  # extra postgres -c options are passed as arguments
  docker network create --label "$LABEL" "$NET" >/dev/null || return 1
  docker run -d --name "$DB" --label "$LABEL" --network "$NET" \
    -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench_local -e POSTGRES_DB=bench \
    "$DB_IMAGE" postgres "$@" >/dev/null || return 1
  # TCP check on 127.0.0.1: the temporary server of the image's init phase listens on the socket only
  wait_ready "$DB" "$DB_TIMEOUT" "PostgreSQL" \
    docker exec "$DB" pg_isready -h 127.0.0.1 -U bench -d bench
}

migrate() {
  local name="$PREFIX-migrate"
  local rc=0
  timeout "$MIGRATE_TIMEOUT" docker run --name "$name" --label "$LABEL" --network "$NET" \
    -e DATABASE_URL="$DB_URL" -e APP_ENV=development -e ACCESS_CODE=bench-access-code \
    --entrypoint alembic "$IMG" upgrade head >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "ERROR: database migration failed or took longer than ${MIGRATE_TIMEOUT}s (exit $rc)" >&2
    show_diag "$name"
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  return "$rc"
}

cleanup_all() {  # only this run's resources
  local ids
  ids="$(docker ps -aq --filter "label=$LABEL" 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null 2>&1 || true
  fi
  docker network rm "$NET" >/dev/null 2>&1 || true
}
