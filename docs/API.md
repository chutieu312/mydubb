# MyDubb API (Milestone 1)

All endpoints are under `/api` on the same origin as the web app. Request and response bodies
are JSON unless noted.

## Conventions

**Errors** always have this shape (no stack traces or internal details):

```json
{ "error": { "code": "validation_error", "message": "…", "fields": [{ "field": "voice", "message": "…" }] } }
```

`fields` is present only for `validation_error`; some errors add fields such as
`retry_after_seconds` or `job_error_code`.

**Authentication**: an HttpOnly `mydubb_session` cookie (`SameSite=Strict`, `Secure` when
`COOKIE_SECURE=true`) established by `POST /api/session`.

**CSRF**: state-changing requests made with a session (`POST /api/jobs`, `DELETE /api/session`)
must send `X-CSRF-Token` with the token returned by `POST`/`GET /api/session`. In addition, any
`POST/PUT/PATCH/DELETE` with an `Origin` header that is neither the request's own host nor in
`TRUSTED_ORIGINS` is rejected (`403 origin_rejected`).

**Body size**: state-changing requests above `MAX_REQUEST_BODY_BYTES` (default 10 MB) get
`413 request_too_large`; chunked bodies without `Content-Length` get `411 length_required`.

## System

| Method & path | Auth | Response |
|---|---|---|
| `GET /api/health` | none | `200 {"status":"ok"}` — process liveness, no dependency checks |
| `GET /api/ready` | none | `200 {"status":"ready","checks":{"database":"ok"}}` or `503 {"status":"not_ready","checks":{"database":"unavailable"}}` |
| `GET /api/meta` | none | Non-sensitive UI config: `provider_mode`, `mock_mode` (true while any component is mock), `providers` (`{translation, speech, audio}`; `translation` and `speech` are `mock` or `azure`, `audio` is `mock` until Milestone 3C), `voices[] {id, label, provider_voice, description}` (the first one is the default), `timestamp_format`, `result_ttl_seconds` |

## Session (Private Beta access)

### `POST /api/session`
Body `{"access_code": "…"}`.
- `200 {"authenticated": true, "csrf_token": "…", "expires_at": "<ISO 8601>"}` + `Set-Cookie`.
- `401 invalid_access_code`.
- `429 too_many_attempts` with `Retry-After` (seconds) after too many failed attempts from a
  client (`ACCESS_MAX_FAILURES_PER_CLIENT`) or overall (`ACCESS_MAX_FAILURES_GLOBAL`) within
  `ACCESS_FAILURE_WINDOW_SECONDS`.

### `GET /api/session`
`200` same body as above, or `401 not_authenticated` (missing, unknown, expired or logged-out).

### `DELETE /api/session`
Requires session + CSRF. `204`, revokes the session server-side and clears the cookie.

## Jobs

Voices (API values): `AndrewMultilingual` ("Andrew Multilingual") →
`en-US-AndrewMultilingualNeural` and `EmmaMultilingual` ("Emma Multilingual") →
`en-US-EmmaMultilingualNeural`. `voice` is optional and defaults to `AndrewMultilingual`; any
other value, including the former `HoaiMy` and `NamMinh`, is rejected with
`422 validation_error` (field `voice`). A job created before this change keeps its stored voice
name: `GET /api/jobs/{id}` and its result still work and return that name (e.g. `HoaiMy`) in
`voice`, which clients must treat as an opaque string.

### `POST /api/jobs`
Requires session + CSRF.

```json
{
  "transcript": "English text, with or without timestamps",
  "first_sentence_start": "00:00:10",
  "last_sentence_start": "00:06:10",
  "voice": "AndrewMultilingual"
}
```

Validation (backend is authoritative):
- Timestamps: `HH:MM:SS`; hours ≥ 2 digits (may be more), minutes/seconds `00–59`.
- `last_sentence_start` must be later than `first_sentence_start`.
- Transcript must contain text after removing timing markup. Formats are recognized from
  the structure of the whole transcript and ambiguous tokens are kept as spoken content:
  - WebVTT: header, NOTE/STYLE/REGION blocks, cue identifiers, timing lines, inline tags.
  - SRT / cue timing lines (`00:00:01,000 --> 00:00:04,000`) and their numeric indices.
  - Bracketed stamps (`[00:01:02] text`, `(0:05) text`, `[01:10]` alone).
  - Standalone timestamp lines, only when there are two or more in non-decreasing order.
  - Unbracketed `H:MM:SS text` prefixes, only when two or more lines carry them in
    non-decreasing order.
  - Preserved: unbracketed `M:SS`/`HH:MM` prefixes such as `10:30 is our meeting time.` or
    `16:30 is the aspect ratio.`, single or out-of-order timestamps, and numeric lines.
  See `backend/app/transcript/cleaning.py` for the authoritative rules.
- Target duration = last start − first start (e.g. `00:00:10` → `00:06:10` = **360 s**).

Responses:
- `202` + `Location: /api/jobs/{id}` + a Job body (status `queued`). Returned immediately; work
  runs in the background.
- `422 validation_error` with `fields`.
- `503 server_at_capacity` + `Retry-After` when running + queued jobs are at
  `JOB_MAX_CONCURRENCY + JOB_MAX_QUEUED`.
- `401` / `403` for missing session / CSRF.

### `GET /api/jobs/{id}`
Requires session. Returns the Job body. `404 job_not_found` if the job does not exist **or
belongs to another session** (indistinguishable by design).

```json
{
  "id": "uuid",
  "status": "queued | translating | synthesizing | processing | completed | failed",
  "voice": "AndrewMultilingual",
  "first_sentence_start": "00:00:10",
  "last_sentence_start": "00:06:10",
  "target_duration_seconds": 360,
  "target_duration": "00:06:00",
  "created_at": "…", "updated_at": "…",
  "completed_at": null,
  "result_expires_at": null,
  "error": null
}
```

`error` is `{"code","message"}` when failed. Codes: `translation_failed` (mock),
`speech_failed`, `audio_processing_failed`, `internal_error`, `interrupted`, and for Azure
Translator: `translation_auth_failed`, `translation_quota_exceeded`, `translation_timeout`,
`translation_network_error`, `translation_service_error`, `translation_rejected`,
`translation_invalid_response`, `translation_terms_not_preserved`,
`translation_input_unsupported`; and for Azure Speech: `speech_auth_failed`,
`speech_quota_exceeded`, `speech_timeout`, `speech_network_error`, `speech_service_error`,
`speech_rejected`, `speech_invalid_audio`, `speech_audio_failed`, `speech_cancelled`,
`speech_input_unsupported`, `speech_no_speakable_text`. Messages are safe to show (no keys, transcript text or raw
provider output). Failed jobs are never retried automatically; submit again.

### `GET /api/jobs/{id}/result`
Requires session and ownership.
- `200`:
  ```json
  {
    "job_id": "uuid",
    "translation": { "text": "…", "is_illustrative": true, "provider": "mock-translation" },
    "audio": {
      "url": "/api/jobs/{id}/result/audio",
      "download_url": "/api/jobs/{id}/result/audio?download=1",
      "content_type": "audio/mpeg",
      "provider": "mock-speech",
      "is_fixture": true,
      "duration_adjusted": false
    },
    "expires_at": "…",
    "notices": ["…"]
  }
  ```
  `translation.provider` is `azure-translator` (with `is_illustrative: false`) for a real
  translation and `mock-translation` for the mock; `audio.provider` is `azure-speech` (with
  `is_fixture: false`) for real speech and `mock-speech` for the fixture. `duration_adjusted`
  stays `false` until Milestone 3C. `notices` states what is real, what is a fixture and that the
  audio length is not adjusted to the target.
- `409 result_not_ready` (still running) or `409 job_failed` (with `job_error_code`).
- `410 result_expired` — the job completed but its temporary result expired or was removed
  (TTL elapsed, cleanup, or restart on an ephemeral disk).
- `404 job_not_found`, `401 not_authenticated`.

### `GET /api/jobs/{id}/result/audio[?download=1]`
Same authorization and error rules. Streams `audio/mpeg` (supports HTTP Range).
`Content-Disposition: inline` by default, `attachment` with `download=1`.
