# Shared settings for the MyDubb infrastructure benchmark scripts. Source it; do not run it.
# Every resource is named mydubb-infra-bench-* so nothing else on the machine is touched.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: do not rewrite /container/paths

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$BENCH_DIR/../.." && pwd)"
if pwd -W >/dev/null 2>&1; then  # Windows host path form for bind mounts
  BENCH_MOUNT="$(cd "$BENCH_DIR" && pwd -W)"; BACKEND_MOUNT="$(cd "$REPO_DIR/backend" && pwd -W)"
else
  BENCH_MOUNT="$BENCH_DIR"; BACKEND_MOUNT="$REPO_DIR/backend"
fi
COMMIT="$(cd "$REPO_DIR" && git rev-parse --short=7 HEAD)"
IMG="${BENCH_IMAGE:-mydubb-infra-bench:$COMMIT}"
NET=mydubb-infra-bench-net
DB=mydubb-infra-bench-db
APP=mydubb-infra-bench-app
DB_IMAGE=postgres:17-alpine
DB_URL="postgresql://bench:bench_local@$DB:5432/bench"
RESULTS_DIR="${RESULTS_DIR:-$BENCH_DIR/results/$COMMIT}"

build_image() { docker image inspect "$IMG" >/dev/null 2>&1 || docker build -t "$IMG" "$REPO_DIR"; }

start_db() {  # extra postgres -c options are passed as arguments
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  docker rm -f "$DB" >/dev/null 2>&1 || true
  docker run -d --name "$DB" --network "$NET" \
    -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench_local -e POSTGRES_DB=bench \
    "$DB_IMAGE" postgres "$@" >/dev/null
  until docker exec "$DB" pg_isready -U bench -d bench >/dev/null 2>&1; do sleep 1; done
  sleep 2  # the init phase restarts postgres once; wait for the final server
  until docker exec "$DB" pg_isready -U bench -d bench >/dev/null 2>&1; do sleep 1; done
}

migrate() {
  docker run --rm --network "$NET" -e DATABASE_URL="$DB_URL" -e APP_ENV=development \
    -e ACCESS_CODE=bench-access-code --entrypoint alembic "$IMG" upgrade head >/dev/null
}

cleanup_all() {
  docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
  docker ps -aq --filter "name=mydubb-infra-bench-case" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
