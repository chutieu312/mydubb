# Usage records and reference costs

Every dubbing job records what it asked of the providers, so there is long-term data for
designing prices and quotas. Administrators read it on the website
([The Usage & Costs page](#the-usage--costs-page)); a local command gives the same figures, with CSV
files, for reconciling.

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
  (`attempts_expected`, `write_errors`, `method_version`). The ending is written right after the job's
  terminal status becomes visible and after its work files are removed, so a report run in that
  instant can show the job as not ended.
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
* **A usage write error never fails the job, and a usage write never holds it.** Every usage
  transaction (the start, each attempt, the ending, the retention purge) begins by limiting its
  own lock wait and run time on the server, `lock_timeout` and `statement_timeout` set with
  `set_config(..., is_local)` to `USAGE_WRITE_TIMEOUT_SECONDS` (default 3, range 0.2-30). They last
  for that transaction only, so the shared pool and the auth, job and import transactions keep
  their settings, and PostgreSQL itself cancels the statement (no thread is left waiting on a
  query that still runs; the transaction is rolled back). A write that times out is logged by
  exception type only (the message can quote SQL), writing stops after the first failure (no
  timeout per remaining request), the pending rows get one last try when the job ends (bounded the
  same way). Each of the three possible waits is at most one timeout (one statement each), so
  the job is delayed by at most **three timeouts** in total (9 s by default): the start fails, the
  last try at the pending rows fails, the summary fails; or one attempt write fails mid-job and
  then the same last two. A tested bound, not an average, and the summary records `write_errors` and `attempts_expected` so the
  report can show what is missing. Rows that never get written are simply absent: the report then
  shows the job as incomplete (or, if even the summary is lost, under "jobs without a usage
  record").
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

Residual limits of that bound: it covers lock waits and statement run time. Waiting for a pooled
connection is bounded only by the engine's existing pool timeout, and a network that silently
stops answering is a limit every database call of the application shares (a dedicated engine
with its own keepalives, as the guest import runner has, was not added to avoid a second pool).

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

## The Usage & Costs page

`/admin/usage` on the website, for MyDubb administrators ([AUTHENTICATION.md](AUTHENTICATION.md#administrators)).
It only reads: no change to prices, quota, roles, usage or jobs, no call to Azure, Supadata or
Cognito, and no export (use the command below for CSV). It is not in the Chrome extension. API:
[AUTH_API.md](AUTH_API.md#usage--costs). Opening or refreshing the page can wake Neon; nothing reads
the database in the background to keep the page fresh.

**Access.** Every report request goes through `require_admin` first, reading the role from the
database: a guest, an ordinary user, a disabled user, an invalid session and an extension token are
refused before any report query, any request with an `Authorization` header is refused whatever its
cookies are, and a revoked role applies from the next request. The role opens the usage figures of
this page only: a job id gives no access to that job's transcript, audio or endpoints. Responses hold
only the fields declared in `app/admin/usage.py`, with `Cache-Control: no-store`, also on errors.

The page asks `GET /api/admin/session` once for each signed-in identity, to show its link; hiding
the link protects nothing. The report is never written to browser storage. A sign-out, an ended
session or a refused request removes the figures and ignores late answers; a `401` shows the sign-in
form, a `403 admin_required` keeps the user signed in and says the access ended. When a role is
revoked elsewhere, figures already on screen stay until that browser's next report request: the page
does not poll.

**Filters.** Since, until, language, job id. Default: the last 7 days. At most **31 days** per
summary or list; a period that long may be anywhere, but older than `USAGE_RETENTION_DAYS` it holds
what retention left. The rule is the command's: `since <= job_usage.started_at < until`, UTC when no
zone is given, an offset is converted. A job id is matched inside the period; "View usage" (or the
button offered when the filter finds nothing) opens a job whatever its date. Bad input is refused
with `422`, never clamped. Filters and the open job live in the address, so a direct link, a reload
and Back/Forward work; a page of results does not, so a reload starts from the first page.

**Paging.** Jobs: `started_at DESC, job_id DESC`, 25 by default, at most 100. A job's requests: by
`seq`, 50 by default, at most 100. Cursors hold a position, not a row number, so a job that starts
meanwhile does not shift a page, and a cursor works only with the filters (or the job) it was issued
for. A summary covers the whole period, and a job's figures all its requests, whatever page is
shown.

**How it reads.** `app/usage/queries.py`: `build_report` loads a whole period, which suits a local
command; here a list reads one page from the database, and a summary reads the period in batches of
200 jobs (each with its attempts, then released), and hands them to the same `Totals` and
completeness rules as the command. There is one definition of actual / estimated / unknown / none,
mock, prices and money, in `app/usage/report.py`, and the page computes nothing: it rounds the exact
decimal strings for display (half up, 4 decimals, as the text report), with every digit in the
tooltip. The existing indexes are enough (`job_usage.started_at`, the attempts' primary key); no
migration.

**Snapshot and limits.** Each response is one `REPEATABLE READ, READ ONLY` transaction on a new
short session from the application's factory, opened after the auth check (the auth session has
already queried, and the level can only be set before a transaction's first query). `generated_at`
says when each response was read; summary, list and detail are separate requests and can differ.

A report request holds **one pooled connection at a time**: the auth check reads the role from the
database as on any request, its transaction ends and its connection goes back to the pool, and only
then does the report ask for its own. So it never waits for a connection while holding one, and
concurrent reports cannot starve each other on the application's pool of 5 + 5; beyond ten at once
they queue for a connection as any other request does. This is local to these routes: `get_db` and
the other endpoints are unchanged. A role revoked after that check applies from the next request, as
before.

Inside the transaction `lock_timeout` and `statement_timeout` are at most **10 s**. A whole summary
has a budget of **30 s**, counted from before it asks for its connection: each read (batches,
attempts and the two final queries, also when the period has no batch) is limited on the server to
the time left, and a summary over budget is an error even if its reads all ended. A list or a detail
has no such budget: at most 10 s for each of its two or three statements. Going over, or finding no
pooled connection, ends in `503 usage_report_timeout`; any other database failure in
`503 usage_report_unavailable`, logged by exception type only. Never a `200` with an empty report.
The timeouts last for that transaction only, and the connection goes back to the pool before the
response is sent, on success and on error.

Not bounded by those limits: a network that silently stops answering, and a summary that gets its
connection only as the pool times out (30 s) is refused at that point rather than sooner. A failure
inside the auth check itself, waiting for its connection included, is handled like on any other
endpoint (`500 internal_error`, logged by the global handler).

**Moving between the pages.** The Studio stays mounted, hidden, behind the page: its form (the draft
in page memory, nothing stored or put in the address), its job panel and its status polling carry on
as they were, and an open result comes back as it was. The audio player pauses on leaving and keeps
its place. A reload, a sign-out or another identity behave as they always did (the draft and the
job panel are not kept through a reload).

**Reading it.** The figures are what was recorded. "Reference cost — not an invoice": list prices,
per request at the price in force on its date (each price its own line with its SKU, region,
effective and checked dates and source), Free allowance not deducted, invoice not verified, Supadata,
hosting, taxes and payments not included. The total is shown as a lower bound ("at least") whenever
a request has unknown usage, known usage has no price for its date, a job is incomplete or, in a
summary, a job of the period has no usage record. Those jobs are counted on their creation time,
since they have no usage start. The "earliest usage record" is the oldest row still in the database,
not the deployment date. "Audio processing" is the wall time of the whole audio stage. There is no
cost per minute or per hour.

## The report command

Local, read-only: one `READ ONLY` PostgreSQL transaction; it creates no job and calls no provider.
Run it from `backend/` where `DATABASE_URL` is set (environment or git-ignored `backend/.env`,
never on the command line, never printed). It is not needed to use the page; it stays for reconciling
and for CSV files.

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

**Consistency.** The whole report is one `REPEATABLE READ, READ ONLY` transaction, so all its
queries (summaries, attempts, jobs without a record) see the same snapshot: a job finished or
added while the report runs is in none of them, never in one and not another.

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
  tests/test_usage_report.py tests/test_usage_retention.py tests/test_usage_timeouts.py \
  tests/test_admin_usage.py tests/test_admin_usage_limits.py
cd ../frontend && npx vitest run src/App.adminUsage.test.tsx src/lib/usageFilters.test.ts
cd ../e2e && bash run-e2e.sh tests/auth.adminUsage.spec.ts
```

They cover multi-request and multi-block jobs, missing and broken headers, SSML and CJK counting,
timeout and error outcomes, duplicate writes, failing usage writes (the job still completes),
mock versus real providers, reports with missing data, the period boundaries, exact money and
half-up rounding, the read-only transaction, usage writes blocked by a real PostgreSQL lock
(timeout, job and slot released, shutdown), retention that leaves jobs alone, and the migration
(expand-only, reversible, one Alembic head). The rest of the suite is unchanged and still passes.
Only fake HTTP transports, mock providers and disposable PostgreSQL are used: Azure, Cognito
and Supadata are never called.

For the page, `test_admin_usage.py` goes through the real routes, auth first: who is refused (and
that no report query ran), revocation on the next request, field allowlists and `no-store`, period
boundaries and offsets, the 31-day and page limits, cursors, stable pages while jobs arrive, the same
figures as the command and its CSV on one data set, every usage case, several prices in one period,
a summary independent of batch and page size, one snapshot with commits landing between its queries,
the transaction's isolation, read-only state and timeouts (and that they do not reach pooled
connections), a real lock ending in `503`, logs without SQL or secrets, and query and object counts
on 500 jobs (no query per job, no full read). `test_admin_usage_limits.py` uses real `pg_sleep` delays
and more concurrent requests than the pool has connections, with the pool's wait and the budget
shortened to keep it quick: no connection held while a report asks for its own, every way out
returning its connections, and the budget over the final queries, an empty period, a slow statement
and the wait for a connection. The frontend tests and the browser specs cover the link
and refusals, filters, pages, stale answers, the `401` and `403` paths, sign-out with requests still
running, direct address, reload, Back/Forward, and the Studio draft, job and audio.

Not verified by any of this: production data, RAM or capacity on the production plan, or the figures
against an invoice.
