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

- Guest (`GUEST_ACCESS_ENABLED=true`, Cognito mode only): an HttpOnly `mydubb_guest` cookie from
  `POST /api/guest/session` ([Guest access](#guest-access)). It is accepted **only** by the job
  endpoints, `POST /api/transcripts/youtube` (with its own import quota) and `/api/guest/session`;
  every other endpoint treats a guest as not signed in. With both an account and a guest cookie,
  the job endpoints and the import use the account.

**CSRF**: state-changing requests made with a session (`POST /api/jobs`,
`POST /api/transcripts/youtube`, `DELETE /api/session`, `POST /api/auth/logout`,
`DELETE /api/guest/session`) must send `X-CSRF-Token` with the token returned by `POST`/`GET
/api/session` (Access Code), by the `authenticated` response / `GET /api/auth/me` (Cognito) or by
`POST`/`GET /api/guest/session` (guest). In addition, any
`POST/PUT/PATCH/DELETE` with an `Origin` header that is neither the request's own host nor in
`TRUSTED_ORIGINS` is rejected (`403 origin_rejected`).

**Body size**: state-changing requests above `MAX_REQUEST_BODY_BYTES` (default 10 MB) get
`413 request_too_large`; chunked bodies without `Content-Length` get `411 length_required`.

## System

| Method & path | Auth | Response |
|---|---|---|
| `GET /api/health` | none | `200 {"status":"ok"}` — process liveness, no dependency checks |
| `GET /api/ready` | none | `200 {"status":"ready","checks":{"database":"ok"}}` or `503 {"status":"not_ready","checks":{"database":"unavailable"}}` |
| `GET /api/meta` | none | Non-sensitive UI config: `provider_mode`, `mock_mode` (true while any component is mock), `providers` (`{translation, speech, audio}`; `translation` and `speech` are `mock` or `azure`, `audio` is `mock` or `ffmpeg`; `provider_mode` is `azure` only when every component is real, otherwise `mock`, and `mock_mode` is its inverse), `voices[] {id, label, provider_voice, description}` (the first one is the default), `target_languages[] {id, label, noun, translator_language, speech_locale}` (the output languages a job can choose, in the order to offer them; `id` is the only value a request sends, the codes are informative) and `default_target_language` (`vietnamese`; see [Target language](#target-language)), `timestamp_format`, `result_ttl_seconds`, `auth {mode, self_registration, password_reset}` (`mode` is `access_code` or `cognito` and selects the login UI; `self_registration` is always `false`; see [AUTH_API.md](AUTH_API.md)), `youtube_import {enabled, provider}` (`enabled` is `false` and `provider` `null` with `YOUTUBE_IMPORT_PROVIDER=off`; otherwise `provider` is `supadata` or `mock`; see [YouTube caption import](#youtube-caption-import)), `guest_access` (`{"enabled": false}`, or with guest access on `{enabled: true, jobs_per_session, jobs_per_ip, ip_window_seconds, max_words, max_output_seconds, session_ttl_seconds, imports_per_session, imports_per_ip}`; the import fields only matter when `youtube_import.enabled`; see [Guest access](#guest-access)) |

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
  "target_language": "vietnamese",
  "speed": 1.25
}
```

`target_language` is optional: the language the English transcript is translated into and read
in. `"vietnamese"` (the default, the behaviour before the option existed) or
`"mandarin_simplified"` (Chinese, Mandarin, Simplified script). See
[Target language](#target-language).

`speed` is optional and is the **audio speed**: the generated and downloaded file lasts
`baseline / speed`, where the baseline is `last_sentence_start - first_sentence_start`. See
[Audio speed](#audio-speed).

`timing_mode` is optional: `"plain"` (the default, the behaviour before the option existed) or
`"timed"`, which uses the caption times of a timestamped transcript to place the speech on the
timeline. See [Timed transcripts](#timed-transcripts-timing_mode-timed).

Validation (backend is authoritative):
- Timestamps: `HH:MM:SS`; hours ≥ 2 digits (may be more), minutes/seconds `00–59`.
- `last_sentence_start` must be later than `first_sentence_start`.
- How the UI helps to fill these fields: [Timestamp fields in the UI](#timestamp-fields-in-the-ui).
  It never changes what the backend accepts.
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
  See `backend/app/transcript/cleaning.py` for the authoritative rules. These cleaning rules
  apply to plain mode; timed mode parses the timestamps instead (see below).
- Baseline duration = last start − first start (e.g. `00:00:10` → `00:06:10` = **360 s**).
- `speed`: exactly one of the JSON numbers `0.5`, `0.75`, `1`, `1.25`, `1.5`, `1.75`, `2`
  (`1` and `1.0` are the same). Omitted means `1`, which is the behaviour before the option
  existed. `null`, booleans, strings (`"1.5"`), lists, other numbers (`1.1`, `1.2500001`, `0`,
  `3`) and non-finite values are rejected with `422 validation_error` (field `speed`). The output
  length is never taken from the client; a field such as `output_duration_seconds` is ignored.
- `target_language`: exactly `"vietnamese"` or `"mandarin_simplified"`. Omitted means
  `"vietnamese"`. Anything else (`null`, `"zh-Hans"`, `"zh-CN"`, `"vi"`, `"Vietnamese"`,
  `"cantonese"`, numbers, lists) is rejected with `422 validation_error` (field `target_language`)
  before any job, quota place or provider call. Provider codes, locales, endpoints or provider voice
  names are never taken from the client; fields such as `translator_language` or `speech_locale`
  are ignored.

### Target language

The input is always English; each job has exactly one output language, chosen at submission and
stored with the job (`jobs.target_language`, migration `0009`).

| API value | Label (`/api/meta`) | Azure Translator `to` | Azure Speech `<lang xml:lang>` |
|---|---|---|---|
| `vietnamese` (default) | Vietnamese | `vi` | `vi-VN` |
| `mandarin_simplified` | Chinese — Mandarin (Simplified) | `zh-Hans` | `zh-CN` |

- The mapping is fixed on the server (`backend/app/languages.py`, checked against Microsoft Learn on
  2026-10-29). A Translator answer in another language than the one asked for is rejected
  (`translation_invalid_response`).
- Both languages use the same two voices (Andrew and Emma Multilingual), one voice per speech
  request; glossary terms and English kept by the translation are read with `en-US`, the rest with
  the language's locale. Mandarin has its own chunking (Chinese has no spaces) and its own
  syllable estimate for the timed-mode checks; Vietnamese is unchanged.
- The language is the job's own: `GET /api/jobs/{id}` and its result always report the stored
  value. Jobs created before the option existed read as `vietnamese`. A failure in Mandarin fails
  the job; nothing is retried or falls back to Vietnamese or to the mock.
- Mock mode: the mock translation names the language it stands in for ("NOT a real Mandarin
  Chinese (Simplified) translation"); the mock audio is a chime in every language.
- Guests and invitation accounts have the same choice; a guest job counts once whatever its
  language, and the guest word limit counts the English text.

### Timestamp fields in the UI

The API and its validation are unchanged; the two start time fields only help to type the format.
The request still carries the text of the field as `HH:MM:SS`, and the server decides what is valid.

- The user types digits and the UI groups them in pairs: `000001` -> `00:00:01`, `010530` ->
  `01:05:30`. While typing, `00`, `000`, `0000`, `00000` show `00`, `00:0`, `00:00`, `00:00:0`.
  Nothing is padded, completed, clamped or reordered, and `00:75:00` or `00:01:75` is not turned
  into an hour or a minute: it stays as typed and the server rejects it. An incomplete value is sent
  as it is and reported through the usual field error.
- The field is a text input with `inputmode="numeric"` (not `type="number"`, which would drop the
  leading zeros and the colons). A typed colon is ignored because colons are automatic; letters and a
  seventh digit are not accepted.
- Backspace and Delete next to a colon remove the neighbouring digit, so a colon that reappears can
  never trap the caret. The caret stays at the edit, also for edits in the middle and selections.
- Paste accepts `000001` and `00:00:01` (surrounding whitespace is ignored). Any other pasted text,
  for example `abc00:00:01`, `1:02:03`, `00.00.01` or seven digits without colons, is kept exactly
  as pasted, never repaired into a timestamp, and is reported by the server on submit.
- Hours with more than two digits are valid (see Validation above), and a digit string cannot say
  where the hours end, so such values are not split automatically. They can be pasted as
  `100:05:30`, or made by typing a digit into the hours of a complete timestamp. A value that is not
  in the auto format is edited exactly as typed (no regrouping) until only digits are left in the
  field, when the auto format applies again.
- The code is `frontend/src/lib/timestampInput.ts` (rules, no DOM) and
  `frontend/src/features/dubbing/TimestampInput.tsx` (the field).

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

### Timed transcripts (`timing_mode: "timed"`)

With `"timed"`, the transcript must have the YouTube transcript-panel structure: a timestamp alone
on a line (`M:SS`, `MM:SS`, `H:MM:SS` or `HH:MM:SS`, whole seconds, optionally with a dot and 1-3
millisecond digits as in the [timestamped transcript format](#timestamped-transcript-format) the
YouTube caption import writes) followed by the caption text, repeated. Caption starts are kept
exact to the millisecond; the two time fields stay `HH:MM:SS`, and the UI fills them with the first
and last caption start truncated to whole seconds (the import's own suggestions; empty when both
fall in the same second). The rules are in `backend/app/transcript/timed.py` and ARCHITECTURE.md
("Timed dubbing").

- **Validation** (`422 validation_error`, field `transcript`, with the reason): fewer than two
  standalone timestamps, a malformed one (`0:75`, `1:2:03`, `0:05.5`), text before the first
  timestamp, a timestamp without caption text, timestamps that go backwards, or a last caption that
  starts at the first one's time. Nothing is guessed and the request is **not** processed as plain
  text instead; the client sends `"plain"` (or omits the field) to do that.
- **Baseline.** The two time fields are still required and validated as above. The UI fills them
  from the first and last **caption** timestamps (`source_first`, `source_last`), whatever block
  the last caption ends up in; no time is added for the last words. The baseline used is what the
  fields say: if the user changes them, every caption position is scaled into that span
  (`position_ratio = (source_position - source_first) / source_baseline`,
  `output_position = position_ratio * selected_baseline / speed`). Changing the fields never drops
  text. The output length is the same as in plain mode: `round_half_up(baseline * rate / speed)`.
- **Estimated timing.** Captions are joined into sentences; a sentence that starts inside a caption
  gets a time interpolated by word count. Sentences whose speech needs more than 2x tempo in their
  span are grouped with a neighbour and share one span. Timing is therefore estimated and
  group-level, not exact per sentence; see the limits in ARCHITECTURE.md.
- **SRT and WebVTT** are accepted only in plain mode for now (their timing is removed by cleaning,
  as before); with `"timed"` they are rejected like any transcript without the structure.
- With mock speech (and the mock audio processor), a timed job completes with the fixture and the
  `timing` summary, but nothing is placed on a timeline (`timing.frames` is `null`).
- With real speech and the mock audio processor (`SPEECH_PROVIDER=azure`, `AUDIO_PROCESSOR=mock`)
  timed mode is unavailable: real speech is one clip per block, which only FFmpeg processing can
  place and join, so the request is refused with `409 timing_mode_unavailable` before any job is
  created or provider called (never a job that completes with part of the speech). Plain mode works
  in that configuration as before. Production (`PROVIDER_MODE=azure`) always has FFmpeg.

Responses:
- `202` + `Location: /api/jobs/{id}` + a Job body (status `queued`). Returned immediately; work
  runs in the background.
- `422 validation_error` with `fields`.
- `409 timing_mode_unavailable` for `timing_mode: "timed"` when the server's audio processing
  cannot place timed speech (see above).
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
  "target_language": "mandarin_simplified",
  "target_language_label": "Chinese — Mandarin (Simplified)",
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
verified length are in the result. `target_language` is the stored output language
(`vietnamese` for jobs created before the option existed) and `target_language_label` its label.

`error` is `{"code","message"}` when failed. Codes: `translation_failed` (mock),
`speech_failed`, `audio_processing_failed`, `internal_error`, `interrupted`, and for Azure
Translator: `translation_auth_failed`, `translation_quota_exceeded`, `translation_timeout`,
`translation_network_error`, `translation_service_error`, `translation_rejected`,
`translation_invalid_response`, `translation_terms_not_preserved`,
`translation_input_unsupported`; and for Azure Speech: `speech_auth_failed`,
`speech_quota_exceeded`, `speech_timeout`, `speech_network_error`, `speech_service_error`,
`speech_rejected`, `speech_invalid_audio`, `speech_audio_failed`, `speech_cancelled`,
`speech_input_unsupported`, `speech_no_speakable_text`, `speech_block_split_failed` (timed mode:
a speech response did not pass the checks used to cut it into sentence blocks); and for FFmpeg
audio processing:
`audio_source_missing`, `audio_input_invalid`, `audio_duration_unsupported`,
`audio_duration_not_reached`, `audio_verification_failed`, `audio_timeout`, `audio_cancelled`,
`audio_processing_failed`, and `audio_timeline_unsupported` (a timed job reached the mock audio
processor with real speech clips; normally refused at submission). Messages are safe to show (no
keys, transcript text or raw provider output). Failed jobs are never retried automatically; submit
again.

### `GET /api/jobs/{id}/result`
Requires session and ownership.
- `200`:
  ```json
  {
    "job_id": "uuid",
    "target_language": "vietnamese",
    "target_language_label": "Vietnamese",
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

  A timed job's result also has `timing` (`null` for plain jobs and older results); it holds
  numbers only, no transcript text:
  ```json
  "timing": {
    "mode": "timed", "captions": 7, "blocks": 3,
    "source_first_seconds": 0, "source_last_seconds": 11, "source_baseline_seconds": 11,
    "selected_baseline_seconds": 11, "speech_requests": 1,
    "frames": 2, "removed_boundaries": 1, "tempo_warning_level": 2.0,
    "max_tempo_factor": 1.84, "frames_over_warning_level": 0,
    "estimated_max_displacement_seconds": 0.41,
    "frame_details": [
      { "first_block": 0, "last_block": 0, "start_seconds": 0.0, "frame_seconds": 4.142875,
        "audio_seconds": 6.9, "tempo_factor": 1.72, "padded_seconds": 0.04 }
    ]
  }
  ```
  `frames` are the spans of the output timeline after grouping (`removed_boundaries` block starts
  were merged into a neighbour's span); `tempo_factor` per frame is `null` when the speech fitted at
  its natural speed (then `padded_seconds` of silence follow it). `frames_over_warning_level`
  counts spans still above 2x after grouping (a warning, not a failure).
  `estimated_max_displacement_seconds` is how far a merged block's speech is estimated to start
  from its own caption time, computed from the tempo factors, not measured. In timed mode
  `audio.duration.tempo_factor` is `null` (each frame has its own) and `padded_samples` /
  `trimmed_samples` are sums over the frames.
- `409 result_not_ready` (still running) or `409 job_failed` (with `job_error_code`).
- `410 result_expired` — the job completed but its temporary result expired or was removed
  (TTL elapsed, cleanup, or restart on an ephemeral disk).
- `404 job_not_found`, `401 not_authenticated`.

### `GET /api/jobs/{id}/result/audio[?download=1]`
Same authorization and error rules. Streams `audio/mpeg` (supports HTTP Range).
`Content-Disposition: inline` by default, `attachment` with `download=1`.

## Guest access

"Try as guest": a guest session with quotas instead of an invitation. Off unless
`GUEST_ACCESS_ENABLED=true` (needs `AUTH_MODE=cognito`); while off, every `/api/guest/session`
request answers `404 guest_access_disabled` and a guest cookie is ignored everywhere. Design,
quotas, IP handling and retention: [GUEST_ACCESS.md](GUEST_ACCESS.md).

Guest session body (`POST` and `GET`):

```json
{
  "status": "guest",
  "guest": { "id": "<uuid>" },
  "csrf_token": "…",
  "expires_at": "<ISO 8601>",
  "quota": {
    "session_limit": 5, "session_used": 1, "session_in_progress": 0, "session_remaining": 4,
    "ip_limit": 20, "ip_used": 3, "ip_in_progress": 1, "ip_remaining": 16,
    "ip_window_seconds": 86400, "ip_retry_after_seconds": null, "max_words": 1000,
    "max_output_seconds": 600
  },
  "imports": {
    "session_limit": 5, "session_used": 2, "session_in_progress": 0, "session_remaining": 3,
    "ip_limit": 20, "ip_used": 4, "ip_in_progress": 0, "ip_remaining": 16,
    "ip_retry_after_seconds": null
  }
}
```

`quota` counts audio jobs: a job still processing holds a place (`*_in_progress`); a failed one
gives it back. `imports` counts YouTube caption imports, apart from jobs (same fields, same
network window `quota.ip_window_seconds`): only successful imports count, one still running holds a
place; `imports` is `null` while the server has no import provider (`YOUTUBE_IMPORT_PROVIDER=off`).
The network fields are `null` when this request's network cannot be told. Jobs (or imports) left
= the smaller of `session_remaining` and `ip_remaining`.

### `POST /api/guest/session`
No session needed; the Origin rule applies. Never calls a provider and creates no job.
- `201` + body + `Set-Cookie: mydubb_guest=…` (HttpOnly, `SameSite=Strict`, `Secure` when
  `COOKIE_SECURE=true`, `Max-Age` = the remaining absolute lifetime, 24 h by default).
- `200` + body, no `Set-Cookie`: the browser already has a valid guest session; it is returned
  unchanged (same id, expiry and quota; never renewed).
- `409 already_signed_in`: the browser has a valid account session.
- `429 guest_sessions_exhausted` with `Retry-After`: too many guest sessions started recently
  from this network (`GUEST_SESSIONS_PER_IP`) or overall (`GUEST_SESSIONS_GLOBAL`) within
  `GUEST_SESSION_RATE_WINDOW_SECONDS`.
- `503 guest_network_unknown`: the client network cannot be told (with `CLIENT_IP_HEADER`: the
  header is missing, repeated, a list or not an IP address). Never a shared fallback identity.

### `GET /api/guest/session`
`200` + body (current counts), or `401 not_authenticated` (missing, unknown, expired or ended).

### `DELETE /api/guest/session`
Requires the guest session + CSRF. `204`, revokes it and clears the cookie. Its jobs are not moved
anywhere and become unreachable. Signing in to an account (`/api/auth/*` `authenticated`
responses) also ends the browser's guest session and clears its cookie.

### Jobs as a guest
`POST /api/jobs`, `GET /api/jobs/{id}`, `/result` and `/result/audio` work as documented above,
for the guest session's own jobs only (any other job: `404 job_not_found`). `POST /api/jobs` also
checks, in this order, before anything is written:

| Status | Code | When |
|---|---|---|
| `422` | `guest_word_limit_exceeded` | More than `GUEST_MAX_WORDS` words in the text to translate (timestamp lines and markup not counted). Extra: `word_count`, `max_words`, and `fields: [{field: "transcript", …}]` |
| `422` | `guest_duration_limit_exceeded` | The audio would be longer than `GUEST_MAX_OUTPUT_SECONDS` (default 600 s): baseline (last - first sentence start) / speed, as for the audio target; exactly the limit is accepted (5 minutes at 0.5x). The timestamps are never adjusted. Extra: `output_seconds`, `max_output_seconds`, `baseline_seconds`, `speed`, and `fields: [{field: "last_sentence_start", …}]` |
| `503` | `guest_network_unknown` | As above |
| `503` | `server_at_capacity` | As for everyone; nothing is charged |
| `429` | `guest_session_quota_exhausted` | The guest session has used (or holds) all its jobs. Extra: `limit` |
| `429` | `guest_ip_quota_exhausted` | Guests on this network used (or hold) all jobs of the window. `Retry-After` and `retry_after_seconds` when a completed job will leave the window; extra `limit`, `window_seconds` |

A `202` reserves one place in both quotas: completed → used, failed (any reason, including
`interrupted`) → given back.

### YouTube import as a guest
`POST /api/transcripts/youtube` (below) with the guest session + CSRF: the same request, answer,
link checks, limits and errors as for an account, plus an import quota of its own
(`GUEST_IMPORTS_PER_SESSION` successful imports per guest session, `GUEST_IMPORTS_PER_IP` per
network in the `GUEST_IP_WINDOW_SECONDS` sliding window; defaults 5 and 20 per 24 hours), apart
from the job quota: an import never uses up a job, nor a job an import. Checked in this order,
before Supadata is called:

| Status | Code | When |
|---|---|---|
| `503` | `guest_network_unknown` | As above; nothing written |
| `503` | `youtube_import_busy` | As for everyone; nothing written |
| `429` | `guest_import_session_quota_exhausted` | The guest session has used (or holds) all its imports. Extra: `limit` |
| `429` | `guest_import_ip_quota_exhausted` | Guests on this network used (or hold) all imports of the window. `Retry-After` and `retry_after_seconds` when a used import will leave the window; extra `limit`, `window_seconds` |

An accepted import holds one place in both import quotas while it runs. It counts as used once the
captions were fetched, checked and written as the transcript, before the `200` is sent, also when
the transcript is longer than a guest job allows (the `422` limits of `POST /api/jobs` still apply
when generating; the import never shortens anything) and also when the browser has gone away
meanwhile (a disconnect does not stop the import). Any import error gives the place back; that
does not give back a Supadata credit the request may have cost. A success that could not be
recorded is not delivered: `503 youtube_import_not_recorded` (nothing counted, nothing imported).

## YouTube caption import

Fills the form with the **existing English captions** of one YouTube video, as a timestamped
transcript. It is not speech-to-text: no audio is downloaded or transcribed, and a video without
English captions cannot be imported. It creates no job and calls no Azure service; the user
reviews and edits the text and the two start times, then submits `POST /api/jobs` as usual, with
whatever the form holds at that moment. Off unless `YOUTUBE_IMPORT_PROVIDER` is `supadata` (or
`mock` outside production); `GET /api/meta` reports it as `youtube_import`.

### `POST /api/transcripts/youtube`
Requires session + CSRF (and the Origin rule above), like `POST /api/jobs`; an account, or a guest
session with its own [import quota](#youtube-import-as-a-guest). Body
`{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}`.

Accepted links (`backend/app/youtube_import/youtube_url.py`): `https` only;
`youtube.com/watch?v=<id>` (also `www.` and `m.`; other parameters such as `t`, `list`, `si` and
the fragment are ignored), `youtu.be/<id>`, `youtube.com/shorts|embed|live/<id>`, with an
11-character ID of `A-Z a-z 0-9 _ -`. Refused with `422 validation_error` on field `url`: other
schemes, user info (`user@`), ports other than 443, any other host (including look-alikes such as
`youtube.com.example.org`), playlists or channels without a single video, several `v` parameters,
malformed IDs. Only the canonical `https://www.youtube.com/watch?v=<id>` is sent, and only to
Supadata; the server never fetches the link itself.

`200`:

```json
{
  "transcript": "0:10.480\nWelcome back.\n0:12.960\nGradient descent, step by step.\n6:10.999\nBye!",
  "language": "en",
  "caption_count": 3,
  "skipped_empty_captions": 0,
  "first_caption_start_ms": 10480,
  "last_caption_start_ms": 370999,
  "first_sentence_start": "00:00:10",
  "last_sentence_start": "00:06:10",
  "provider": "supadata"
}
```

- `transcript`: the [timestamped transcript format](#timestamped-transcript-format). The server
  keeps no copy.
- `skipped_empty_captions`: captions whose text was empty, left out (the UI says how many).
- `first_sentence_start` / `last_sentence_start`: suggestions for the two time fields, the start
  of the first and of the last caption **truncated** to whole seconds (`HH:MM:SS`, the fields'
  format; their contract is unchanged). Never the end of the last caption, the video length or an
  added tail. Both are `null` when the two starts fall in the same second: there is no baseline to
  suggest, the UI leaves the fields empty and asks the user to set them before generating.
  `first_caption_start_ms` / `last_caption_start_ms` keep the exact values.

Errors (messages are safe to show; no provider text, key or link). A Supadata `401`/`403` is never
returned as `401`, so the UI does not take it for an ended session:

| Status | `code` | When |
|---|---|---|
| 401 | `not_authenticated` | No valid MyDubb session (checked before anything else) |
| 403 | `csrf_failed`, `origin_rejected` | As for every state-changing request |
| 404 | `youtube_import_disabled` | `YOUTUBE_IMPORT_PROVIDER=off` |
| 422 | `validation_error` (field `url`) | The link is not a supported YouTube video link |
| 422 | `youtube_import_no_english_captions` | No captions at all (Supadata 206), or only another language (Supadata answers with the first available language when English is missing; the returned `lang` is checked) |
| 422 | `youtube_import_video_unavailable` | Supadata 403/404: video missing, private, members-only, age-restricted, region-blocked or live |
| 422 | `youtube_import_empty_captions` | Captions without any text |
| 422 | `youtube_import_not_representable` | The [format](#timestamped-transcript-format) cannot carry these captions without changing what a job reads: a single caption, captions that begin with a clock time on two or more lines (`00:10:30 is the first meeting time.`), a caption starting with a bracketed time (`(0:05) look`), a caption that is a cue timing line, or a caption whose whole text is a time (`10:30`, `[0:05]`, `16:9`). Nothing is imported |
| 422 | `youtube_import_too_large` | Answer above 8 MB |
| 502 | `youtube_import_auth_failed` | Supadata rejected the server's key (configuration problem) |
| 502 | `youtube_import_rejected` | Supadata 400/402 |
| 502 | `youtube_import_service_error` | Network error, Supadata 5xx, a redirect, an expired job, an unknown status |
| 502 | `youtube_import_invalid_response` | Wrong schema or types (a job `status` that is not a string, a poll answer that is not an object, and so on), `content` as plain text, a time that is not a finite non-negative number (booleans and strings included), start times that decrease (never sorted), a job that completed without captions |
| 503 | `youtube_import_quota_exceeded` | Supadata 429 "Plan usage limit": the month's credits are used up |
| 503 | `youtube_import_rate_limited` + `Retry-After: 5` | Supadata 429 rate limit |
| 503 | `youtube_import_busy` + `Retry-After: 10` | `YOUTUBE_IMPORT_MAX_CONCURRENT` imports already running (admission control, not a quota) |
| 503 | `youtube_import_cancelled` | The server is shutting down |
| 429 / 503 | `guest_import_*`, `guest_network_unknown`, `youtube_import_not_recorded` | Guests only: [YouTube import as a guest](#youtube-import-as-a-guest) |
| 504 | `youtube_import_timeout` | A request not complete within `SUPADATA_TIMEOUT_SECONDS`, the import not complete within `SUPADATA_DEADLINE_SECONDS` (an asynchronous job still running, a stalled or slowly dripping answer, an answer that finished or was checked after the deadline), or no request slot free before the deadline |

How the request is served:

- One request: the response comes when the captions are there or the import failed. The handler
  is async: Supadata's network I/O is awaited, so it never blocks the event loop, while blocking
  work (the session check, the database, the rate limiter, parsing the answer) runs in threads.
  The database connection used for the session check is released before waiting.
- Deadline: the whole import runs under one `asyncio` timeout of `SUPADATA_DEADLINE_SECONDS`,
  which cancels whatever is being awaited at that moment, a network read that is blocked included.
  This is needed because httpx's timeouts are per operation (each connect or read separately), so
  an answer arriving a little at a time could otherwise go far past any total. The time is also
  checked after the headers, after every chunk, when the stream has ended and before a result is
  returned, so an answer that completes late is a timeout, not a success. Each single request is
  also limited to `SUPADATA_TIMEOUT_SECONDS` the same way. Limit: the timeout cannot interrupt
  parsing and checking an answer (at most 8 MB, in a thread); that takes a fraction of a second,
  and its result is dropped as a timeout if the deadline passed meanwhile.
- Supadata request: `GET https://api.supadata.ai/v1/transcript` with `url`, `lang=en`,
  `text=false` (timed captions), `mode=native` (existing captions only; never `auto` or
  `generate`); no `chunkSize`, so the provider does not regroup captions. Redirects are not
  followed.
- If Supadata answers `202` with a job, MyDubb polls `GET /v1/transcript/{jobId}` every
  `SUPADATA_POLL_INTERVAL_SECONDS` until `completed`, `failed` or the deadline. The job ID never
  leaves the server, and there is no MyDubb polling endpoint (so no import state to own or clean
  up). A rate-limited poll is polled again; any other failed poll ends the import.
- The initial request is **never retried**, also not after a timeout (each one can cost a credit).
  All Supadata requests of the process, polls included, share one rate limiter
  (`SUPADATA_MAX_REQUESTS_PER_WINDOW` per `SUPADATA_RATE_WINDOW_SECONDS`, plus one second of margin,
  so one request every two seconds by default).
- Logs hold status codes, Supadata's error code, counts, latency and billed credits; never the
  link, the video ID, caption text, the response body or the key.

### Timestamped transcript format

The handoff between the import and anything that reads the transcript with its times: the plain
transcript cleaning of `POST /api/jobs`, and timed mode (`timing_mode: "timed"`, see
[Timed transcripts](#timed-transcripts-timing_mode-timed)), which reads the `.mmm` times exactly.
It is the layout of
YouTube's own transcript panel: each caption is a line holding only its **start** time, followed by
one line with its text.

```text
0:00.480
Welcome back. Today we look at gradient descent.
0:02.960
It minimizes the loss function
1:02:03.004
Done after an hour.
```

- Time: `M:SS.mmm` below one hour, `H:MM:SS.mmm` from one hour on: hours and minutes-under-an-hour
  without leading zeros, minutes and seconds two digits, a dot and always **three** millisecond
  digits (the provider's precision; nothing is rounded to whole seconds). At most two hour digits
  (an import starting at 100 hours or later is refused).
- Text: exactly the provider's caption text (words, punctuation, spelling, Unicode, repeated words
  and repeated captions). Line breaks inside one caption become one space; nothing else changes.
  Captions are not merged into sentences, deduplicated, sorted or summarised; equal start times
  stay in the provider's order.
- Start times never decrease. Durations are not written (the format has no end times).
- **Read back before it is returned.** The only reader today is the transcript cleaning that
  `POST /api/jobs` applies (`clean_transcript`): it removes the time lines (two or more standalone
  timestamps in non-decreasing order, `.mmm` included). So every imported transcript is cleaned on
  the server first and must give back exactly its captions' text, in order, one per line (runs of
  whitespace inside a line become one space, as for pasted text). If it does not, the import fails
  with `youtube_import_not_representable` instead of handing the form a transcript whose job would
  read a time aloud or drop spoken words. Cases: a single caption (cleaning keeps one lone time
  line); captions beginning with a clock time on two or more lines (cleaning strips `H:MM:SS`
  prefixes, e.g. `00:10:30 is the first meeting time.`); a caption starting with a bracketed time
  (`(0:05) look`, always stripped); a caption that is a cue timing line (the whole text would be
  read as SRT). A caption whose whole text is a time (`10:30`, `16:9`) is refused with the same code,
  because a timed reader of the format would take it for a timestamp line even where cleaning
  would not. Spoken times elsewhere are kept: `10:30 is our meeting time.`, or one caption starting
  with `00:10:30`. Pasted transcripts are cleaned exactly as before.
- The user may edit the text freely; what the job receives is the edited text. The time fields keep
  their `HH:MM:SS` contract, so a millisecond start is shown truncated there.
