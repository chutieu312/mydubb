#!/usr/bin/env bash
# Deploy one exact commit to the Render service and wait until THAT deployment is live.
# Called only by the "Deploy to Render" job of .github/workflows/ci.yml, after CI success.
#
# Required environment:
#   RENDER_API_KEY     Render API key (GitHub Actions secret; never printed)
#   RENDER_SERVICE_ID  Render service id, srv-... (GitHub Actions variable)
#   DEPLOY_SHA         full 40-character commit SHA that passed CI (github.sha)
#   GITHUB_REPOSITORY  owner/name, GITHUB_TOKEN  read-only token (compares commits)
# Optional: DEPLOY_TIMEOUT_SECONDS (1500), POLL_INTERVAL_SECONDS (15), GITHUB_OUTPUT,
#   GITHUB_STEP_SUMMARY. RENDER_API_BASE / GITHUB_API_BASE exist only for the fake-server tests
#   and are refused unless TEST_ALLOW_API_BASE_OVERRIDE=1.
#
# Rules this script follows (docs/WORKFLOW.md, "Continuous deployment"):
# - Deploys exactly DEPLOY_SHA (Render API "commitId"), never "latest of the branch".
# - Refuses to run while Render auto-deploy is on (it would create a second deployment).
# - Skips, with the reason, when the live commit is the same as or newer than DEPLOY_SHA.
# - Never starts a deployment while another one is in progress, never cancels one.
# - Creates the deployment at most once. When the outcome of the request is unknown it looks
#   the deployment up by commit and creation time; it never sends the request again.
# - Waits for that deployment id to reach "live", with a finite timeout. Any failed, canceled
#   or superseded status, a commit mismatch or a timeout fails the job.
# - Never rolls back, never touches the database, never cancels a deployment on Render.
set -euo pipefail

RENDER_API_BASE="${RENDER_API_BASE:-https://api.render.com/v1}"
GITHUB_API_BASE="${GITHUB_API_BASE:-https://api.github.com}"
DEPLOY_TIMEOUT_SECONDS="${DEPLOY_TIMEOUT_SECONDS:-1500}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-15}"
LOOKUP_ATTEMPTS="${LOOKUP_ATTEMPTS:-8}"
LOOKUP_INTERVAL_SECONDS="${LOOKUP_INTERVAL_SECONDS:-15}"

fail() {
  echo "::error::$1" >&2
  summary "### Deploy to Render: FAILED" "" "$1"
  exit 1
}
note() { echo "$*"; }
summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"
}
output() {
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  echo "$1=$2" >> "$GITHUB_OUTPUT"
}

# ---- inputs -----------------------------------------------------------------------------------
: "${RENDER_API_KEY:?RENDER_API_KEY is not set}"
: "${RENDER_SERVICE_ID:?RENDER_SERVICE_ID is not set}"
: "${DEPLOY_SHA:?DEPLOY_SHA is not set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "DEPLOY_SHA is not a full 40-character commit SHA"
[[ "$RENDER_SERVICE_ID" =~ ^srv-[a-z0-9]+$ ]] || fail "RENDER_SERVICE_ID does not look like a Render service id (srv-...)"
[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "GITHUB_REPOSITORY is malformed"
[[ "$DEPLOY_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || fail "timeouts must be whole seconds"
if [ "$RENDER_API_BASE" != "https://api.render.com/v1" ] || [ "$GITHUB_API_BASE" != "https://api.github.com" ]; then
  [ "${TEST_ALLOW_API_BASE_OVERRIDE:-}" = "1" ] || fail "API base override is only allowed in tests"
fi

short_sha="${DEPLOY_SHA:0:7}"
dashboard_url="https://dashboard.render.com/web/${RENDER_SERVICE_ID}/deploys"

# ---- HTTP helpers -----------------------------------------------------------------------------
# The Authorization header is passed through stdin (curl -K -), so the key never appears in the
# process list. Bodies and headers are never echoed. Sets HTTP_CODE and BODY; returns non-zero
# when curl itself failed (network error, timeout), in which case HTTP_CODE is 000.
HTTP_CODE=""
BODY=""
http() { # http <auth: render|github|none> <method> <url> [json-body]
  local auth="$1" method="$2" url="$3" data="${4:-}" out rc=0
  local -a args=(-sS --max-time 60 --connect-timeout 15 -X "$method" -H "Accept: application/json" -w '\n%{http_code}')
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" --data "$data")
  case "$auth" in
    render) out=$(printf 'header = "Authorization: Bearer %s"\n' "$RENDER_API_KEY" | curl "${args[@]}" -K - "$url" 2>/dev/null) || rc=$? ;;
    github) out=$(printf 'header = "Authorization: Bearer %s"\nheader = "X-GitHub-Api-Version: 2022-11-28"\n' "$GITHUB_TOKEN" | curl "${args[@]}" -K - "$url" 2>/dev/null) || rc=$? ;;
    *) fail "internal error: unknown auth mode" ;;
  esac
  if [ "$rc" -ne 0 ]; then
    HTTP_CODE="000"
    BODY=""
    return 1
  fi
  HTTP_CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
render() { http render "$@"; }
github() { http github "$@"; }

# GET with a few attempts for transient problems. Safe only for reads.
render_get() { # render_get <path>
  local _
  for _ in 1 2 3; do
    if render GET "$RENDER_API_BASE$1" && [ "$HTTP_CODE" = "200" ]; then return 0; fi
    case "$HTTP_CODE" in 401 | 403 | 404) return 1 ;; esac
    sleep "$POLL_INTERVAL_SECONDS"
  done
  return 1
}

# ---- 1. preflight: the service ----------------------------------------------------------------
note "Deploying ${short_sha} to Render service ${RENDER_SERVICE_ID}"
render_get "/services/${RENDER_SERVICE_ID}" \
  || fail "Cannot read the Render service (HTTP ${HTTP_CODE}). Check RENDER_API_KEY and RENDER_SERVICE_ID."
service_json="$BODY"
auto_trigger=$(jq -r '.autoDeployTrigger // empty' <<< "$service_json")
auto_legacy=$(jq -r '.autoDeploy // empty' <<< "$service_json")
suspended=$(jq -r '.suspended // empty' <<< "$service_json")
if [ "$auto_trigger" != "off" ]; then
  # Only a missing autoDeployTrigger may fall back to the deprecated field.
  if [ -n "$auto_trigger" ] || [ "$auto_legacy" != "no" ]; then
    fail "Render auto-deploy is still enabled (autoDeployTrigger='${auto_trigger:-unset}', autoDeploy='${auto_legacy:-unset}'). Turn it off in Render > Settings > Build & Deploy > Auto-Deploy = Off, then re-run. GitHub Actions must be the only trigger, or each commit is deployed twice."
  fi
fi
[ "$suspended" != "suspended" ] || fail "The Render service is suspended; resume it in the dashboard first."
note "Service: $(jq -r '.name // "?"' <<< "$service_json"), auto-deploy off, not suspended"

# ---- 2. preflight: stale or already-live commit -----------------------------------------------
render_get "/services/${RENDER_SERVICE_ID}/deploys?status=live&limit=5" \
  || fail "Cannot list deployments (HTTP ${HTTP_CODE})."
live_sha=$(jq -r '[.[].deploy | select(.status == "live" and .commit.id != null)] | sort_by(.createdAt) | last | .commit.id // empty' <<< "$BODY")

if [ -n "$live_sha" ]; then
  if [ "$live_sha" = "$DEPLOY_SHA" ]; then
    reason="commit ${short_sha} is already live on Render"
    skip=1
  else
    github GET "$GITHUB_API_BASE/repos/${GITHUB_REPOSITORY}/compare/${live_sha}...${DEPLOY_SHA}" \
      || fail "Cannot reach GitHub to compare the live commit with ${short_sha}."
    [ "$HTTP_CODE" = "200" ] \
      || fail "GitHub could not compare live commit ${live_sha:0:7} with ${short_sha} (HTTP ${HTTP_CODE}); not deploying blind."
    relation=$(jq -r '.status // empty' <<< "$BODY")
    case "$relation" in
      ahead) skip=0 ;;
      identical) reason="commit ${short_sha} is already live on Render"; skip=1 ;;
      behind) reason="live commit ${live_sha:0:7} is newer than ${short_sha}; this run is stale, a newer commit already went out"; skip=1 ;;
      *) fail "Live commit ${live_sha:0:7} and ${short_sha} have diverged (status '${relation}'). Not overwriting production; resolve manually." ;;
    esac
  fi
  if [ "$skip" = 1 ]; then
    note "SKIPPED: ${reason}"
    echo "::notice::Deployment skipped: ${reason}"
    summary "### Deploy to Render: skipped" "" "${reason}. Nothing was deployed and no smoke check runs."
    output deployed false
    output skipped true
    exit 0
  fi
else
  note "No live deployment found on Render; continuing."
fi

# ---- 3. preflight: nothing else running -------------------------------------------------------
render_get "/services/${RENDER_SERVICE_ID}/deploys?status=created&status=queued&status=build_in_progress&status=update_in_progress&status=pre_deploy_in_progress&limit=5" \
  || fail "Cannot list in-progress deployments (HTTP ${HTTP_CODE})."
# The status filter is applied again here, so a server that ignored it cannot cause a false alarm.
busy=$(jq -r 'map(.deploy | select(.status | IN("created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"))) | map("\(.id) (\(.status), trigger \(.trigger // "?"))") | join(", ")' <<< "$BODY")
[ -z "$busy" ] || fail "Render already has a deployment in progress: ${busy}. Not starting another and not cancelling it. Re-run this job when it has finished (${dashboard_url})."

# ---- 4. create the deployment (exactly once) --------------------------------------------------
# One minute of margin for clock differences between this runner and Render.
requested_at=$(date -u -d '60 seconds ago' +%Y-%m-%dT%H:%M:%SZ)
deploy_id=""
body=$(jq -cn --arg sha "$DEPLOY_SHA" '{commitId: $sha, clearCache: "do_not_clear"}')
create_unknown=0
if render POST "$RENDER_API_BASE/services/${RENDER_SERVICE_ID}/deploys" "$body"; then
  case "$HTTP_CODE" in
    201 | 202)
      deploy_id=$(jq -r '.id // empty' <<< "$BODY" 2>/dev/null || true)
      # 202 has no documented body: the deployment may be created later, so look it up.
      [ -n "$deploy_id" ] || create_unknown=1
      ;;
    5??) create_unknown=1 ;;
    *) fail "Render refused to create the deployment (HTTP ${HTTP_CODE}). Nothing was deployed." ;;
  esac
else
  create_unknown=1
fi

if [ -z "$deploy_id" ]; then
  [ "$create_unknown" = 1 ] || fail "internal error: no deployment id"
  note "The create request did not return a deployment id (HTTP ${HTTP_CODE}). Looking for it by commit; the request is NOT sent again."
  attempt=0
  while [ -z "$deploy_id" ] && [ "$attempt" -lt "$LOOKUP_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    sleep "$LOOKUP_INTERVAL_SECONDS"
    if render GET "$RENDER_API_BASE/services/${RENDER_SERVICE_ID}/deploys?createdAfter=${requested_at}&limit=20" && [ "$HTTP_CODE" = "200" ]; then
      matches=$(jq -r --arg sha "$DEPLOY_SHA" '[.[].deploy | select(.commit.id == $sha)] | map(.id) | .[]' <<< "$BODY")
      count=$(printf '%s' "$matches" | grep -c . || true)
      if [ "$count" -gt 1 ]; then
        fail "Several Render deployments for ${short_sha} were created in the last minutes (${matches//$'\n'/, }); cannot tell which one this run started. Check ${dashboard_url}."
      fi
      deploy_id="$matches"
    fi
  done
  [ -n "$deploy_id" ] || fail "Unknown whether Render created the deployment (create request HTTP ${HTTP_CODE}; none found for ${short_sha}). The request was not retried. Check ${dashboard_url} before re-running."
fi
[[ "$deploy_id" =~ ^dep-[a-z0-9]+$ ]] || fail "Render returned an unexpected deployment id"
note "Deployment id: ${deploy_id}"
output deploy_id "$deploy_id"
echo "::notice title=Render deployment::${deploy_id} for ${short_sha}: ${dashboard_url}/${deploy_id}"

# ---- 5. wait for that deployment --------------------------------------------------------------
started=$(date +%s)
last_status=""
failures=0
while :; do
  elapsed=$(($(date +%s) - started))
  if render GET "$RENDER_API_BASE/services/${RENDER_SERVICE_ID}/deploys/${deploy_id}" && [ "$HTTP_CODE" = "200" ]; then
    failures=0
    status=$(jq -r '.status // "unknown"' <<< "$BODY")
    commit=$(jq -r '.commit.id // empty' <<< "$BODY")
    if [ -n "$commit" ] && [ "$commit" != "$DEPLOY_SHA" ]; then
      fail "Deployment ${deploy_id} is for commit ${commit:0:7}, not ${short_sha}. Not trusting it."
    fi
    if [ "$status" != "$last_status" ]; then
      note "[${elapsed}s] ${deploy_id}: ${status}"
      last_status="$status"
    fi
    case "$status" in
      live)
        [ "$commit" = "$DEPLOY_SHA" ] || fail "Deployment ${deploy_id} is live but Render did not report its commit; cannot verify ${short_sha}."
        break
        ;;
      build_failed | update_failed | pre_deploy_failed)
        fail "Deployment ${deploy_id} failed (${status}). Logs: ${dashboard_url}/${deploy_id}. The previous version keeps serving; nothing was rolled back."
        ;;
      canceled)
        fail "Deployment ${deploy_id} was canceled on Render (${dashboard_url}/${deploy_id})."
        ;;
      deactivated)
        fail "Deployment ${deploy_id} became inactive before this run saw it live (replaced by another deployment?). Check ${dashboard_url}."
        ;;
      *) ;; # created, queued, build_in_progress, update_in_progress, pre_deploy_in_progress
    esac
  else
    case "$HTTP_CODE" in
      401 | 403 | 404) fail "Cannot read deployment ${deploy_id} (HTTP ${HTTP_CODE})." ;;
    esac
    failures=$((failures + 1))
    note "[${elapsed}s] could not read the deployment (HTTP ${HTTP_CODE}); attempt ${failures} of 6"
    [ "$failures" -lt 6 ] || fail "Render API kept failing while waiting for ${deploy_id} (last HTTP ${HTTP_CODE}). The deployment may still be running: ${dashboard_url}/${deploy_id}"
  fi
  if [ "$elapsed" -ge "$DEPLOY_TIMEOUT_SECONDS" ]; then
    fail "Timed out after ${elapsed}s waiting for ${deploy_id} (last status: ${last_status:-unknown}). It is NOT cancelled and may still finish: ${dashboard_url}/${deploy_id}"
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

elapsed=$(($(date +%s) - started))
note "Deployment ${deploy_id} is live for commit ${short_sha} after ${elapsed}s"
summary "### Deploy to Render: live" "" \
  "- Commit: \`${DEPLOY_SHA}\`" \
  "- Render deployment: \`${deploy_id}\` (status \`live\`, commit verified from the deployment itself)" \
  "- Waited: ${elapsed}s" \
  "- Smoke check runs next; this step alone does not prove the application works."
output deployed true
output skipped false
