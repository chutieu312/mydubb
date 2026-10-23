# Development workflow and CI

## Repository

- URL: https://github.com/chutieu312/mydubb (**private**, owner: personal account `chutieu312`)
- Default branch: `main`

## Branch workflow

1. Branch from an up-to-date `main`: `git switch main && git pull && git switch -c <type>/<topic>`
   (e.g. `fix/cleanup-race`, `docs/handoff`).
2. Commit focused changes; never commit `.env`, real Access Codes, keys or user data
   (`.gitignore` covers the usual cases; check `git diff --cached` before committing).
3. Push the branch and open a pull request into `main`: `gh pr create --base main`.
4. Merge only when the **CI success** check is green and the Product Owner approves. Use
   **Squash and merge**: one commit per pull request on `main`. Once continuous deployment is
   enabled (see [Continuous deployment](#continuous-deployment-cd)), the merge also starts a
   production deployment of the merge commit.
5. Never force-push or delete `main`.
6. After a pull request is merged, delete its branch and start any follow-up from a fresh
   branch off `main`. Commits pushed to an already merged branch belong to no pull request,
   get no CI run and never reach `main` (squash merging gives `main` a new commit SHA).

Steps 3–5 are a team rule, **not enforced by GitHub** on the current plan (see
[Protections](#protections)).

## CI (`.github/workflows/ci.yml`)

Runs on every `pull_request` and every push to `main` (and on a manual `workflow_dispatch`), on
GitHub-hosted `ubuntu-24.04` runners, with a read-only token. The CI jobs use no secrets. The same
workflow file also holds the deploy and smoke jobs, described in
[Continuous deployment](#continuous-deployment-cd), which never run for pull requests.

| Job (check name) | Runs | Local equivalent |
|---|---|---|
| Frontend (lint, typecheck, build) | ESLint, `tsc`, Vitest, Vite build | `cd frontend && npm ci && npm run lint && npm run typecheck && npm test && npm run build` |
| Backend (lint, migrations, tests) | Ruff lint + format, Alembic up/down/up on empty PostgreSQL, pytest | see README "Tests and checks" (needs `TEST_DATABASE_URL` pointing at a disposable DB) |
| Docker image build and container startup | `docker build`, container start, `docker/smoke-test.sh`, production-config container + `docker/production-config-check.sh` | `docker build -t mydubb:local .` then README "Docker" smoke test |
| Browser E2E (Playwright, mock providers) | `e2e/run-e2e.sh` on an isolated throwaway stack | `cd e2e && npm ci && npx playwright install chromium && bash run-e2e.sh` |
| CD scripts (shellcheck, fake Render tests) | ShellCheck on `.github/scripts/`, then `.github/scripts/tests/run-tests.sh`: the deploy and smoke scripts against a fake Render/GitHub/MyDubb server on 127.0.0.1 (nothing is deployed, no secret) | `bash .github/scripts/tests/run-tests.sh` (needs bash, curl, jq, python3) |
| **CI success** | Aggregate: passes only if all five jobs above concluded `success`; failed, skipped, cancelled or missing jobs fail it. It summarizes CI only and does not depend on deployment | — |

**CI success** is the single check to look at before merging.

Superseded runs of the same pull request are cancelled. Every push to `main` has its own
concurrency group (the run id), so each commit keeps a full CI run and no CI run waits for another.

### Investigating a failure

```bash
gh run list --limit 5                      # recent runs and their status
gh run view <run-id>                       # jobs and failed steps
gh run view <run-id> --log-failed          # logs of the failed steps only
gh run rerun <run-id> --failed             # retry only failed jobs (e.g. a network flake)
```

Or open the PR's **Checks** tab / the repository's **Actions** tab on GitHub.

- E2E failures upload a `playwright-report` artifact (screenshots, traces; mock data only),
  kept for 5 days: download with `gh run download <run-id> -n playwright-report`, then
  `npx playwright show-trace <trace.zip>`.
- Reproduce locally with the matching command in the table, fix the cause, and push again.
  Do not disable tests, drop jobs from **CI success** or relax validation to get a green run.
- Retry only for clear infrastructure flakes (registry/network timeouts) and note it in the PR.

### Actions supply chain

- All actions are pinned to full commit SHAs verified against the upstream release tags; the
  version is in a trailing comment. To update one, resolve the new tag to its commit on the
  official repository (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`) and replace the SHA.
- Repository settings allow only GitHub-owned actions plus `astral-sh/setup-uv`, and require
  SHA pinning, so an unpinned or unexpected action fails the run.
- The default workflow token is read-only and cannot approve pull requests.
- The deploy and smoke jobs add no third-party action: they use `actions/checkout` (pinned like the
  others) and the shell scripts in `.github/scripts/`, which call the Render API with `curl`.

## Continuous deployment (CD)

One workflow run shows CI, the Render deployment and the production check together:

```
Frontend / Backend / Docker / E2E / CD scripts
                  |
              CI success                 (CI only; does not depend on anything below)
                  |
           Deploy to Render              (push or manual run on main; off until CD_ENABLED=true)
                  |
        Production smoke check
```

| Event | CI jobs | Deploy to Render | Production smoke check |
|---|---|---|---|
| Pull request | run | never runs (skipped); no secret is available to it | skipped |
| Push to `main` | run | runs after **CI success** | runs after the deployment is live |
| Manual run (Actions -> CI -> Run workflow) on `main` | run, in full | same as a push: deploys `github.sha`, the commit just verified | same |
| Manual run on another branch | run | skipped (production deploys only from `refs/heads/main`) | skipped |

There is no `schedule` trigger and no `pull_request_target`, and `workflow_dispatch` has no inputs:
a manual run cannot choose a ref or SHA to deploy. If CI fails, **CI success** fails and the deploy
job is skipped.

### What each green check means

| Check | What it proves | What it does not prove |
|---|---|---|
| **CI success** | The tests, builds and container checks of that commit passed | Anything about production |
| **Deploy to Render** | Render created a deployment for exactly that commit (SHA read back from the deployment itself) and that deployment reached `live`, so traffic moved to it after its health check | That the application behaves correctly |
| **Production smoke check** | `https://mydubb.com` serves the page, `/api/health` is ok, `/api/ready` is ready (database reachable), `/api/meta` reports `translation=azure, speech=azure, audio=ffmpeg, mock_mode=false, provider_mode=azure` | Which commit runs (the deployment proves that), login, a real job, audio quality. It is a deployment smoke check and does **not** replace the authenticated end-to-end test or listening to the audio. It never logs in, never tries an Access Code, never calls Azure and never creates a job |

Two more outcomes are green but mean "nothing happened", and the job summary says so:
**CD not enabled** (the `CD_ENABLED` variable is not `true`; no deployment, no smoke check) and
**skipped** (the commit is already live, or a newer commit is live and this run is stale; no
deployment, no smoke check).

### How the deploy job works (`.github/scripts/render-deploy.sh`)

It uses the official Render REST API (`https://api.render.com/v1`) with `curl` and `jq`, both on
the runner. The Render CLI was not chosen: it would be one more binary to download and trust, and
the API exposes exactly what is needed (`commitId`, deployment id, status, commit of a deployment).

1. **Preflight (read-only).** Reads the service and **refuses to continue if Render auto-deploy is
   not `off`** (every commit would be deployed twice) or the service is suspended. Looks at the live
   deployment: same commit -> skip; live commit newer than this run's SHA (GitHub compare says
   `behind`) -> skip as stale; diverged history, or a live commit GitHub cannot compare -> fail
   rather than overwrite blindly. Fails, without cancelling anything, if Render already has a
   deployment in progress.
2. **Create once.** `POST /services/{id}/deploys` with `{"commitId": "<github.sha>"}`: the exact
   commit that passed CI, never "the latest of the branch". An accepted request does not mean a
   successful deployment.
3. **Never retry the create.** If the answer is lost (network error, HTTP 5xx, or 202 without a
   body), the script looks the deployment up by commit and creation time and never sends the
   request again. Nothing found, or two candidates: the job fails and asks you to check the Render
   dashboard before re-running. A 4xx answer fails immediately.
4. **Wait for that deployment id** (poll every 15 s, 25 minute limit; the job limit is 35 minutes).
   The deployment's commit must equal the SHA at every poll. `live` -> success. `build_failed`,
   `update_failed`, `pre_deploy_failed`, `canceled`, `deactivated` (replaced before this run saw it
   live), a commit mismatch, API errors that persist, or the time limit -> the job fails with the
   status and a dashboard link. On a timeout the deployment is **not** cancelled and may still
   finish.
5. **No rollback.** The script never rolls back, never cancels a deployment and never touches the
   database. After a failed or timed-out deployment the previous version keeps serving (Render
   switches traffic only after the new instance is healthy). A failing smoke check also changes
   nothing; decide using "Rolling back" in [DEPLOYMENT.md](DEPLOYMENT.md).

### Several commits close together

The deploy job has a job-level `concurrency` group with `cancel-in-progress: false`: production
deployments run **one at a time, and a running deployment is never cancelled by a newer commit**.
GitHub keeps **at most one pending job per group**: if several runs queue behind a running
deployment, only the newest stays pending and GitHub cancels the older pending ones. So **not every
commit gets its own deployment**. The newest commit is deployed (`main` is linear, so it contains
the older ones), and each deployment is always an exact SHA. A cancelled deploy job can be re-run
from the Actions page; when it starts, the stale check compares it with the live commit and skips
it if a newer commit is already live, so an old run can never overwrite a newer deployment. For the
same reason, re-running an old run is **not** a way to roll back; use Render's Rollback
(DEPLOYMENT.md). Runs that will not deploy (pull requests, CD off, CI failed) get a unique
concurrency group, so they cannot displace a pending deployment. CI itself is not serialized.

### Secrets and variables (repository level; no real values in the repository)

GitHub Free cannot protect an Environment of a private repository, so repository-level secrets and
variables are used and nothing depends on Environments or protection rules. Create them under
Settings -> Secrets and variables -> Actions, or with `gh`.

| Name | Kind | Value | Notes |
|---|---|---|---|
| `RENDER_API_KEY` | Secret | Render API key (Render -> Account Settings -> API Keys) | Used only by the deploy step of the deploy job. Enter it at the prompt of `gh secret set RENDER_API_KEY`, never on a command line or in chat. A Render API key acts as your Render user, not only on this service, so treat it as sensitive; revoking it in Render cuts access |
| `RENDER_SERVICE_ID` | Variable | `srv-...` (the id in the service's dashboard URL) | Not a secret |
| `PRODUCTION_URL` | Variable | `https://mydubb.com` | Must be `https://` with no path |
| `CD_ENABLED` | Variable | `true` to enable CD | Absent or anything else: the deploy job reports "CD not enabled" and does nothing |

Deliberately **not** added to GitHub: the Access Code, Azure keys, `DATABASE_URL` or any other
Render environment variable. The scripts pass the key to `curl` through stdin (it never appears in
the process list) and never print headers, response bodies or the environment. The token stays
read-only (`contents: read`); no job has `deployments: write` because GitHub Deployments are not
used.

### Cutover from Render auto-deploy

Goal: GitHub Actions is the only thing that deploys code changes automatically. Both at once would
create two deployments per commit, and Render's `checksPass` would even wait for the deploy job,
which waits for Render. Do the steps in this order:

1. **Secrets and variables.** Create `RENDER_API_KEY`, `RENDER_SERVICE_ID` and `PRODUCTION_URL`
   (table above). Do **not** create `CD_ENABLED` yet.
2. **Merge the pull request** (Squash and merge) and confirm **CI success** on the merge commit.
   `render.yaml` now says `autoDeployTrigger: "off"`, and Render's Blueprint sync applies a changed
   `render.yaml` when it reaches `main`, so this is also the moment that setting is applied. In the
   run, **Deploy to Render** shows *CD not enabled* and nothing is deployed; the smoke job is
   skipped.
3. **Make sure Render auto-deploy is off.** Render -> service `mydubb` -> Settings -> Build &
   Deploy -> Auto-Deploy must be **Off**. If the Blueprint sync did not apply it, set it by hand.
   Check Events: the merge commit must not have started a deployment.
4. **Enable CD**: `gh variable set CD_ENABLED --body true` (or Settings -> Variables).
5. **Run it once.** Actions -> CI -> Run workflow -> branch `main`. It runs CI in full, then
   deploys the head of `main` at that moment (the merge commit if nothing was merged since). A
   manual run needs no new commit.

**Confirming the first run.** In the run, **CI success** is green; the **Deploy to Render** summary
lists `Commit: <40-character SHA>` and a `dep-...` id with status `live`, and that SHA equals
`git rev-parse origin/main`; **Production smoke check** is green. In Render -> Events / Deploys
there is exactly one new deployment, triggered by the API, for that commit (the workflow cannot do
this independent check for you). Only then record CD as done in `docs/context.md`, in its own small
pull request.

### Rolling back to Render auto-deploy

In this order, so no commit is deployed twice:

1. `gh variable set CD_ENABLED --body false` (a deployment already running is not cancelled).
2. Render -> Settings -> Auto-Deploy -> **After CI Checks Pass**.
3. Pull request: `render.yaml` `autoDeployTrigger: checksPass`. Without it, the next Blueprint
   sync (any change to `render.yaml` on `main`) turns auto-deploy off again.

While `CD_ENABLED` is not `true` the deploy job passes immediately, so `checksPass` does not wait on
it. The secret and variables can stay; revoking the Render API key is the strongest cut-off.

### Troubleshooting CD

| Symptom | Cause / action |
|---|---|
| Deploy job: "CD not enabled" | `CD_ENABLED` is not `true`. Intended until the cutover |
| "Render auto-deploy is still enabled" | Cutover step 3 not done, or a Blueprint sync turned it back on (check `render.yaml`) |
| "Cannot read the Render service (HTTP 401/403/404)" | Wrong or revoked `RENDER_API_KEY`, or wrong `RENDER_SERVICE_ID` |
| "Render already has a deployment in progress" | Someone deployed from the dashboard. Wait for it, then re-run the failed job. Avoid manual deploys while a run is active |
| Skipped: "already live" / "stale" | Intended: the commit, or a newer one, is already on Render |
| "diverged" or "could not compare" | The live commit is neither an ancestor nor a descendant of this SHA (force push? a manual deploy of another branch?). Investigate in Render and GitHub; nothing was deployed |
| `build_failed` / `update_failed` | Open the dashboard link in the error and read the Render build or start log. The old version keeps serving. Fix forward through a pull request |
| "Timed out" | The deployment may still finish. Check Render; re-run the job only after it ended (a deployment that went live is skipped as "already live" on re-run) |
| "Unknown whether Render created the deployment" | The answer to the create call was lost and no deployment was found. Check Render Deploys before re-running; the script never re-sends the request itself |
| Deploy ok, smoke failed | The deployment is live but `/`, health, ready or `/api/meta` did not look right. Nothing was rolled back. Read the failing line; use DEPLOYMENT.md "Rolling back" if the site is broken |
| A deploy job shows "cancelled" | A newer commit replaced it in the single pending slot (see "Several commits close together") |

### Cost of the wait

The deploy job occupies a GitHub-hosted runner while it waits for Render, and that time uses the
account's Actions minutes like any other job (billed per job, rounded up to the minute). Expect it
to last as long as a Render Docker build plus start (not measured yet; the first real run will
show it), then about a minute for the smoke job, on top of the CI cost above. The limits are 25
minutes of waiting and a 35 minute job timeout. With CD off the job takes a few seconds.

## Protections

The account is on **GitHub Free**. For private repositories, GitHub Free does not offer branch
protection rules or rulesets (the API returns "Upgrade to GitHub Pro or make this repository
public"). Therefore, today:

- Pull requests, the required **CI success** check, and the ban on force-pushing or deleting
  `main` are **not enforced** by GitHub; they are manual rules (see Branch workflow).
- The plan was not upgraded and the repository stays private.
- If the account moves to GitHub Pro (or the repository to an organization plan that supports
  it), configure for `main`: require a pull request (0 required approvals for a one-person
  team), require status check `CI success`, block force pushes and deletion.

## Billing and cost control

- Workflows use only standard GitHub-hosted Linux runners (no larger or paid runners).
- Private repositories consume the account's included GitHub Actions minutes; one full CI run
  takes about 4 minutes of runner time, billed as about 6 minutes because each job is rounded
  up to a whole minute. Continuous deployment adds the minutes spent waiting for Render (see
  "Cost of the wait").
- Billing settings could not be read with the current CLI token (needs the `user` scope). The
  Product Owner should check **Settings → Billing and licensing** on github.com: included
  minutes and usage, whether a payment method is on file, and that Actions budgets stop usage
  at $0 so no overage can be charged. No billing setting was changed.
