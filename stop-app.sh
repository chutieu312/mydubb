#!/usr/bin/env bash
# Stop MyDubb started with ./run-app.sh.
#
#   ./stop-app.sh           stop and remove the containers; database data is kept
#   ./stop-app.sh --purge   also delete the local database volume (all local data)
set -euo pipefail

cd "$(dirname "$0")"

case "${1:-}" in
  "")
    docker compose down
    echo "MyDubb stopped. Database data is kept (use --purge to delete it)."
    ;;
  --purge)
    docker compose down --volumes
    echo "MyDubb stopped and the local database volume was deleted."
    ;;
  *)
    echo "Usage: ./stop-app.sh [--purge]" >&2
    exit 2
    ;;
esac
