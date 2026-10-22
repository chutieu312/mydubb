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
| `translation/` | `TranslationProvider` protocol, mock, Azure Translator provider, glossary, no-translate markup and request segmenter | `processing_errors` |
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
- The client identity for brute-force protection comes from `CLIENT_IP_HEADER` when set
  (a header the edge proxy overwrites, e.g. `cf-connecting-ip`). Behind a proxy that appends
  to a client-supplied `X-Forwarded-For` (as Render's does), the left-most entry is
  spoofable, so it is only the fallback. The global failure limit applies in all cases.
- In production, responses carry `Strict-Transport-Security` and API docs are disabled.
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

## Restart behavior, deploys and the single-instance design

Execution state (worker threads, the in-memory transcript, the brute-force counters) lives in
the process that accepted the job. The design is **one serving instance with one uvicorn
worker** (the entrypoint enforces `--workers 1`; do not scale horizontally). A brief overlap
of an old and a new instance during a zero-downtime deploy is supported:

- **Job ownership and heartbeats**: each process gets a random `instance_id` at start. Jobs
  record it as `runner_id`. Every `JOB_HEARTBEAT_INTERVAL_SECONDS` (default 15 s), and on
  every stage change, the process refreshes `heartbeat_at` only for the jobs it still has
  **queued or running in memory**, not for every row carrying its `runner_id`. A job whose
  worker ended without recording a terminal state (for example, the database was unreachable
  when the failure was written) therefore stops receiving heartbeats, goes stale and is
  interrupted once the database is reachable again.
- **Recovery** (at startup and on every heartbeat tick): only active jobs whose heartbeat is
  older than `JOB_STALE_AFTER_SECONDS` (default 90 s) are marked `failed` with code
  `interrupted`. Jobs still running on another live instance are left alone. Rows written
  before heartbeats existed fall back to `updated_at`. Jobs are **never re-run
  automatically** because provider call outcomes are unknown; the user resubmits.
- **Graceful shutdown** (SIGTERM): queued work is cancelled, running jobs get up to
  `JOB_SHUTDOWN_GRACE_SECONDS` to finish (heartbeats continue meanwhile), and whatever this
  process accepted but did not finish is marked `interrupted`. Keep the grace period below
  the host's kill delay (Render: `maxShutdownDelaySeconds`, fixed at the default 30 s on the
  Free plan).
- After a hard crash, the crashed process's jobs are failed by the next live instance within
  roughly `JOB_STALE_AFTER_SECONDS + JOB_HEARTBEAT_INTERVAL_SECONDS`.
- Job status lives in PostgreSQL, so clients polling through the new instance see progress of
  jobs still running on the old one.
- **Results are per instance**: they are stored on the local (ephemeral) disk of the instance
  that produced them. After a deploy or restart, results produced by the previous instance
  return `result_expired`.
- Sessions are in PostgreSQL and survive restarts and deploys. Brute-force counters are in
  memory and reset on restart.
- **Migrations** run at container start (`alembic upgrade head`) while the old instance may
  still serve traffic, so every migration must be **expand-only / backward compatible**
  (e.g. add nullable columns; no renames or drops in the same release). Expand-only keeps the
  **schema** usable by older code, but not the **Alembic revision graph**: an image that does
  not know the database's current revision stops at startup with "Can't locate revision".
  Code rollbacks are therefore limited to commits that know the current revision; see
  [DEPLOYMENT.md](DEPLOYMENT.md#rolling-back).

Running several instances permanently would need a durable job queue and shared result
storage; that is intentionally out of scope.

## Mock components

| Component | Mock behavior |
|---|---|
| Translation (default; `TRANSLATION_PROVIDER=mock`) | Prefixes each line with `(VI mock)` under an explicit "illustrative content, NOT a real Vietnamese translation" notice. `is_illustrative=true`. |
| Speech | Copies `audio/fixtures/mock_audio.mp3` (3 s synthetic chime) regardless of text/voice. `is_fixture=true`. |
| Audio processing | Pass-through. `duration_adjusted=false`. **No tempo change, no duration guarantee.** |

With `TRANSLATION_PROVIDER=azure` the translation row above is replaced by the real Azure
Translator (see below) while speech and audio stay mock; the UI then labels each component
separately. The UI shows a "Development mock mode" banner (all mock) or a per-component
banner (Azure translation + mock audio) and per-result notices. The fixture is **not**
generated from the transcript and does **not** demonstrate target-duration compliance.

Failure scenarios are deterministic via `MOCK_FAIL_STAGE` (`translation`, `speech`, `audio`,
`unexpected`), which is rejected in production. `PROVIDER_MODE` must be set explicitly. With
`APP_ENV=production`, mock mode is refused unless `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`
(the online mock beta); that opt-in relaxes nothing else (Secure cookies, HSTS, a 16+
character Access Code and the `MOCK_FAIL_STAGE` ban still apply). `PROVIDER_MODE=azure` (real
everything) fails at startup until speech and audio exist — there is no silent fallback to
mocks. `MOCK_FAIL_STAGE=translation|unexpected` is rejected together with
`TRANSLATION_PROVIDER=azure`.

## Roadmap and remaining work

| Milestone | Scope | Status |
|---|---|---|
| 1 | Local foundation, mock end-to-end workflow, CI definition, review fixes | Done |
| 2A | Private GitHub repository, CI running on GitHub (see [WORKFLOW.md](WORKFLOW.md)) | Done |
| 2B | Online Private Beta on mydubb.com running with **mock** providers (see [DEPLOYMENT.md](DEPLOYMENT.md)) | Done (live at https://mydubb.com) |
| 3A | Azure Translator with glossary-protected technical terms (speech and audio stay mock) | Done: live on https://mydubb.com since 2026-10-22 (PR #9) |
| 3B / 3C | Azure Speech; FFmpeg duration processing | Later |

Azure and FFmpeg are not prerequisites for the Milestone 2B mock deployment.

### Milestone 2B (online mock Private Beta)

Implemented in the repository:

- `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION`: explicit opt-in for mock providers with
  `APP_ENV=production`; all other production rules stay enforced.
- Heartbeat-based job ownership and recovery, shutdown drain (see "Restart behavior").
- `CLIENT_IP_HEADER` for brute-force protection behind Render's proxy; HSTS in production.
- `render.yaml` Blueprint (Render Free, Oregon, auto-deploy after checks pass, health check,
  shutdown delay, `mydubb.com`) and the setup/operations guide [DEPLOYMENT.md](DEPLOYMENT.md):
  Neon, Render, GoDaddy DNS, online smoke test, rollback.

Deployed and verified on 2026-10-22: Neon, Render Blueprint, GoDaddy DNS, HTTPS, online
smoke test, and `CLIENT_IP_HEADER` present on Render requests (details in
[DEPLOYMENT.md](DEPLOYMENT.md#current-deployment)). Render Free does not support
`maxShutdownDelaySeconds`, so the shutdown drain is 20 s within Render's fixed 30 s delay.

### Azure Translator and technical terms (Milestone 3A)

`AzureTranslationProvider` (`translation/azure.py`) calls the Text Translation API v3.0
(`POST /translate?api-version=3.0&from=en&to=vi&textType=html`, key in
`Ocp-Apim-Subscription-Key`, optional `Ocp-Apim-Subscription-Region`). Verified against
Microsoft Learn on 2026-10-22. v3.0 was chosen because its contract is fully documented and no
retirement date is announced; the newer GA version `2026-06-06` has a different request and
response shape (`inputs`/`targets`/`value`) and is a separate, live-tested migration.

Pipeline inside `translate(text)`:

1. **Glossary** (`glossary.py`, data in `translation/data/glossary.txt`): finds known
   terms in each line. Case-insensitive but the input spelling is kept; `=TERM` lines are
   case-sensitive; whole words only, optional plural `s` ("APIs"); the longest match wins when
   terms overlap. Provider-independent text matching. It protects **known** terms only: new
   terms in any field are not detected automatically, and the glossary UI and LLM-based
   detection are out of scope. Ambiguous everyday words (class, model, cell, key, ...) are
   deliberately not listed: the glossary policy is to add specific phrases ("loss function"),
   because keeping a common word in English in every context would damage ordinary sentences.
2. **Markup** (`notranslate_markup.py`): the transcript is untrusted plain text. It is
   escaped (`&`, `<`, `>`), and only then are glossary terms wrapped in Microsoft's documented
   `<span class="notranslate">`, which works with `textType=html`. User text can therefore
   never create tags or no-translate directives. The answer is parsed with a strict HTML
   parser back to plain text; any tag other than a flat no-translate span, comment or
   declaration is rejected, so no markup or placeholder reaches the result and the frontend
   renders the text as text. After parsing, the protected spans of each segment must equal the
   source terms (same spelling, same count; order may differ). If a term is missing or
   changed, the job fails with `translation_terms_not_preserved` instead of showing a wrong
   result.
3. **Segmenting** (`segmenter.py`): each transcript line is one element of the request array,
   so line structure never depends on the service. A line that does not fit
   `AZURE_TRANSLATOR_MAX_REQUEST_CHARS` (default 10,000; the service limit is 50,000 characters
   and 1,000 elements per request, markup included) is cut at sentence boundaries, then at
   whitespace, never inside a protected term and never inside a word. Sizes count the final
   markup in UTF-16 units (each protected term adds 31 characters of wrapper, and Microsoft bills
   them: measured live, `X-metered-usage` equals the size sent). Whitespace
   between pieces is preserved, so joining reproduces the original. A run of more than the
   limit without any whitespace fails with `translation_input_unsupported`.
4. **Requests** are sequential, one chunk after another, with a total timeout per request
   (`AZURE_TRANSLATOR_TIMEOUT_SECONDS`, default 30; Microsoft documents a 15 s maximum
   latency) and a response size cap. Redirects are not followed. There is **no automatic
   retry** and **no fallback to the mock**: any failed chunk fails the job (no partial
   translation) and the user resubmits.

Errors are mapped to safe user messages: 401/403 → `translation_auth_failed` (server
credentials), 403001/429 → `translation_quota_exceeded`, timeouts/408 →
`translation_timeout`, connection problems → `translation_network_error`, 5xx and anything
unexpected → `translation_service_error`, 400 → `translation_rejected`, malformed answers →
`translation_invalid_response`. Logs contain status codes, Microsoft error codes, request IDs
and sizes only, never transcript text, translations, response bodies or the key.

**Privacy**: with Azure translation the transcript text leaves the server for Microsoft Azure
Translator. The UI says so next to the submit button. Nothing else about retention changes
(see "Data retention").

### Milestone 3 (real providers)

Milestone 3A (translation) is described above; the remaining items below still apply to
Azure Speech and FFmpeg.

**Azure Translator (F0)** - implemented in Milestone 3A (see above). Remaining: a live
quality evaluation with real course transcripts, and a decision whether to migrate to API
`2026-06-06` or add an LLM-based provider if the quality of F0 NMT is not good enough.

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
- Disclosure that submitted text is processed by Azure: done for translation in 3A; extend
  the wording when speech is added.
- Production configuration with Azure credentials (`PROVIDER_MODE=azure`); missing
  credentials must fail startup, never fall back to mocks.
