# Usage records and reference costs

Every dubbing job records what it asked of the providers, so there is long-term data for
designing prices and quotas. A local command turns that data into a report. There is no dashboard,
admin page or API for it.

Three things are always kept apart, in the data and in every report:

| | What it is | Where it comes from |
|---|---|---|
| **a. Usage recorded** | Characters (and requests, timings, sizes) per provider request, each labelled `actual`, `estimated`, `unknown` or `none` | The job pipeline, at the moment of each request |
| **b. Reference cost** | That usage converted at the **paid-tier list price** | `backend/app/usage/data/reference_prices.json`, applied by the report |
| **c. Actual invoice** | What Microsoft billed | **Not verified.** Translator and Speech currently run on the Free (F0) tier (Product Owner). The F0 allowance is **not** deducted from (b) |

(b) is not "the application's cost": it excludes Supadata (YouTube import is a separate operation,
not a dubbing job), Render, Neon, payments, taxes and anything else. Output minutes are not a cost
measure either: the baseline is `last - first sentence start`, a timestamp difference, not a text
length. Cost follows characters.

## What is recorded

Two tables (migration `0020`), written by the pipeline and read by the report:

* `job_usage`: one row per job, written when the pipeline starts the job and completed when it
  ends. Fixed labels (`client` web / extension, `access` invitation / guest / access_code), target
  language, voice, speed, timing mode (plain / timed), the names of the providers that ran,
  baseline, target (`baseline / speed`) and measured final audio seconds, source characters,
  timed block count, the audio-stage wall time (FFmpeg with the ffmpeg processor) and MP3 size,
  `outcome` (completed / failed / superseded) with the error code, and bookkeeping
  (`attempts_expected`, `write_errors`, `method_version`).
* `job_usage_attempts`: one row per request sent to a provider, keyed `(job_id, seq)`: service
  (translator / speech), `provider_kind` (**azure** or **mock**), outcome (`ok`, `http_error`,
  `timeout`, `network_error`, `cancelled`, `unusable_response`, `failed`), HTTP status, error code,
  `items` (elements or blocks inside the request), start time and elapsed ms, what was sent
  (`sent_amount` + `sent_unit`) and the usage (`usage_amount`, `usage_basis`, `usage_method`).

Not stored: transcript, translation, SSML, keys, tokens, IP addresses, URLs, user or session ids,
email addresses. There is no foreign key to `jobs`: usage outlives the job row and a future
cleanup of job metadata cannot delete it.

Supported cases: web and extension, guest and invitation (and Access Code mode), plain and timed,
every target language, voice and speed.

## Rules that keep the numbers honest

* **One attempt = one provider request**, counted once, written when its outcome is known. A
  request holding many blocks (Translator elements, timed Speech blocks) is one attempt.
  `(job_id, seq)` is the primary key, so a repeated write changes nothing, and the report never adds
  an attempt twice.
* **Nothing is requested to measure.** No new request, no retry, no probing call. The providers
  record what they already do; the audio facts come from files the job already has.
* **Outcomes are distinguished**: success, HTTP error, timeout, network error, cancelled
  (the shutdown closed the rate limiter before the request was sent: usage is a true `none`, 0),
  and a response that was served but unusable (still an attempt: the service processed it).
* **A failed request is not free.** A rejected, timed-out or unanswered request has usage
  `unknown` (NULL amount, never 0), unless the provider itself reported a charge.
* **A job that fails keeps its usage**: attempts are written one by one as the job goes, in their
  own short transactions.
* **A usage write error never fails the job.** It is logged by exception type only (the message
  can quote SQL), writing stops after the first failure (no database timeout per remaining
  request), the pending rows get one last try when the job ends, and the summary records
  `write_errors` and `attempts_expected` so the report can show what is missing.
* **Mock providers are labelled `mock`** (usage basis `none`). The report counts them apart and
  excludes them from usage and cost; a job with real translation and mock speech keeps its real
  translator attempts.
* `USAGE_RECORDING_ENABLED=false` stops new rows and changes nothing else.

**Gap after a crash.** A process that dies mid-request cannot write that request, nor the job's
ending. The job then has no `finished_at` (the report says `no_ending_recorded`: the last
request may be missing and is not guessed), and the job itself is failed by the existing
liveness recovery. The pipeline was not made durable for this.

## How usage is counted (checked 2026-11-01)

**Translator** (text translation v3.0). The response header `X-metered-usage` is documented as
"the number of characters for which the user is charged" for that request
([translate reference](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate)).
A valid header (a plain non-negative integer) is stored as **actual**. Without one (missing, empty,
negative, decimal, not a number, absurdly long) or on a failed request the usage is **unknown**.
The Microsoft pages do not say whether characters are code points or UTF-16 units, whether the
tags of `textType=html` count, or whether failed requests are billed, so no estimate is
derived from what was sent. What was sent (UTF-16 units of the markup we send, which includes the
no-translate markup) is stored separately in `sent_amount`; the report shows it for unknown
requests as "a size sent, not a billing figure". Method label: `translator-x-metered-usage-v1`.

**Speech** (text to speech REST). The [pricing note](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)
bills "the total number of characters in each successfully processed request": "all markup within
the text field of the request body in the SSML format, except for `<speak>` and `<voice>` tags",
letters, punctuation, spaces and all white-space, "every code point defined in Unicode"; "each
Chinese character is counted as two characters, including kanji used in Japanese, hanja used in
Korean, or hanzi used in other languages". Audio duration does not change the price of standard
neural voices. The estimate (`azure-speech-ssml-characters-v1`) is therefore: the SSML of the
request without the `<speak>`/`<voice>` tags (so the `<lang>` tags and the `<break>` tags of timed
requests count), in code points as sent (the text is XML-escaped, so `&` is `&amp;`), plus one more
for every Han ideograph (CJK Unified Ideographs, Extension A, Compatibility Ideographs, and the
supplementary-plane extensions). Hiragana, katakana and Hangul are not mentioned by the page and
count once. It is an **estimate** (labelled so): Microsoft does not publish the exact algorithm.
The estimate is kept only when the request succeeded; a failed one is `unknown`.

## Reference prices

`backend/app/usage/data/reference_prices.json` is the only place with prices. Each entry has the
currency, service, SKU, meter, region, unit, price, `effective_from`, `checked_on` and the official
source; the free allowances (F0) are listed for information only. To change a price, **add** an
entry with a new `effective_from` (the entry in force on the usage date applies; before the first
entry there is no price, and the report says so). Usage rows hold no price, so any report can be
recomputed after a change.

| Service | SKU | Meter | Region | Price | Effective | Checked |
|---|---|---|---|---|---|---|
| Translator | S1 | S1 Characters | westus2 | USD 10.00 / 1M characters | 2025-05-01 | 2026-11-01 |
| Speech | S1 | S1 Neural Text To Speech Characters | westus2 | USD 15.00 / 1M characters | 2024-02-01 | 2026-11-01 |

Source: the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices) (the official
price list; the azure.microsoft.com pricing pages render prices with JavaScript). The region of
the production resources is not recorded and may differ; Microsoft says prices are estimates.

## Retention and cleanup

Usage rows older than `USAGE_RETENTION_DAYS` (default **180**, range 7-3650) are deleted by the
periodic cleanup (startup and every `CLEANUP_INTERVAL_SECONDS`), in its own transaction: a failure
only skips that purge and logs the exception type. It deletes from `job_usage` and
`job_usage_attempts` only; it never reads or changes `jobs` or any product table. A job's
age is its usage `started_at`; an attempt is deleted by its own start time, so a job on the edge
can briefly lose its oldest attempts before its summary (the next cleanup removes the rest).
Plan a report before the retention horizon passes, or keep the CSV exports.

## The report command

Local, read-only: one `READ ONLY` PostgreSQL transaction; it creates no job and calls no provider.
Run it from `backend/` where `DATABASE_URL` is set (environment or git-ignored `backend/.env`,
never on the command line, never printed); there is no API.

```bash
cd backend
uv run python -m scripts.usage_report --since 2026-10-01 --until 2026-11-01
uv run python -m scripts.usage_report --since 2026-10-01 --language japanese --csv jobs.csv
uv run python -m scripts.usage_report --job <job-id> --attempts-csv attempts.csv --quiet
uv run python -m scripts.usage_report --synthetic        # made-up data, no database
```

| Option | Meaning |
|---|---|
| `--since`, `--until` | ISO date or datetime. **UTC** when no zone is given; an offset is converted. `since <= started < until`, on `job_usage.started_at` (when the pipeline began the job) |
| `--job` | Job id; repeatable |
| `--language` | API value: `vietnamese`, `mandarin_simplified`, `hindi`, `spanish`, `arabic`, `french`, `russian`, `japanese` |
| `--csv FILE` | One row per job |
| `--attempts-csv FILE` | One row per provider request |
| `--prices FILE` | Another price file (same format) |
| `--quiet` | No text summary |

**Rounding.** Characters are integers. Money is `Decimal`: characters x price / 1,000,000 is
exact, sums are exact. Only the text summary rounds, to 4 decimals, half up; the CSV keeps every
digit. Seconds are shown to 3 decimals. All times are UTC (`...Z`).

**Completeness.** A job is *incomplete* with one or more reasons: `no_ending_recorded` (crash or
restart), `attempts_missing` (fewer rows than `attempts_expected`, or a hole in `seq`),
`write_errors`, `usage_unknown` (a real request with unknown usage), `no_translator_attempt` /
`no_speech_attempt` (a completed job with real providers and no request of that service). The
summary also counts jobs created in the period with **no usage row at all** (made before
recording began, or the record could not be written). Costs are computed from known usage only:
with unknown requests the total is labelled a lower bound.

Example on the synthetic data set (`--synthetic`; the ids, numbers and the "2 jobs without usage"
are invented to show every case, none of it is real):

```text
MyDubb usage report - recorded usage and REFERENCE costs, not an invoice
Generated 2026-11-01T12:00:00Z. All times UTC; since <= started < until.
Period: since 2026-10-01T00:00:00Z until 2026-11-01T00:00:00Z
Usage recording began (first record in the database): 2026-10-20T09:00:00Z

Jobs with a usage record: 7  completed 4, failed 3
  complete 3, incomplete 4 (attempts_missing 1, no_ending_recorded 1, usage_unknown 2, write_errors 1)
  jobs created in the period WITHOUT any usage record: 2 (made before recording began, or the record could not be written)
  jobs with mock providers: 1 (2 mock request(s), excluded below)

Translator (characters)
  requests: 6  [ok 5, timeout 1]
  characters, actual (X-metered-usage): 26,900
  requests with UNKNOWN usage: 1 (sent 600 characters; a size sent, not a billing figure)

Speech (characters)
  requests: 8  [ok 7, timeout 1]
  characters, estimated (SSML rules): 48,300
  requests with UNKNOWN usage: 1 (sent 6,000 characters; a size sent, not a billing figure)

Reference cost at paid-tier list prices (USD; services are on Free)
  translator S1 westus2 10.00/1M chars (effective 2025-05-01, checked 2026-11-01): 26,900 chars = 0.2690
  speech S1 westus2 15.00/1M chars (effective 2024-02-01, checked 2026-11-01): 48,300 chars = 0.7245
  total of KNOWN usage: 0.9935 USD  -- a lower bound: 2 request(s) have unknown usage
  This is not the application's total cost: see NOT included below.

By language: jobs, translator actual chars, speech estimated chars, reference cost known
  japanese                    1        9,650       22,700       0.4370
  spanish                     1        5,200        6,200       0.1450
  vietnamese                  5       12,050       19,400       0.4115
...
```

The full output also lists the same breakdown by timing mode and client, the audio totals of
completed jobs (baseline, target, measured final seconds, MP3 bytes, audio-stage time, speech
characters per output minute), and the "NOT included" and "invoice not verified" notes.

The job CSV has these columns: `job_id, started_at_utc, finished_at_utc, status, outcome,
error_code, client, access, language, voice, speed_percent, timing_mode, translation_provider,
speech_provider, audio_processor, providers (real|mock|mixed|none), baseline_seconds,
target_audio_seconds, final_audio_seconds, source_chars, blocks, translator_requests,
translator_unknown_requests, translator_chars_actual, translator_chars_sent_unknown,
speech_requests, speech_unknown_requests, speech_chars_estimated, speech_chars_sent_unknown,
audio_ms, mp3_bytes, attempts_expected, attempts_found, write_errors, complete, reasons,
ref_cost_translator, ref_cost_speech, ref_cost_known, currency`. `status` is the job's own status
while its row exists, else the recorded outcome. The attempts CSV has the attempt columns listed
above. Neither holds text, SSML, keys, addresses or user identifiers.

## Not covered

* Supadata import (a separate operation, outside dubbing jobs), Render, Neon, GitHub, payments,
  taxes; the actual invoice and any free allowance.
* Peak CPU or RAM. FFmpeg time is the wall time of the audio-processing stage only (null with the
  mock processor); the encode inside speech synthesis is not separated.
* Jobs from before recording began (they have no usage row).
* A request in flight when the process dies (see the crash gap).
* The exact Speech algorithm and the Translator counting rules beyond the header; the Speech
  figure is an estimate and the method version is stored with it.

## Checks

```bash
cd backend
uv run ruff check . && uv run ruff format --check .
export TEST_DATABASE_URL=postgresql://...   # a disposable database
uv run pytest tests/test_usage_providers.py tests/test_usage_jobs.py \
  tests/test_usage_report.py tests/test_usage_retention.py
```

They cover multi-request and multi-block jobs, missing and broken headers, SSML and CJK counting,
timeout and error outcomes, duplicate writes, failing usage writes (the job still completes),
mock versus real providers, reports with missing data, the period boundaries, exact money and
half-up rounding, the read-only transaction, retention that leaves jobs alone, and the migration
(expand-only, reversible, one Alembic head). The rest of the suite is unchanged and still passes.
Only fake HTTP transports, mock providers and disposable PostgreSQL are used: Azure, Cognito
and Supadata are never called.
