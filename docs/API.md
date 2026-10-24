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

**Authentication** depends on `AUTH_MODE` (reported as `auth.mode` by `GET /api/meta`):

- `access_code` (default, production today): an HttpOnly `mydubb_session` cookie (`SameSite=Strict`,
  `Secure` when `COOKIE_SECURE=true`) established by `POST /api/session` (below).
- `cognito`: an HttpOnly `mydubb_auth` cookie established by the email/password endpoints under
  `/api/auth`, documented in [AUTH_API.md](AUTH_API.md). `/api/session` does not exist in this mode,
  and an Access Code session is never accepted.

Everything below about CSRF, jobs and errors applies to both session kinds.

**CSRF**: state-changing requests made with a session (`POST /api/jobs`, `DELETE /api/session`,
`POST /api/auth/logout`) must send `X-CSRF-Token` with the token returned by `POST`/`GET
/api/session` (Access Code) or by the `authenticated` response / `GET /api/auth/me` (Cognito). In addition, any
`POST/PUT/PATCH/DELETE` with an `Origin` header that is neither the request's own host nor in
`TRUSTED_ORIGINS` is rejected (`403 origin_rejected`).

**Body size**: state-changing requests above `MAX_REQUEST_BODY_BYTES` (default 10 MB) get
`413 request_too_large`; chunked bodies without `Content-Length` get `411 length_required`.

## System

| Method & path | Auth | Response |
|---|---|---|
| `GET /api/health` | none | `200 {"status":"ok"}` — process liveness, no dependency checks |
| `GET /api/ready` | none | `200 {"status":"ready","checks":{"database":"ok"}}` or `503 {"status":"not_ready","checks":{"database":"unavailable"}}` |
| `GET /api/meta` | none | Non-sensitive UI config: `provider_mode`, `mock_mode` (true while any component is mock), `providers` (`{translation, speech, audio}`; `translation` and `speech` are `mock` or `azure`, `audio` is `mock` or `ffmpeg`; `provider_mode` is `azure` only when every component is real, otherwise `mock`, and `mock_mode` is its inverse), `voices[] {id, label, provider_voice, description}` (the first one is the default), `timestamp_format`, `result_ttl_seconds`, `auth {mode, self_registration, password_reset}` (`mode` is `access_code` or `cognito` and selects the login UI; `self_registration` is always `false`; see [AUTH_API.md](AUTH_API.md)) |

## Session (Private Beta access)

Only with `AUTH_MODE=access_code`. For `AUTH_MODE=cognito` see [AUTH_API.md](AUTH_API.md).

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
  "voice": "AndrewMultilingual",
  "speed": 1.25
}
```

`speed` is optional and is the **audio speed**: the generated and downloaded file lasts
`baseline / speed`, where the baseline is `last_sentence_start - first_sentence_start`. See
[Audio speed](#audio-speed).

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
- Baseline duration = last start − first start (e.g. `00:00:10` → `00:06:10` = **360 s**).
- `speed`: exactly one of the JSON numbers `0.5`, `0.75`, `1`, `1.25`, `1.5`, `1.75`, `2`
  (`1` and `1.0` are the same). Omitted means `1`, which is the behaviour before the option
  existed. `null`, booleans, strings (`"1.5"`), lists, other numbers (`1.1`, `1.2500001`, `0`,
  `3`) and non-finite values are rejected with `422 validation_error` (field `speed`). The output
  length is never taken from the client; a field such as `output_duration_seconds` is ignored.

### Audio speed

`speed` changes the audio **file** that is produced and downloaded; it is not a player setting.

| Speed | Output for a 20 s baseline | Target samples at 24 kHz |
|---|---|---|
| 0.5 | 40 s | 960,000 |
| 0.75 | 26.67 s | 640,000 |
| 1 | 20 s | 480,000 |
| 1.25 | 16 s | 384,000 |
| 1.5 | 13.33 s | 320,000 |
| 1.75 | 11.43 s | 274,286 |
| 2 | 10 s | 240,000 |

- `1` means "fitted to the baseline", the same as before; it is **not** the natural speed Azure
  returned (that is shorter or longer than the baseline and is stretched to fit it).
- Target length in samples: `round_half_up(baseline_seconds * sample_rate / speed)`, computed with
  integers (each speed is an exact number of hundredths), so no float error accumulates. Half-up is
  the one rounding rule everywhere (Python's `round` is not used). The actual length is
  `target_samples / sample_rate`; the planned (unrounded) length and the actual one differ by half
  a sample at most. Timestamps stay whole seconds; only the output length can be fractional.
- The audio is fitted **directly** from Azure's original lossless audio to the target
  (`tempo = source_samples / target_samples`); it is not fitted to the baseline first and sped up
  again. Pitch, the single voice and every spoken word are preserved (see ARCHITECTURE.md).
- The choice is stored with the job (`jobs.audio_speed_percent`) and repeated in the job and the
  result, so reloading shows what the job was submitted with, whatever the form says now.
- With the mock audio processor the choice is recorded and reported, but the fixture is **not**
  adjusted (`duration_adjusted: false`, `audio.duration: null`), and a notice says so.
- Players must keep `playbackRate = 1`: the file is already processed, so applying the speed
  again would play it twice as fast/slow.

Responses:
- `202` + `Location: /api/jobs/{id}` + a Job body (status `queued`). Returned immediately; work
  runs in the background.
- `422 validation_error` with `fields`.
- `503 server_at_capacity` + `Retry-After` when running + queued jobs are at
  `JOB_MAX_CONCURRENCY + JOB_MAX_QUEUED`.
- `401` / `403` for missing session / CSRF.

### `GET /api/jobs/{id}`
Requires session. Returns the Job body. `404 job_not_found` if the job does not exist **or
belongs to someone else** (indistinguishable by design). The owner is taken from the session, never
from the request: with the Access Code it is the session; in Cognito mode it is the signed-in user
(any of the user's sessions sees the user's jobs, and Access Code-era jobs are visible to no user).
The same rule applies to the result and audio endpoints below.

```json
{
  "id": "uuid",
  "status": "queued | translating | synthesizing | processing | completed | failed",
  "voice": "AndrewMultilingual",
  "first_sentence_start": "00:00:10",
  "last_sentence_start": "00:06:10",
  "target_duration_seconds": 360,
  "target_duration": "00:06:00",
  "baseline_duration_seconds": 360,
  "speed": 1.25,
  "output_duration_seconds": 288.0,
  "created_at": "…", "updated_at": "…",
  "completed_at": null,
  "result_expires_at": null,
  "error": null
}
```

`target_duration_seconds` / `target_duration` keep their original meaning, the **baseline**
(last − first sentence start); they do not depend on `speed`, and `baseline_duration_seconds` is the
same number under a clearer name. `speed` is the value submitted (`1` for jobs created before the
option existed). `output_duration_seconds` is the planned length, `baseline / speed`, unrounded
(a float, e.g. `26.666666666666668` for baseline 20 and speed 0.75); the sample-exact target and the
verified length are in the result.

`error` is `{"code","message"}` when failed. Codes: `translation_failed` (mock),
`speech_failed`, `audio_processing_failed`, `internal_error`, `interrupted`, and for Azure
Translator: `translation_auth_failed`, `translation_quota_exceeded`, `translation_timeout`,
`translation_network_error`, `translation_service_error`, `translation_rejected`,
`translation_invalid_response`, `translation_terms_not_preserved`,
`translation_input_unsupported`; and for Azure Speech: `speech_auth_failed`,
`speech_quota_exceeded`, `speech_timeout`, `speech_network_error`, `speech_service_error`,
`speech_rejected`, `speech_invalid_audio`, `speech_audio_failed`, `speech_cancelled`,
`speech_input_unsupported`, `speech_no_speakable_text`; and for FFmpeg audio processing:
`audio_source_missing`, `audio_input_invalid`, `audio_duration_unsupported`,
`audio_duration_not_reached`, `audio_verification_failed`, `audio_timeout`, `audio_cancelled`,
`audio_processing_failed`. Messages are safe to show (no keys, transcript text or raw
provider output). Failed jobs are never retried automatically; submit again.

### `GET /api/jobs/{id}/result`
Requires session and ownership.
- `200`:
  ```json
  {
    "job_id": "uuid",
    "baseline_duration_seconds": 360,
    "speed": 1.25,
    "output_duration_seconds": 288.0,
    "translation": { "text": "…", "is_illustrative": true, "provider": "mock-translation" },
    "audio": {
      "url": "/api/jobs/{id}/result/audio",
      "download_url": "/api/jobs/{id}/result/audio?download=1",
      "content_type": "audio/mpeg",
      "provider": "mock-speech",
      "is_fixture": true,
      "duration_adjusted": false,
      "duration": null
    },
    "expires_at": "…",
    "notices": ["…"]
  }
  ```
  `translation.provider` is `azure-translator` (with `is_illustrative: false`) for a real
  translation and `mock-translation` for the mock; `audio.provider` is `azure-speech` (with
  `is_fixture: false`) for real speech and `mock-speech` for the fixture. `duration_adjusted`
  is `true` only when FFmpeg audio processing made the audio last exactly the target (then
  `duration` is set, see below); with the mock processor it is `false` and `duration` is `null`.
  `notices` states what is real, what is a fixture and whether the audio length is adjusted.

  With `AUDIO_PROCESSOR=ffmpeg`, `audio.duration` holds what was **measured** on the real files
  (nothing is rounded: seconds are `samples / sample_rate`):
  ```json
  "duration": {
    "sample_rate": 24000,
    "target_seconds": 360.0, "target_samples": 8640000,
    "baseline_seconds": 360, "speed": 1.0,
    "source_seconds": 370.123458, "source_samples": 8882963,
    "processed_seconds": 360.0, "processed_samples": 8640000,
    "mp3_decoded_seconds": 360.0, "mp3_decoded_samples": 8640000,
    "mp3_header_seconds": 360.0, "mp3_header_samples": 8640000,
    "mp3_container_seconds": 360.048,
    "tempo_factor": 1.02812, "padded_samples": 70, "trimmed_samples": 0,
    "mp3_padding_adjusted_samples": 0
  }
  ```
  `target` is the **output target**, `baseline / speed` rounded to a whole sample
  (`target_samples / sample_rate`; a float, equal to the baseline at speed 1, which is why the
  example is 360.0); `baseline_seconds` and `speed` are the inputs it came from. `source` the natural length of the speech;
  `processed` the PCM after the tempo change (equal to the target); `mp3_decoded` the samples a
  decoder yields for the final MP3 and `mp3_header` the length its own gapless header declares
  (both within one sample of the target, or the job fails). `mp3_container_seconds` is
  ffprobe's figure as is: depending on the FFmpeg version it is the target or the target plus
  the encoder delay and padding (tens of milliseconds); it is not used to accept the file.
  `tempo_factor` is above 1 when the speech was sped up and below 1 when it was slowed down
  (`null`: it was already within one rounding window of the target); `padded_samples` /
  `trimmed_samples` are silence added to or removed from the end (never audible audio).
  `mp3_padding_adjusted_samples` is non-zero when the MP3 header's end padding had to be corrected
  (FFmpeg caps it at 1105 samples, which leaves the header up to 46 samples too long for some
  fractional targets; see ARCHITECTURE.md); 0 means the encoder's header was already exact.
  A stored result written before `speed` existed (no `speed` in its report) is returned with
  `speed: 1` and `baseline_seconds` equal to its target.
- `409 result_not_ready` (still running) or `409 job_failed` (with `job_error_code`).
- `410 result_expired` — the job completed but its temporary result expired or was removed
  (TTL elapsed, cleanup, or restart on an ephemeral disk).
- `404 job_not_found`, `401 not_authenticated`.

### `GET /api/jobs/{id}/result/audio[?download=1]`
Same authorization and error rules. Streams `audio/mpeg` (supports HTTP Range).
`Content-Disposition: inline` by default, `attachment` with `download=1`.
