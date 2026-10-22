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
4. Merge only when the **CI success** check is green and the Product Owner approves.
5. Never force-push or delete `main`.

Steps 3–5 are a team rule, **not enforced by GitHub** on the current plan (see
[Protections](#protections)).

## CI (`.github/workflows/ci.yml`)

Runs on every `pull_request` and every push to `main`, on GitHub-hosted `ubuntu-24.04`
runners, with a read-only token and no secrets.

| Job (check name) | Runs | Local equivalent |
|---|---|---|
| Frontend (lint, typecheck, build) | ESLint, `tsc`, Vitest, Vite build | `cd frontend && npm ci && npm run lint && npm run typecheck && npm test && npm run build` |
| Backend (lint, migrations, tests) | Ruff lint + format, Alembic up/down/up on empty PostgreSQL, pytest | see README "Tests and checks" (needs `TEST_DATABASE_URL` pointing at a disposable DB) |
| Docker image build and container startup | `docker build`, container start, `docker/smoke-test.sh`, production-config container + `docker/production-config-check.sh` | `docker build -t mydubb:local .` then README "Docker" smoke test |
| Browser E2E (Playwright, mock providers) | `e2e/run-e2e.sh` on an isolated throwaway stack | `cd e2e && npm ci && npx playwright install chromium && bash run-e2e.sh` |
| **CI success** | Aggregate: passes only if all four jobs above concluded `success`; failed, skipped, cancelled or missing jobs fail it | — |

**CI success** is the single check to look at before merging.

Superseded runs of the same pull request are cancelled; every push to `main` keeps a full run.

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
  up to a whole minute.
- Billing settings could not be read with the current CLI token (needs the `user` scope). The
  Product Owner should check **Settings → Billing and licensing** on github.com: included
  minutes and usage, whether a payment method is on file, and that Actions budgets stop usage
  at $0 so no overage can be charged. No billing setting was changed.
