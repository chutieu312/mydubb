#!/usr/bin/env bash
# Idle DB-activity benchmark: the real app image + an isolated PostgreSQL, mock providers, no users,
# no jobs, no imports. Every SQL statement is logged by PostgreSQL (log_statement=all) and counted
# for the observation window. Nothing is disabled: heartbeat, stale-job check and cleanup run with
# their defaults.   Usage: run-idle.sh [observe_seconds=660]
# 660 s = two default cleanup intervals (300 s) plus margin; heartbeat/stale check every 15 s.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
OBSERVE="${1:-660}"
trap cleanup_all EXIT
mkdir -p "$RESULTS_DIR"; RESULTS_MOUNT="$(cd "$RESULTS_DIR" && (pwd -W 2>/dev/null || pwd))"; build_image; cleanup_all
start_db -c log_statement=all -c log_connections=on -c log_disconnections=on \
  -c "log_line_prefix=%m [%p] "
docker run -d --name "$APP" --network "$NET" \
  -e APP_ENV=development -e DATABASE_URL="$DB_URL" -e ACCESS_CODE=bench-access-code \
  -e PROVIDER_MODE=mock -e COOKIE_SECURE=false "$IMG" >/dev/null
until docker exec "$APP" python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/ready',timeout=3)" >/dev/null 2>&1; do sleep 1; done
sleep 3  # startup recovery and first connections are done; not part of the window
T0Z="$(docker exec "$DB" date -u +%Y-%m-%dT%H:%M:%SZ)"; T0="$T0Z"
cg() { docker exec "$APP" sh -c "cat /sys/fs/cgroup/$1 2>/dev/null"; }
CPU0="$(cg cpu.stat | awk '/usage_usec/{print $2}')"
DBX0="$(docker exec "$DB" psql -U bench -d bench -Atc "select xact_commit+xact_rollback from pg_stat_database where datname='bench'")"
echo "observing $OBSERVE s from $T0 (app commit $COMMIT)"
sleep "$OBSERVE"
CPU1="$(cg cpu.stat | awk '/usage_usec/{print $2}')"
DBX1="$(docker exec "$DB" psql -U bench -d bench -Atc "select xact_commit+xact_rollback from pg_stat_database where datname='bench'")"
RSS="$(docker exec "$APP" sh -c "grep -E 'VmRSS|VmHWM' /proc/1/status" | tr -s ' \n' ' ')"
MEMCUR="$(cg memory.current)"
CONNS="$(docker exec "$DB" psql -U bench -d bench -Atc "select state, count(*) from pg_stat_activity where datname='bench' and pid<>pg_backend_pid() group by 1" | tr '\n' ';')"
docker logs --timestamps "$DB" > "$RESULTS_DIR/idle-postgres.log" 2>&1
docker logs "$APP" > "$RESULTS_DIR/idle-app.log" 2>&1
docker run --rm -v "$BENCH_MOUNT:/bench:ro" -v "$RESULTS_MOUNT:/results:ro" --entrypoint python \
  "$IMG" -I /bench/analyze_idle.py /results/idle-postgres.log "$T0Z" "$OBSERVE" \
  "cpu_seconds=$(awk -v a="$CPU0" -v b="$CPU1" 'BEGIN{printf "%.3f",(b-a)/1e6}')" \
  "pg_transactions=$((DBX1-DBX0))" "app_rss=$RSS" "app_cgroup_memory_current_bytes=$MEMCUR" \
  "connections_at_end=$CONNS" > "$RESULTS_DIR/idle.json"
cat "$RESULTS_DIR/idle.json"
