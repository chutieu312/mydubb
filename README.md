# MyDubb

Private-beta web app that turns a user-provided English transcript into Vietnamese speech
for learning technical content.

Repository: https://github.com/chutieu312/mydubb (private).

**Status: Milestone 3B done, 3C awaiting acceptance**: the online Private Beta runs at https://mydubb.com with real
English-to-Vietnamese translation by Azure Translator and a glossary that keeps technical
terms in English (`TRANSLATION_PROVIDER=azure`), and real speech by Azure Speech
(`SPEECH_PROVIDER=azure`; voices Andrew Multilingual, the default, and Emma Multilingual). Both
are off by default, so local and CI runs stay all-mock (on top of Milestones 1, 2A and 2B:
application foundation, mock end-to-end workflow, GitHub repository, CI, Render/Neon). Audio
processing is a pass-through on production until the Product Owner accepts Milestone 3C
(`AUDIO_PROCESSOR=ffmpeg`, FFmpeg duration fitting, implemented and tested but not yet enabled
there), so the production audio length is not adjusted to the target yet. See
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
- FFmpeg with `ffprobe`, including the `atempo` filter and the `libmp3lame` encoder (only for the
  audio tests, `SPEECH_PROVIDER=azure` and `AUDIO_PROCESSOR=ffmpeg` outside Docker; the Docker
  image includes it). Audio tests are skipped locally when it is missing and fail in CI.

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
a non-PostgreSQL URL, `PROVIDER_MODE=azure` while any component is a mock (it needs
`TRANSLATION_PROVIDER=azure`, `SPEECH_PROVIDER=azure` and `AUDIO_PROCESSOR=ffmpeg`), or mock
providers / `COOKIE_SECURE=false` with `APP_ENV=production`.

### Azure translation + mock audio

Set `PROVIDER_MODE=mock` (speech and audio stay mock), `TRANSLATION_PROVIDER=azure` and
`AZURE_TRANSLATOR_KEY` (plus `AZURE_TRANSLATOR_REGION` for a regional resource) in
`backend/.env`, which is git-ignored. Startup fails if the key is missing; there is never a
silent fallback to the mock translator. The UI then labels translation as real and
speech/audio as mock, and tells users that their transcript text is sent to Azure. Resource
setup, the live smoke test (`uv run python -m scripts.azure_translator_smoke`) and enabling it on
Render are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#azure-translator-milestone-3a).
Technical terms listed in
[backend/app/translation/data/glossary.txt](backend/app/translation/data/glossary.txt) stay in
English; add a term by adding a line to that file in a pull request.

### Azure speech (Milestone 3B)

`SPEECH_PROVIDER=azure` makes the speech stage generate real speech from the translated text
with Azure Speech (REST API), using one multilingual voice per audio (`AndrewMultilingual`,
the default, or `EmmaMultilingual`) with the Vietnamese text and the glossary's English terms
marked by language. Terms outside the glossary are not marked and may be mispronounced. It works with either translation provider
(`mock | azure`); without `AUDIO_PROCESSOR=ffmpeg` (below) audio processing is a pass-through and
the audio length is **not** adjusted to the target. Required: `AZURE_SPEECH_KEY` and
`AZURE_SPEECH_REGION` (the Speech resource's own key; the Translator key is never reused), plus
`ffmpeg`/`ffprobe` on `PATH`. Startup fails if any is missing; there is no fallback to the mock.
Optional: `AZURE_SPEECH_TIMEOUT_SECONDS`, `AZURE_SPEECH_MAX_CHUNK_CHARS` (default 2000),
`AZURE_SPEECH_MAX_REQUESTS_PER_WINDOW` / `AZURE_SPEECH_RATE_WINDOW_SECONDS` (default 20 per 60 s,
the Free F0 limit shared by all jobs). Resource setup and the live smoke test that creates MP3
samples to listen to (`uv run python -m scripts.azure_speech_smoke`) are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#azure-speech-milestone-3b).

### Duration fitting (Milestone 3C)

`AUDIO_PROCESSOR=ffmpeg` (needs `SPEECH_PROVIDER=azure` and `ffmpeg`/`ffprobe` with `atempo` and
`libmp3lame`; startup fails otherwise) speeds up or slows down the **whole** speech audio, pitch
preserved, so it lasts exactly the target (`last_sentence_start - first_sentence_start`): the PCM
has exactly the target number of samples and the MP3 decodes to the same number (one sample of
rounding at most). Nothing is cut or repeated; a result that cannot be brought to the target is a
job error, not a pass-through. `PROVIDER_MODE=azure` means every component is real
(`TRANSLATION_PROVIDER=azure`, `SPEECH_PROVIDER=azure`, `AUDIO_PROCESSOR=ffmpeg`). Details,
measurements and limits: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#duration-fitting-milestone-3c).

Check the durations without credentials (synthetic speech, real FFmpeg) and listen to the
before/after files in `backend/duration-samples/` (git-ignored):

```bash
cd backend
uv run python -m scripts.duration_smoke                    # table of target / source / PCM / MP3
uv run python -m scripts.duration_smoke --wav speech.wav --target-seconds 360   # a local WAV
uv run python -m scripts.duration_smoke --azure            # LIVE: 2 Azure Speech requests
```

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

Audio tests use the real `ffmpeg`/`ffprobe`; on a machine without them (e.g. plain Windows) run
the suite in a Linux container with FFmpeg, as CI does.

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
