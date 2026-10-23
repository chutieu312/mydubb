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
| `speech/` | `SpeechProvider` protocol, approved `Voice`s, mock, Azure Speech provider, SSML builder, text chunker, shared request-rate limiter | `processing_errors`, `audio`, `translation.glossary` |
| `audio/` | `AudioProcessor` protocol + mock (pass-through) + `FfmpegAudioProcessor` (duration fitting), audio speed and the exact sample target (`speed.py`), WAV validation/joining, FFmpeg tempo/encode/decode/probe, exact-length conform, MP3 gapless-header reader and padding correction, MP3 fixture | `processing_errors`, `speech.base` |
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
| Job metadata (status, voice, timestamps, baseline duration, audio speed, character count, provider names, error) | PostgreSQL `jobs` | Not deleted automatically in M1 (see open decisions) |
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
| Speech (default; `SPEECH_PROVIDER=mock`) | Copies `audio/fixtures/mock_audio.mp3` (3 s synthetic chime) regardless of text/voice. `is_fixture=true`. |
| Audio processing (default; `AUDIO_PROCESSOR=mock`) | Pass-through. `duration_adjusted=false`. **No tempo change, no duration guarantee.** |

With `TRANSLATION_PROVIDER=azure` the translation row above is replaced by the real Azure
Translator (see below) and with `SPEECH_PROVIDER=azure` the speech row by Azure Speech (see
"Azure Speech") and with `AUDIO_PROCESSOR=ffmpeg` the audio row by FFmpeg duration fitting
(see "Duration fitting"); the UI then labels each component separately. The supported mixes
are: all mock; Azure translation + mock speech; Azure translation + Azure speech (duration not
adjusted); the same with `AUDIO_PROCESSOR=ffmpeg` (everything real); and, for development, mock
translation + Azure speech (+ FFmpeg). `AUDIO_PROCESSOR=ffmpeg` needs `SPEECH_PROVIDER=azure`
(it adjusts the lossless audio of real speech, not the fixture). `PROVIDER_MODE=azure` means
"everything real" and is accepted only with `TRANSLATION_PROVIDER=azure`,
`SPEECH_PROVIDER=azure` and `AUDIO_PROCESSOR=ffmpeg`; `PROVIDER_MODE=mock` allows any mix, and
production then still needs `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`. `/api/meta` reports
`provider_mode` by what is really running (`azure` only when no component is a mock). The UI
shows a "Development mock mode" banner (all mock), a per-component banner while any component
is a mock, and no banner when everything is real; each result carries notices. The fixture is
**not** generated from the transcript and does **not** demonstrate target-duration compliance.

Failure scenarios are deterministic via `MOCK_FAIL_STAGE` (`translation`, `speech`, `audio`,
`unexpected`), which is rejected in production. `PROVIDER_MODE` must be set explicitly. With
`APP_ENV=production`, mock mode is refused unless `ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true`
(the online mock beta); that opt-in relaxes nothing else (Secure cookies, HSTS, a 16+
character Access Code and the `MOCK_FAIL_STAGE` ban still apply). `PROVIDER_MODE=azure` with a
mock component fails at startup, and missing credentials or FFmpeg stop it too — there is no
silent fallback to mocks. `MOCK_FAIL_STAGE=translation|unexpected` is rejected together with
`TRANSLATION_PROVIDER=azure`, `MOCK_FAIL_STAGE=speech` together with `SPEECH_PROVIDER=azure` and
`MOCK_FAIL_STAGE=audio` together with `AUDIO_PROCESSOR=ffmpeg`.

## Roadmap and remaining work

| Milestone | Scope | Status |
|---|---|---|
| 1 | Local foundation, mock end-to-end workflow, CI definition, review fixes | Done |
| 2A | Private GitHub repository, CI running on GitHub (see [WORKFLOW.md](WORKFLOW.md)) | Done |
| 2B | Online Private Beta on mydubb.com running with **mock** providers (see [DEPLOYMENT.md](DEPLOYMENT.md)) | Done (live at https://mydubb.com) |
| 3A | Azure Translator with glossary-protected technical terms (speech and audio stay mock) | Done: live on https://mydubb.com since 2026-10-22 (PR #9) |
| 3B | Azure Speech (real speech with two multilingual voices, chunking, MP3 assembly; duration not adjusted) | Done: live on https://mydubb.com since 2026-10-22 (PR #11) |
| 3C | FFmpeg duration processing (tempo change of the whole audio to exactly the target) | Done: live on https://mydubb.com since 2026-10-23 (PR #13) |
| - | Audio speed choice (seven speeds; output = baseline / speed) | Done: live on https://mydubb.com since 2026-10-23 (PR #18) |

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

### Azure Speech (Milestone 3B)

`AzureSpeechProvider` (`speech/azure.py`), selected with `SPEECH_PROVIDER=azure`. Checked
against Microsoft Learn on 2026-10-22.

**REST, not the Speech SDK.** The SDK is a native library (large wheel plus system packages)
with streaming/event features this job does not need ("SSML in, audio file out"); Microsoft
itself describes REST as the option for cases where the SDK cannot or need not be used. REST is
one HTTPS `POST {region}.tts.speech.microsoft.com/cognitiveservices/v1`, reuses the `httpx`
client already shipped, and runs unchanged in the slim Linux image on Render. Authentication is
the Speech resource's own key (`Ocp-Apim-Subscription-Key`); the Translator key is never used.
The region is validated (`[a-z0-9]{2,30}`) because it becomes part of the host name; redirects
are not followed, so the key cannot be sent anywhere else.

**Limits that apply to this REST path** (and only to it): Free F0 allows 20 transactions per
60 seconds for the whole resource (not adjustable; Standard S0 30 TPS); a request produces at
most 10 minutes of audio, and longer audio is **silently truncated** with a normal `200`; the
"64 KB SSML per turn" limit belongs to WebSocket and is not applied. Microsoft also states that
many `429`s come from backend capacity for a voice rather than from the quota.

**Voices and SSML.** After listening to real audio the Product Owner replaced the two Vietnamese
Standard voices (`HoaiMy`, `NamMinh`) with `AndrewMultilingual` (default) ->
`en-US-AndrewMultilingualNeural` and `EmmaMultilingual` -> `en-US-EmmaMultilingualNeural`.
Both are multilingual voices, so one speaker reads Vietnamese and English. The SSML is the
structure that was auditioned and accepted (`speech/ssml.py`):

```
<speak ... xml:lang="en-US"><voice name="en-US-AndrewMultilingualNeural">
  <lang xml:lang="vi-VN">Hôm nay chúng ta tìm hiểu cách một </lang>
  <lang xml:lang="en-US">neural network</lang>
  <lang xml:lang="vi-VN"> học từ dữ liệu. ...</lang> ...
</voice></speak>
```

Exactly one `<voice>` per request (never a second speaker), default speaking rate, no `phoneme`,
style or other markup. The English spans come from the **shared glossary** (the same
`translation/data/glossary.txt` and matching rules used to protect terms in translation; there is
no second list for speech): longest match wins, spelling and case are kept, and `REST API`,
`pipeline` were added to it for this sample. The spans partition the text exactly, so
concatenating them returns the chunk unchanged (same spelling, case, whitespace, order). The text
is XML-escaped (characters invalid in XML are removed) and only ever appears as text content of
a span, so it cannot add elements, attributes or audio URLs. **Limit:** an English term that is
not in the glossary gets no English span; it is read inside the Vietnamese span and may be
mispronounced. There is no LLM, phoneme dictionary or automatic term detection. Whether the
result sounds right is a **listening** judgement made by the Product Owner
(`scripts/azure_speech_smoke.py` creates the samples), not something HTTP success or a valid MP3
proves. Jobs created with the former voices keep their stored name (the `jobs.voice` column is
free text); it is only displayed and never mapped back to a voice.

**Chunking** (`speech/chunker.py`): the translated text (spaces inside a line normalized, blank
lines dropped, lines kept on separate lines as in the accepted audition) is packed greedily into chunks of whole lines and sentences up to
`AZURE_SPEECH_MAX_CHUNK_CHARS` (default 2,000, i.e. a few minutes of speech, far below 10
minutes). A sentence over the limit is cut at spaces, never inside a glossary term or a word; a
run over the limit with no usable space fails with `speech_input_unsupported` instead of being
cut. `" ".join(chunks).split() == text.split()` is tested, so nothing is lost, repeated or
reordered. Text without any letter or digit has nothing to read and is not sent.

**Requests** are sequential per job. A process-wide `RequestRateLimiter` (a sliding window of
`AZURE_SPEECH_MAX_REQUESTS_PER_WINDOW` per `AZURE_SPEECH_RATE_WINDOW_SECONDS`, defaults 20 per
60 s plus a 1 s margin) is shared by all jobs, because the quota belongs to the resource. A long
transcript therefore takes about `chunks / 19` minutes on F0 and the job stays in
`synthesizing`; the UI shows the stage, not a percentage. Shutdown closes the limiter so waiting
jobs stop. There is no retry (a failed or timed-out request may still have consumed quota), no
fallback to the mock, and one failed chunk fails the job; no partial audio is returned.

**Audio.** Each chunk is requested as `riff-24khz-16bit-mono-pcm`, streamed to a temporary file
with a size and total-time cap and validated: strict WAV header (declared length present, PCM,
24 kHz mono 16-bit), not within 10 s of the 10 minute limit (it may be cut), and not
implausibly short for its text (over 50 characters/second). Chunks are joined **as samples**
(`audio/wav.py`), never by appending encoded bytes; then FFmpeg encodes one mono 96 kbit/s MP3
with the Xing/Info header browsers use to seek, and ffprobe verifies one MP3 stream whose
length matches the samples. Temporary files live in the job work directory and in a scratch
directory removed in `finally`; partial `speech.wav`/`speech.mp3` are deleted on failure.
`SpeechAudio.lossless_path` keeps the joined WAV in the work directory so Milestone 3C can change
the tempo **before** encoding; nothing in 3B changes duration or the target (3C does, see
"Duration fitting").

Errors: 401/403 -> `speech_auth_failed`, 429 -> `speech_quota_exceeded`, 408/504 and timeouts ->
`speech_timeout`, connection problems -> `speech_network_error`, 5xx/unexpected ->
`speech_service_error`, other 4xx -> `speech_rejected`, unusable audio ->
`speech_invalid_audio`, assembly/FFmpeg problems -> `speech_audio_failed`, shutdown ->
`speech_cancelled`. Logs contain status codes, request IDs, counts and audio seconds only: never
the key, headers, SSML, text or response content.

**Privacy**: with Azure speech the translated Vietnamese text (with mock translation, the mock
text that still contains the transcript) is sent to Microsoft Azure Speech; the form says so
before submit.

### Duration fitting (Milestone 3C)

`AUDIO_PROCESSOR=ffmpeg` selects `FfmpegAudioProcessor` (`audio/fitter.py`). The contract: the
target is `last_sentence_start - first_sentence_start` at speed 1x; the audio speed option (see
"Audio speed" below) divides that baseline by the chosen speed. Either way, with no time added for
reading the last sentence, no duration inferred from word counts, no per-sentence alignment.

**What it does** (to the lossless WAV Azure Speech produced, `SpeechAudio.lossless_path`):

1. Measure the natural length: `factor = source_samples / target_samples` (the same ratio as
   source_duration / target_duration; at 24 kHz the target is a whole number of samples).
2. Change the tempo of the **complete** audio with FFmpeg `atempo`, which keeps the pitch and
   the voice. A factor outside one filter's range (0.5-2.0, valid on every FFmpeg version) is
   split into a chain of in-range filters whose product is the factor (10 -> 2, 2, 2, 1.25);
   nothing is clamped or skipped. Nothing is cut, skipped or repeated, and Azure, the
   translation and the voice are not touched again.
3. Measure the result. `atempo` works in overlapping 2048-sample windows, so its output length
   is only approximately `source / factor` (tens to a few hundred samples, up to about two
   windows when slowing down by a factor below 0.5). If it is more than one window
   (`ROUNDING_LIMIT_FRAMES` = 2048 samples, 85 ms at 24 kHz) from the target, the factor is
   corrected from the measurement and the **original** audio is processed again (never twice on
   processed audio), up to 6 passes.
4. Make the sample count exactly the target (`audio/duration.py: conform_wav`): a shorter result
   gets **silence appended**; a longer one loses trailing samples **only if every one of them
   is silent** (at most 32/32768, about -60 dBFS). Anything else is an error
   (`audio_duration_not_reached`), never an `atrim` that hides a tempo that was not reached.
   A speech already within one window of the target (and, if longer, with a silent end) gets
   only this step and no tempo change. The amounts are reported (`padded_samples`,
   `trimmed_samples`); in the measured runs below they are 4-1998 samples (0.2-83 ms), mostly
   under 200.
5. Encode the PCM to MP3 **once** (unchanged settings: libmp3lame, 96 kbit/s, mono, 24 kHz,
   Xing/Info header), then **verify the real file**: decode it with FFmpeg and count samples,
   and read the playable length from the MP3's own gapless header (frames x 576 - encoder
   delay - padding, parsed without FFmpeg in `audio/mp3_header.py`). Both must be within one
   sample of the target or the job fails with `audio_verification_failed`; no MP3 is returned.

**What "the MP3 has the target duration" means.** An MP3 stores whole 576-sample frames, and the
encoder adds a delay (1105 samples including the decoder delay) at the start and padding at the
end. The Xing/Info header records them, so a gapless-aware decoder returns exactly the encoded
PCM. Measured on the final files: FFmpeg's decoder output and the header formula equal the target
sample for sample, and Chromium reports `HTMLAudioElement.duration` of exactly 8, 17, 26, 360 s
for the files checked, with a Web Audio decode of 8 s giving 384,000 frames at 48 kHz.
ffprobe's `format.duration` is **not** reliable for this: FFmpeg 9.0 reports the target, while
6.1 and 7.1 report the target plus delay and padding (+48 to +64 ms). It is recorded as
`mp3_container_seconds` but not used to accept or reject. **Limit:** a player that ignores the
header (some old or embedded players) plays the full frames: up to about 50-70 ms more than the
target, split between a silent start and the end. That is a property of MP3, not of the tempo
step; making it exact everywhere would need another format (WAV, or AAC with edit lists), an
API/format change that was not made (open decision).

**Technical limits (no product quota).** Any positive factor is realised, but quality drops at
extreme factors (WSOLA artefacts well beyond roughly 0.5-2x; a 600x slow-down is not pleasant).
The intermediate PCM is a WAV, whose sizes are 32-bit: targets over about 11 hours at 24 kHz fail
with `audio_duration_unsupported`. Work is bounded by timeouts (120 s + 0.5 s per audio second
for tempo/decode, 120 s + 0.1 s per second for encoding).

**Robustness.** FFmpeg/ffprobe run with an argument list (no shell), no stdin, a minimal
environment, a timeout, and the exit status checked; output is never logged. Every run can be
cancelled: `close()` at shutdown kills the process (`audio_cancelled`) and a timeout kills it
too (`audio_timeout`). Scratch files live in a directory removed in `finally`, and `final.mp3`
is deleted on any failure, so no partial result is stored. A missing FFmpeg, `atempo` filter or
`libmp3lame` encoder stops the service at startup. Without lossless audio
(`audio_source_missing`) there is no fallback to the pass-through. Logs contain counts only.

**Errors** (`ProcessingError` codes, safe messages): `audio_source_missing`,
`audio_input_invalid`, `audio_duration_unsupported`, `audio_duration_not_reached`,
`audio_verification_failed`, `audio_timeout`, `audio_cancelled`, `audio_processing_failed`.

**Result.** `audio.duration` (see [API.md](API.md)) reports, separately and unrounded, the
target, the natural source length, the processed PCM, and the final MP3 (decoded, header,
ffprobe container); the UI shows them next to the target and the actual duration.

**Measured** with `uv run python -m scripts.duration_smoke` (synthetic speech: four tones with
pauses; no credentials) on the production image's FFmpeg 7.1.5, in seconds:

| Case | Target | Source | PCM | MP3 decoded | MP3 header | Tempo | Pad (samples) |
|---|---|---|---|---|---|---|---|
| longer than target | 8 | 10.2 | 8.000000 | 8.000000 | 8.000000 | 1.27500 | 5 |
| shorter than target | 7 | 5.1 | 7.000000 | 7.000000 | 7.000000 | 0.72857 | 187 |
| nearly the target | 5 | 5.1 | 5.000000 | 5.000000 | 5.000000 | 1.02000 | 13 |
| equal to the target | 5 | 4.999833 | 5.000000 | 5.000000 | 5.000000 | none | 4 |
| three filters, faster | 4 | 20.4 | 4.000000 | 4.000000 | 4.000000 | 5.10468 | 61 |
| three filters, slower | 12 | 2.55 | 12.000000 | 12.000000 | 12.000000 | 0.21250 | 1998 |
| 370 s speech | 360 | 369.999875 | 360.000000 | 360.000000 | 360.000000 | 1.02778 | 10 |
| 350 s speech | 360 | 349.999792 | 360.000000 | 360.000000 | 360.000000 | 0.97222 | 70 |

(`--azure` repeats this with Azure speech: one request per voice with the public four-line
sample, 259 characters each, and writes before/after MP3s to listen to.) The same checks run in
CI (backend tests with FFmpeg 6.1, `docker/audio_runtime_check.py` inside the image).

**Content check.** The tests use a signal of four tones (a different pitch each) separated by
pauses: after fitting, all four are present, in order, each at its own pitch (a spectrum scan, not
zero crossings) and with the length expected from the factor within about one window, and the last
one still runs to the end of the audio (the only thing after it is the reported padding). Pitch of
a 440 Hz tone is unchanged at factors 0.1 to 10. On real Azure speech the last audible sample lands
within 300 samples (12 ms) of where the factor predicts, so the last sentence is not cut. These
checks cannot judge sound quality; the Product Owner listens.

### Audio speed

The user picks one of seven speeds (0.5, 0.75, 1, 1.25, 1.5, 1.75, 2; default 1) under the two
timestamps. It changes the **file** that is generated and downloaded:

```
baseline_seconds = last_sentence_start - first_sentence_start      (whole seconds)
target_samples   = round_half_up(baseline_seconds * sample_rate / speed)
actual duration  = target_samples / sample_rate
```

`audio/speed.py` holds this arithmetic. Each speed is an exact number of hundredths (`AudioSpeed`
values 50 ... 200), so the target is computed with integers only, and half-up is the one rounding
rule (documented and tested; `round` is not used). Timestamps stay whole seconds; only the output
can be fractional, and it is carried as samples through the pipeline (`DurationTarget` ->
`FfmpegAudioProcessor` -> `DurationReport`), never rounded to whole seconds.

Decisions:

- **1x is the baseline, not Azure's natural speed.** 1x keeps matching the video's time span between
  the two timestamps; other speeds make the audio shorter or longer than that span. This is an
  intentional extension of the original requirement (the output no longer always equals the
  baseline); the UI says so next to the preview.
- **One fitting step.** The processor reads Azure's original WAV and fits it straight to the new
  `target_samples` (`tempo = source_samples / target_samples`). The speed is never multiplied onto a
  tempo that already fitted the baseline, so there is no double stretch and one MP3 encode. Pitch, one
  voice and all words are kept, and the PCM, decoded-MP3 and gapless-header checks, the rule against
  cutting speech and the absence of silent fallbacks are unchanged. The earlier FFmpeg test matrix is
  not repeated; the tests add the seven-speed table, fractional targets and content checks.
- **The server decides.** `speed` is validated server-side against exactly seven JSON numbers (no
  booleans, strings, null or other numbers); a missing value is 1x. The output length is computed
  from the stored timestamps and speed, never read from the request.
- **Stored with the job.** `jobs.audio_speed_percent` (smallint, `NOT NULL DEFAULT 100`, CHECK in the
  seven values; migration `0003`). The baseline stays in `jobs.target_duration_seconds` with its old
  meaning (the API keeps `target_duration_seconds` as the baseline and adds
  `baseline_duration_seconds`, `speed`, `output_duration_seconds`), so no existing field changed
  meaning. The result's `audio.duration` additionally carries `baseline_seconds` and `speed`; its
  `target_seconds` is the output target (a float, equal to the baseline at 1x). The UI shows the
  server's snapshot for the job, so changing the form afterwards cannot relabel an old job.
- **Compatibility.** Rows from older code read as 100 (1x) through the column default, which also
  covers rows that older code inserts while a deploy overlaps or after an emergency rollback;
  stored results without `speed` in their report are returned as 1x; old jobs remain readable.
- **Player.** The file is already processed, so the player keeps `playbackRate` 1 (applying the
  speed again would double it).
- **Mock mode.** The speed is recorded and shown, but the fixture is not adjusted and the result says
  so (`duration_adjusted: false`); no fixture claims a real duration.

**MP3 end padding at fractional targets.** FFmpeg's MP3 muxer writes at most 1105 samples of end
padding. At 24 kHz an MP3 frame is 576 samples, and when a target is 1-46 samples over a whole
number of frames the encoder emits one frame more than the audio fills; the padding then exceeds
the cap and the header (and every gapless decoder) plays up to 46 samples (1.9 ms) too many.
Whole-second targets are always 0, 192 or 384 samples over, so this never showed before speeds
existed; about 8% of fractional targets hit it (measured on FFmpeg 6.1 and 7.1.5, e.g. a
68,571-sample target decoded to 68,591). The fitter repairs that case and only that case:

1. **Signature** (`capped_padding_excess`, `audio/mp3_header.py`), all of: 24 kHz, 576 samples per
   frame, encoder delay 576, stored padding exactly 1105, and the header over-claiming 1-46
   samples relative to the **measured** PCM sample count handed to the encoder (never a wished-for
   target). Any other difference, however small (for example padding 960 and one sample off), is
   not repaired: the file is left unchanged and the normal verification judges it (one sample of
   rounding at most, as before), so it fails.
2. **Silence**: the MP3 is decoded first, and the over-claimed samples must be silent by the same
   rule that allows trimming in `conform_wav` (each at most 32/32768). The header cannot tell padding
   from audio, so a repair can never stop audible audio from playing; a wrong encode whose header
   happens to look like the defect fails instead. Azure speech ends with about 300 ms of silence,
   so real jobs pass; audio that is loud up to its very last sample fails in this case.
3. **Rewrite**: `set_exact_padding` sets the 12-bit padding to `frames x 576 - delay - samples` and
   recomputes the LAME tag CRC (CRC-16, reflected 0xA001, over the first 190 bytes with the CRC
   bytes zeroed, checked against files FFmpeg wrote); it refuses a stored CRC it cannot reproduce.
   Audio frames are never touched. Then the decoded and header lengths are verified as before.

The amount is reported as `mp3_padding_adjusted_samples`. The limit for players that ignore the
header is unchanged (up to about 50-70 ms longer).

**Limits that remain.** An MP3 or a player that ignores the gapless header plays up to about 50-70 ms
more than the target, as before. Extreme speeds relative to the natural speech (for example 0.5x of
audio that was already much shorter than the baseline) mean large tempo factors, and quality drops
well beyond roughly 0.5-2x overall, as described under "Duration fitting". At 0.5x the filter's
window rounding can add up to about 85 ms of silence at the end (reported as `padded_samples`).

### Milestone 3 (real providers)

Milestone 3A (translation) is described above; the remaining items below still apply to
Azure Speech and FFmpeg.

**Azure Translator (F0)** - implemented in Milestone 3A (see above). Remaining: a live
quality evaluation with real course transcripts, and a decision whether to migrate to API
`2026-06-06` or add an LLM-based provider if the quality of F0 NMT is not good enough.

**Azure Speech (F0)** - implemented in Milestone 3B (see "Azure Speech" above). Remaining:
the Product Owner's listening evaluation of mixed Vietnamese/English pronunciation.

**Audio processing (FFmpeg)** - implemented in Milestone 3C (see "Duration fitting") and accepted
by the Product Owner on production.

**Production with real providers**
- Disclosure that submitted text is processed by Azure: done for translation (3A) and speech
  (3B); the wording follows the configured providers.
- Production configuration with Azure credentials (`PROVIDER_MODE=azure`); missing
  credentials must fail startup, never fall back to mocks.
