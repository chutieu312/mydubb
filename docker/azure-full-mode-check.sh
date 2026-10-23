#!/bin/sh
# Check a container started with PROVIDER_MODE=azure (fake keys; Azure is never called): startup
# succeeds (so ffmpeg, ffprobe, atempo and libmp3lame are in the image) and /api/meta reports
# every component as real. Does not create jobs, so no request leaves the machine.
# Usage: BASE_URL=http://127.0.0.1:8086 docker/azure-full-mode-check.sh
set -eu

BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"
fail() { echo "FAIL: $1" >&2; exit 1; }

i=0
until curl -fsS "$BASE_URL/api/ready" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 45 ] && fail "service did not become ready"
  sleep 2
done

meta=$(curl -fsS "$BASE_URL/api/meta") || fail "meta request failed"
echo "$meta" | grep -q '"provider_mode":"azure"' || fail "provider_mode not azure"
echo "$meta" | grep -q '"mock_mode":false' || fail "mock_mode must be false when every component is real"
echo "$meta" | grep -q '"providers":{"translation":"azure","speech":"azure","audio":"ffmpeg"}' \
  || fail "providers not reported per component"

echo "full azure mode OK: translation=azure, speech=azure, audio=ffmpeg, mock_mode=false"
