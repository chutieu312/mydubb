# MyDubb architecture (Milestone 1)

A modular monolith: one FastAPI process serves the API and the built React app on the same
origin, stores job metadata in PostgreSQL, and runs jobs in a bounded in-process worker pool.
No Redis, Celery, queues or extra services.

```
Browser (React)
   │  same origin: /, /assets/*, /api/*
   ▼
FastAPI process ──────────────► PostgreSQL (sessions, job metadata)
   │  RequestGuardMiddleware (security headers, Origin check, body-size guard)
   │  routers: system │ access │ jobs
   │
   └─ BoundedThreadJobExecutor (N worker threads, bounded admission)
         └─ JobPipeline: translate → synthesize → process audio → store result
               │             │             │                 │
          Translation    Speech        AudioProcessor    ResultStore (local disk, TTL)
          Provider       Provider      (mock in M1)      
          (mock in M1)   (mock in M1)
```

## Modules and boundaries (`backend/app`)

| Module | Responsibility | Depends on |
|---|---|---|
| `config.py` | Environment-based `Settings`; refuses unsafe combinations at startup | — |
| `db.py` | Engine (with connect timeout), session factory, declarative base | — |
| `access/` | Access Code check, server-side sessions, brute-force limiter, session router | db |
| `transcript/` | Timestamp parsing, target-duration rule, transcript cleaning (pure functions) | — |
| `translation/` | `TranslationProvider` protocol + mock | `processing_errors` |
| `speech/` | `SpeechProvider` protocol, approved `Voice`s + mock | `processing_errors` |
| `audio/` | `AudioProcessor` protocol (fit to target duration) + mock; MP3 fixture | `processing_errors` |
| `storage/` | `ResultStore` protocol + `LocalFileResultStore` (temporary results) | — |
| `jobs/` | Job model, guarded status transitions, executor, pipeline, HTTP router | all of the above via protocols |
| `system/` | Health, readiness, public meta | db |
| `services.py` | Composition root: builds providers, store, executor, pipeline from settings | everything |
| `maintenance.py` | Startup recovery, shutdown interruption, periodic cleanup | jobs, access, storage |
| `main.py` | App factory, middleware, SPA serving, lifespan | everything |

Business logic does not reference Render or any host. HTTP handlers only validate, authorize,
create the job row and hand off to the executor; the pipeline never sees HTTP objects.

Interfaces are deliberately small `Protocol`s with one method each
(`translate`, `synthesize`, `fit_to_duration`, `save/get/delete/purge_expired`,
`reserve/shutdown`). Adding Azure means adding one class per protocol and wiring it in
`services.py`; no plugin system exists or is needed.

## Private Beta access and sessions

- `ACCESS_CODE` exists only in server configuration. The backend compares SHA-256 digests with
  `hmac.compare_digest`. It is never sent to the browser or stored in browser storage.
- On success a random 256-bit token is set as an HttpOnly, `SameSite=Strict` cookie
  (`Secure` required in production). PostgreSQL stores only the token's SHA-256 hash, the
  session's CSRF token, `expires_at` and `revoked_at`.
- Sessions expire after `SESSION_TTL_SECONDS` (absolute, default 12 h). Logout revokes the row
  server-side, so a replayed cookie is rejected.
- The UI treats logout as complete only when the server confirms it (`204`) or reports the
  session as already invalid (`401`). Network errors, `5xx` and CSRF rejections leave the user
  signed in with an error and a retry option; JavaScript never tries to delete the HttpOnly
  cookie.
- CSRF: synchronizer token in `X-CSRF-Token` for session-backed state changes, plus an Origin
  check on all state-changing API requests, plus `SameSite=Strict`.
- Brute-force protection counts **failed** attempts per client IP and globally in a sliding
  window (in memory). It never limits job creation.
- Ownership: every job row has `session_id`; all job/result/audio queries filter by the
  caller's session. A job ID alone grants nothing; foreign jobs return `404`.

## Job lifecycle

```
queued → translating → synthesizing → processing → completed
   └──────────┴──────────────┴─────────────┴──────→ failed (error code + safe message)
```

1. `POST /api/jobs` validates input, **reserves an executor slot** (or returns
   `503 server_at_capacity`), inserts the job (`queued`), commits, starts the pipeline and
   returns `202` immediately.
2. The pipeline runs in a worker thread (never on the asyncio event loop). Each status change
   is a short committed compare-and-set update (`UPDATE … WHERE status = <expected>`), so a job
   that was already marked failed (e.g. by restart recovery) can never be moved forward by a
   stale worker.
3. Expected failures raise `ProcessingError(code, user_message)` → job `failed` with that
   code. Unexpected exceptions → `internal_error` with a generic message; details go to server
   logs only (job ID, never transcript content).
4. On success the translation text and final MP3 are written to the `ResultStore`, then the job
   becomes `completed` with `result_expires_at`.

The UI shows these server-reported stages; it never invents percentage progress. Polling
(1 s) stops on a terminal state, on `401` (session expired), on `404`, after repeated errors,
or when the component unmounts.

### Concurrency and resources

`JOB_MAX_CONCURRENCY` worker threads (default 2) and at most `JOB_MAX_QUEUED` waiting jobs
(default 8). Admission is a non-blocking semaphore, so there is never an unbounded queue or
unbounded task creation. When full, the API reports `503 server_at_capacity` with
`Retry-After` — a real resource constraint, not a usage quota. There are no daily limits and no
transcript-length caps; the only size guard is `MAX_REQUEST_BODY_BYTES` (default 10 MB of
JSON, roughly a million and a half words) to protect a small instance's memory.

### Data retention

| Data | Where | Lifetime |
|---|---|---|
| Transcript text | Worker memory only (`JobInput`) | Until the job finishes |
| Job metadata (status, voice, timestamps, target duration, character count, provider names, error) | PostgreSQL `jobs` | Not deleted automatically in M1 (see open decisions) |
| Translation text + MP3 | Local disk `RESULT_STORAGE_DIR/<job_id>/` | `RESULT_TTL_SECONDS` after completion (default 1 h) |
| Per-job working files | OS temp dir | Deleted when the pipeline ends |
| Sessions | PostgreSQL `access_sessions` | Deleted by cleanup once expired or revoked; their jobs keep metadata with `session_id = NULL` |

Cleanup runs at startup and every `CLEANUP_INTERVAL_SECONDS` (in a thread): removes expired
or unreadable result directories, abandoned `.staging-*` directories and stale sessions.
Reads also check expiry, so an expired result is never served even between cleanup runs.

Result publication and cleanup are race-safe within the single process:

- A result is written into `.staging-<job_id>/` and published with one directory rename, so
  readers never observe a partially written result.
- The store tracks saves in progress (in memory, under a lock shared with cleanup); cleanup
  skips their staging directories. Staging directories from a crashed or previous process
  are not tracked and are removed by the next cleanup.
- A reader that loses a race with cleanup/deletion gets "result expired", not an error.

A completed job whose result is gone returns `410 result_expired` from `/result` and
`/result/audio`; `GET /api/jobs/{id}` still shows `completed`.

## Restart behavior and the single-instance limitation

Execution state (worker threads, the in-memory transcript, the brute-force counters) lives in
**one process**. Therefore:

- **Exactly one application instance with one uvicorn worker** may run against a database.
  The entrypoint enforces `--workers 1`. Do not scale horizontally.
- **Startup recovery**: every job still `queued/translating/synthesizing/processing` in the
  database is marked `failed` with code `interrupted` and a clear message. Its transcript is
  gone, and provider calls whose outcome is unknown are **never repeated automatically**; the
  user resubmits.
- **Graceful shutdown**: queued work is cancelled and jobs this process accepted but did not
  finish are marked `interrupted`.
- **Overlapping deploys are an open deployment issue (resolve before public beta).** Startup
  recovery assumes it is the only instance: it fails *every* active job in the database. If a
  new instance starts while the old one is still running (as zero-downtime deploys do), the
  new instance marks the old instance's in-flight jobs as `interrupted` even though they are
  still executing; the compare-and-set updates then stop the old worker and discard its
  result. Users must resubmit those jobs. This is **not** safe for multiple active instances
  and must be addressed (e.g. per-instance job ownership, or a deploy strategy that stops the
  old instance first) before relying on overlapping deploys.
- Sessions are in PostgreSQL and survive restarts. Results on an ephemeral disk (e.g. Render)
  do not; they become `result_expired`.
- Brute-force counters reset on restart.

Lifting the single-instance limit later would need a durable job queue/lease mechanism; that
is intentionally out of scope.

## What is mocked in Milestone 1

| Component | Mock behavior |
|---|---|
| Translation | Prefixes each line with `(VI mock)` under an explicit "illustrative content, NOT a real Vietnamese translation" notice. `is_illustrative=true`. |
| Speech | Copies `audio/fixtures/mock_audio.mp3` (3 s synthetic chime) regardless of text/voice. `is_fixture=true`. |
| Audio processing | Pass-through. `duration_adjusted=false`. **No tempo change, no duration guarantee.** |

The UI shows a "Development mock mode" banner and per-result notices. The fixture is **not**
generated from the transcript and does **not** demonstrate target-duration compliance.

Failure scenarios are deterministic via `MOCK_FAIL_STAGE` (`translation`, `speech`, `audio`,
`unexpected`), which is rejected in production. `PROVIDER_MODE` must be set explicitly; mock
mode is refused when `APP_ENV=production`, and `PROVIDER_MODE=azure` fails at startup until it
is implemented — there is no silent fallback to mocks.

## Roadmap and remaining work

| Milestone | Scope | Status |
|---|---|---|
| 1 | Local foundation, mock end-to-end workflow, CI definition, review fixes | Done |
| 2A | Private GitHub repository, CI running on GitHub (see [WORKFLOW.md](WORKFLOW.md)) | In review |
| 2B | Online Private Beta on mydubb.com running with **mock** providers | Next |
| 3 | Azure Translator, Azure Speech and FFmpeg duration processing | Later |

Azure and FFmpeg are not prerequisites for the Milestone 2B mock deployment.

### Milestone 2B (online mock Private Beta) - not implemented yet

- An explicit configuration that allows mock providers online while keeping production
  security (Secure cookies, Origin/CSRF checks, strong Access Code). Today
  `APP_ENV=production` refuses mock providers by design; 2B must not work around this by
  running in development mode.
- Job recovery for overlapping deployments (see "Restart behavior"): resolve before relying on
  zero-downtime deploys.
- Database migrations on deploy, health/readiness checks, result cleanup and a rollback
  procedure.
- Render CD ("After CI Checks Pass"), Neon database, mydubb.com domain and HTTPS, online
  smoke tests.
- Neon `DATABASE_URL` with `sslmode=require`; Render web service built from the Dockerfile
  with `COOKIE_SECURE=true`, a strong `ACCESS_CODE` and health check path `/api/health`.
- Account for Render Free sleep/cold starts, its ephemeral disk (results expire on restart)
  and memory limits when choosing `JOB_MAX_CONCURRENCY`; set `FORWARDED_ALLOW_IPS` for the
  proxy.

### Milestone 3 (real providers)

**Azure Translator (F0)**
- `AzureTranslationProvider`: chunk text to the service's per-request limits, preserve order,
  protect technical terms (e.g. `notranslate` markup or a glossary/dictionary approach — the
  glossary scope is an open product decision), timeouts, map 401/403/429/quota errors to
  `ProcessingError` codes with user-safe messages, no automatic retry of calls with unknown
  outcome.
- Credentials via env vars (`AZURE_TRANSLATOR_KEY`, region, endpoint); startup must fail if
  `PROVIDER_MODE=azure` and any are missing.

**Azure Speech (F0)**
- `AzureSpeechProvider` for `vi-VN-HoaiMyNeural` / `vi-VN-NamMinhNeural`, SSML, chunking to
  service limits, MP3/PCM output into the job work dir, quota/error mapping.
- Evaluate mixed Vietnamese/English pronunciation of technical terms.

**Audio processing (FFmpeg)**
- `FfmpegAudioProcessor`: concatenate chunks, apply tempo to the **complete** audio so its
  length equals the target duration (`atempo` chaining for factors outside 0.5–2.0), encode
  MP3, measure the output duration and fail if it misses the agreed tolerance.
- Define the precision tolerance with the Product Owner (MP3 frame granularity ≈ 26 ms at
  44.1 kHz) and add FFmpeg-based duration tests in CI. Report audio-quality risk for extreme
  tempo factors.
- Add FFmpeg to the runtime image.

**Production with real providers**
- Disclose in the UI that submitted text is processed by Azure services.
- Production configuration with Azure credentials (`PROVIDER_MODE=azure`); missing
  credentials must fail startup, never fall back to mocks.
