# MyDubb

Private-beta web app that turns a user-provided English transcript into Vietnamese speech
for learning technical content.

Repository: https://github.com/chutieu312/mydubb (private).

**Status: Milestone 2B** (online Private Beta on https://mydubb.com with **mock providers**)
in progress, on top of Milestones 1 and 2A (application foundation, mock end-to-end workflow,
GitHub repository and CI). No Azure service is
called, and no exact-duration dubbing is implemented yet. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design and the roadmap,
[docs/API.md](docs/API.md) for API contracts, [docs/WORKFLOW.md](docs/WORKFLOW.md) for the
branch/CI workflow and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for Render/Neon/domain setup and
operations.

## Quick start (end to end, Docker)

```bash
./run-app.sh     # builds and starts PostgreSQL + the app, waits until ready
                 # open http://127.0.0.1:8000
./stop-app.sh    # stops everything; database data is kept
./stop-app.sh --purge   # also deletes the local database volume
```

`run-app.sh` uses `ACCESS_CODE` from your shell or the root `.env` file. If neither is set, it
generates a random code and saves it to `.env` (git-ignored); read it there to log in. On
Windows, run the scripts from Git Bash with Docker Desktop started.

## Repository layout

```
backend/            FastAPI app (Python 3.12, uv), Alembic migrations, tests
frontend/           React + TypeScript (Vite), Vitest tests
e2e/                Playwright browser tests + isolated Compose stack
docker/             Container entrypoint, smoke test, local Postgres init script
Dockerfile          Production-style image: FastAPI serves API + React build (same origin)
render.yaml         Render Blueprint for the online mock beta (see docs/DEPLOYMENT.md)
docker-compose.yml  Local PostgreSQL (+ optional app container)
.github/workflows/  CI
```

## Prerequisites

- Docker (for PostgreSQL and image builds)
- Python tooling: [uv](https://docs.astral.sh/uv/) 0.11+ (installs Python 3.12 if needed)
- Node.js 22+

## Local development

```bash
# 1. PostgreSQL (creates databases `mydubb` and `mydubb_test`)
docker compose up -d db

# 2. Backend
cp .env.example backend/.env        # then set ACCESS_CODE to your own value
cd backend
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:create_app --factory --reload --port 8000

# 3. Frontend (another terminal) — proxies /api to 127.0.0.1:8000
cd frontend
npm ci
npm run dev                          # open http://localhost:5173
```

On Windows, use `127.0.0.1` rather than `localhost` in `DATABASE_URL` (avoids slow IPv6
resolution). The `docker-compose` volume `pgdata` persists data; the init script that creates
`mydubb_test` runs only when the volume is first created.

### Trying failure scenarios

Set `MOCK_FAIL_STAGE` in `backend/.env` to `translation`, `speech`, `audio` or `unexpected`
and restart the backend. This control is rejected when `APP_ENV=production`.

## Environment variables

All configuration comes from environment variables; [.env.example](.env.example) lists every
variable with placeholders and comments. Required: `APP_ENV`, `DATABASE_URL` (PostgreSQL only),
`ACCESS_CODE`, `PROVIDER_MODE`. Invalid or unsafe combinations stop the app at startup, e.g.
a non-PostgreSQL URL, `PROVIDER_MODE=azure` (not implemented yet), or mock providers /
`COOKIE_SECURE=false` with `APP_ENV=production`.

## Tests and checks

```bash
# Backend (needs PostgreSQL; the suite DROPS and recreates the schema of this database)
cd backend
export TEST_DATABASE_URL=postgresql://mydubb:mydubb_local@127.0.0.1:5432/mydubb_test
uv run ruff check . && uv run ruff format --check .
uv run pytest

# Frontend (unit/regression tests run in jsdom with mocked fetch)
cd frontend
npm run lint && npm run typecheck && npm test && npm run build

# Browser E2E (isolated throwaway Docker stack, mock providers) - see e2e/README.md
cd e2e
npm ci && npx playwright install chromium
bash run-e2e.sh
```

Database tests fail (they are not skipped) when `TEST_DATABASE_URL` is missing. Point it only
at a disposable database such as `mydubb_test`, never at one holding data you need.
The E2E suite uses its own PostgreSQL on tmpfs and never touches the development database.

## Docker

```bash
docker build -t mydubb:local .

# Run with the compose PostgreSQL:
export ACCESS_CODE=your-own-local-code
docker compose up --build            # http://127.0.0.1:8000

# Smoke test a running container (health, readiness, SPA, one mock job):
BASE_URL=http://127.0.0.1:8000 ACCESS_CODE=$ACCESS_CODE sh docker/smoke-test.sh
```

The container runs `alembic upgrade head` on start (`RUN_MIGRATIONS_ON_START=true`), then a
single uvicorn worker. Behind a reverse proxy set `FORWARDED_ALLOW_IPS` so client IPs (used by
Access Code brute-force protection) are correct.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

| Job | What it checks |
|---|---|
| `frontend` | ESLint, TypeScript, Vitest regression tests, production build |
| `backend` | Ruff lint/format, Alembic upgrade/downgrade/upgrade on empty PostgreSQL, pytest with PostgreSQL |
| `docker` | Image build, container start, smoke test, and a second container with the production (online mock beta) configuration checked by `docker/production-config-check.sh` |
| `e2e` | Playwright (Chromium desktop + phone viewport) against an isolated container stack with mock providers |
| `ci-success` | Always runs; passes only if all four jobs **succeeded** (skipped/cancelled = failure). Use this as the required status check. |

Permissions are `contents: read`; no secrets, cloud resources or deployments are used.
CI runs on GitHub for every pull request and every push to `main`. Branch workflow, how to
read CI logs, actual protections and billing limits: [docs/WORKFLOW.md](docs/WORKFLOW.md).
