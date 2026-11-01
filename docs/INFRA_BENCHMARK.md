# Infrastructure benchmark (before the paid beta)

A repeatable, one-off assessment of how the application uses resources when idle and when it
processes audio, plus a conditional Render/Neon cost estimate. It is **not** a monitor and it
never touches production.

- **Measured commit:** `cb71cd2` (`main` on 2026-11-01): the app image used for every number
  below was built from it. Later code (Admin role, per-job usage) is not covered; rerun the
  scripts after it lands. The PR branch also contains newer `main` commits and the review fixes
  to the scripts; none of that was measured, and no old number is attributed to it.
- **Raw results:** [benchmarks/infra/results/cb71cd2/](../benchmarks/infra/results/cb71cd2/)
  (JSON lines per case, `idle.json`, `audio-summary.md`). These were written by the **first
  version of the harness (schema 1)**, whose validation was weaker than the current one (see
  "Harness versions"). They are unchanged; `summarize.py` labels them `legacy-v1`.
- **Scripts:** [benchmarks/infra/](../benchmarks/infra/). Product code, schema, pipeline,
  heartbeat, recovery and pool settings are unchanged.

## Evidence levels

Every statement below carries one of these tags.

| Tag | Meaning |
|---|---|
| **[M]** | Measured directly on the local machine/containers described below |
| **[C]** | Inferred from reading the code |
| **[P]** | Published by the provider (official page, fetched 2026-11-01) |
| **[U]** | Not verified on a real Render/Neon account, or not measured |

Local numbers are **not Render performance** and local PostgreSQL is **not evidence of Neon
billing or scale-to-zero behavior**.

## How to rerun

Needs Docker (Linux engine), bash and Python 3 on the host (result checks and tables). Each run
has a run id (`BENCH_RUN_ID`, generated if absent); its containers and network are named
`mydubb-infra-bench-<run id>-*` and labelled, and the script removes **only** resources with that
label on exit. A second start with a run id still in use, or into a non-empty results directory,
is refused before anything is changed. The default results directory is
`benchmarks/infra/results/<commit>/run-<run id>/`.

```bash
bash benchmarks/infra/run-idle.sh 660                 # idle DB activity, 11 minutes
bash benchmarks/infra/run-audio.sh matrix             # standard audio matrix (about 25 minutes)
bash benchmarks/infra/run-audio.sh cpu0.5-mem512m guest_limit plain 2 3   # one case
python -I benchmarks/infra/summarize.py benchmarks/infra/results/<commit>/run-<id>
```

Exit status: `run-audio.sh` and `run-idle.sh` return 0 only if everything expected happened. A
case fails when the container exits nonzero, is OOM-killed, times out, leaves no output, has fewer
runs/jobs/outputs than expected, a job did not complete, the decoded MP3 sample count is missing or
differs from the target, or cleanup left something behind. The matrix continues after a failed
case (to collect diagnostics) and exits nonzero at the end. `summarize.py` lists failed or
incomplete cases as `FAILED` and keeps them out of all statistics (it also exits nonzero).
Startup steps (PostgreSQL, migration, app readiness) have finite deadlines
(`BENCH_DB_TIMEOUT`, `BENCH_MIGRATE_TIMEOUT`, `BENCH_APP_TIMEOUT`, `BENCH_CASE_TIMEOUT`); a
container that stops early is detected at once and its last log lines are printed with
connection strings and credentials masked.

Tests of the scripts (no benchmark is run; every wait is bounded):

```bash
python -I -m unittest discover -s benchmarks/infra/tests -p "test_harness.py"   # deadline, disk guard, validation
bash benchmarks/infra/tests/test_scripts.sh            # startup deadlines, isolation, exit codes (Docker, fake harness)
```

The image is built from the repo `Dockerfile` (`mydubb-infra-bench:<commit>`; set `BENCH_IMAGE`
to reuse an image, for example to keep measuring `cb71cd2`).

### Harness versions

- **Schema 1** (first PR commit): the results in `results/cb71cd2/`. Success was "job completed
  and the two sample fields compare equal"; a missing field compared equal to a missing field,
  failures did not change the exit code, and the deadline and disk guard were only looked at
  after waiting for the worker threads.
- **Schema 2** (review fixes): the checks above, a supervising loop that looks at the deadline and
  the disk guard every 50 ms while jobs run and stops them (FFmpeg is killed; stuck work ends the
  process), exit codes, run ids. The **measurement method is unchanged** (same sampling, same
  workloads, same fixtures). The full matrix was **not** rerun; only the smoke checks listed under
  "Verification of the review fixes" ran with schema 2, so the tables below remain schema 1
  numbers. Schema 2 also records the decoded and target sample counts themselves.

## Test environment [M]

Windows 11 host, Docker Desktop 29.6.1 (Linux engine, 16 CPUs, 15.5 GiB). App image: the
production Dockerfile (Python 3.12.16, Debian FFmpeg 7.1.5). Database: `postgres:17-alpine`
in its own container and network. Limits were applied with `docker run --cpus/--memory`
(`--memory-swap` equal to memory): a **simulation of an instance size, not Render**.

## 1. Idle database activity

Setup: real app + isolated PostgreSQL, mock providers, no user, job or import, default settings
(heartbeat 15 s, stale after 90 s, cleanup 300 s). Observed 660 s after startup recovery
finished; every statement logged with `log_statement=all`. Nothing was disabled.

| Periodic work | Statements | Interval | Source |
|---|---|---|---|
| Stale-job check: `UPDATE jobs ... WHERE status active AND heartbeat stale` | 44 in 660 s | 15.0 s [M] | `job_liveness_loop` → `fail_stale` [C] |
| Stale guest import release: `UPDATE guest_import_quota ...` | 44 | 15.0 s [M] | same tick [C] |
| Cleanup: 9 `DELETE`/`UPDATE`/`SELECT` over sessions, auth rows, password resets, guest quota/sessions | 2 rounds | 300 s [M] | `cleanup_loop` [C] |

Totals [M]: 208 statements (396 including BEGIN/COMMIT), 215 transactions, 2 connection events.
**Longest gap with no statement: 15.0 s.** The app holds one idle pooled connection
afterwards (SQLAlchemy pool, `pool_pre_ping`).

Only with work present [C]: `heartbeat_jobs` (skipped when the process owns no job), job status
transitions, guest import heartbeats, request-driven queries. `/api/health` does no database
access; `/api/ready` does `SELECT 1`.

App process idle [M]: RSS 104 MB, cgroup memory 154 MB (includes page cache), 9.9 CPU-seconds
in 660 s (1.5 % of one CPU), including log output and the two cleanups.

### What this means for Neon

- Neon Free scales to zero after 5 minutes of inactivity and the setting cannot be changed;
  Launch also uses 5 minutes (can be disabled); Scale is configurable from 1 minute [P].
- A statement every 15 s is far inside 5 minutes, so **an always-running app instance keeps
  the Neon compute awake**: the compute can never scale to zero while the app runs [M for the
  statement cadence, P for the 5-minute rule]. Neon's pages do not define precisely what counts
  as activity, or whether an idle open connection does [U]; the cadence above is queries, not
  just a connection, so the conclusion does not depend on that.
- Local PostgreSQL has no scale-to-zero; whether production Neon is awake or asleep now is [U]
  (see "What to check on the real accounts").
- Where the app does **not** run continuously (Render Free spins down after 15 minutes
  without inbound traffic [P]), the loops stop with the process and Neon can sleep after
  its own 5 minutes. A Render health check or uptime monitor that pings the service would keep
  both awake.
- Heartbeat/cleanup/recovery were not weakened for these numbers. Reducing idle DB writes
  (for example not running the stale check every 15 s while no job exists, or at a longer
  interval) is a product change with failure-detection trade-offs: **proposed as a separate
  story, not made here.**

## 2. Audio pipeline

### What is real and what is fake

| Part | Status |
|---|---|
| `JobPipeline`, status transitions, result store, PostgreSQL writes | Real |
| `FfmpegAudioProcessor` with real `ffmpeg`/`ffprobe` (tempo, timeline placement, MP3 encode, verification) | Real |
| Timed transcript parser, blocks, timeline plan | Real |
| Translation | Product `MockTranslationProvider` (no network). The pronunciation detector that runs after a **real** translation is not exercised [U] |
| Speech | Synthetic tone WAV fixtures (24 kHz mono 16-bit, like Azure's output) copied into the job work dir; one file for plain, one clip per block for timed. **No Azure latency, rate limit (20 requests/min) or response size is represented** [U] |
| Cognito / Supadata / Azure | Never called |

Fixtures are generated at run time from a seeded synthetic transcript and deleted afterwards;
nothing audio-like is committed.

### Workloads

Synthetic YouTube-style transcript at about 150 words/minute. Plain speech is 20 % longer than
the target, so the tempo filter always runs. Speed 1.0x. Duration is the transcript's own
timestamp span.

| Name | Words | Audio | Why |
|---|---|---|---|
| short | 150 | 59 s | Representative short case |
| guest_limit | 1,000 | 397 s (6.6 min) | `GUEST_MAX_WORDS` is 1,000 (the guest output cap of 600 s was not reached at this word count) |
| long | 3,000 | 1,204 s (20 min) | Longer than a guest case; **assumed** invitation size, not a product limit |

Modes: plain and timed. Concurrency 1 and 2 (the production `JOB_MAX_CONCURRENCY` is 2).
Repeats: 4 unlimited, 3 at 0.5 CPU, 2 at 0.1 CPU (the first run is reported as warm-up; spread
uses the rest, so at 0.1 CPU it is a single run). `long` was not run at 0.1 CPU.

### Method

One throwaway container per case. Wall time per run and per stage (fake-speech copy, FFmpeg
stage) from `perf_counter`. Peak memory = sum of RSS (`/proc/*/status`) of the benchmark
Python process plus all `ffmpeg`/`ffprobe` processes, sampled every 50 ms; the Python part is
the whole harness (it includes the application imports, comparable to the idle app's 104 MB
RSS above, plus a few MB of database/result handling). CPU = container cgroup `cpu.stat` delta
(Python + FFmpeg, all threads). Peak temp disk = job work directories plus the result store,
polled every 200 ms. A run is valid only if every job is `completed`, the decoded MP3 sample
count equals the target (both present), outputs exist, no work directory or FFmpeg process is
left and no OOM kill was recorded. Guards: 900 s run timeout and a 3 GiB temp-disk limit, both
checked every 50 ms by the supervising loop while jobs run; a trip kills FFmpeg and waits a bounded
grace period (15 s), and work that still does not end makes the process exit. **The disk guard is
a periodic size check (200 ms), not a filesystem quota:** the limit can be exceeded by whatever is
written within one period (a single large file copy can overshoot by tens of MB) before the run is
stopped.

### Results [M]

Median (min–max) of runs after the warm-up. "CPU-s" is per job. Full table with warm-up
columns: `benchmarks/infra/results/cb71cd2/audio-summary.md`. All 28 cases: every run
completed, MP3 sample count matched, no OOM kill, no leftover work directory.

**No CPU limit** (16 CPUs available)

| Workload | Mode | c | Wall s | CPU-s | Peak RSS MB (of which FFmpeg) | Peak temp disk MB | MP3 MB |
|---|---|---|---|---|---|---|---|
| short 59 s | plain | 1 / 2 | 1.0 / 1.1 | 1.5 / 1.6 | 152 (51) / 204 (103) | 10 / 19 | 0.71 |
| short 59 s | timed | 1 / 2 | 0.7 / 0.8 | 1.0 / 1.1 | 153 (53) / 208 (106) | 8 / 19 | 0.71 |
| guest_limit 397 s | plain | 1 / 2 | 3.3 / 3.6 | 5.4 / 5.8 | 153 (52) / 205 (103) | 79 / 153 | 4.77 |
| guest_limit 397 s | timed | 1 / 2 | 3.3 / 3.7 | 5.3 / 5.6 | 175 (75) / 252 (150) | 65 / 128 | 4.77 |
| long 1,204 s | plain | 1 / 2 | 9.4 / 10.7 | 15.4 / 16.9 | 153 (53) / 208 (106) | 242 / 479 | 14.45 |
| long 1,204 s | timed | 1 / 2 | 9.6 / 11.1 | 15.6 / 17.1 | 199 (99) / 301 (198) | 206 / 408 | 14.45 |

**`--cpus=0.5 --memory=512m`** (simulates a 0.5 CPU / 512 MB instance)

| Workload | Mode | c | Wall s | Peak RSS MB | Peak temp disk MB |
|---|---|---|---|---|---|
| short | plain | 1 / 2 | 3.7 / 8.5 | 153 / 204 | 12 / 23 |
| short | timed | 1 / 2 | 2.6 / 5.1 | 154 / 210 | 9 / 20 |
| guest_limit | plain | 1 / 2 | 11.8 / 27.8 | 152 / 206 | 80 / 160 |
| guest_limit | timed | 1 / 2 | 11.5 / 27.0 | 176 / 252 | 68 / 137 |
| long | plain | 1 / 2 | 35.2 / 82.3 | 153 / 207 | 244 / 489 |
| long | timed | 1 / 2 | 35.5 / 83.1 | 200 / 304 | 211 / 421 |

**`--cpus=0.1 --memory=512m`** (simulates the documented Render Free size, 0.1 CPU / 512 MB [P];
concurrency 1, 1 measured run after the warm-up)

| Workload | Mode | Warm-up s | Wall s | Peak RSS MB | Peak temp disk MB |
|---|---|---|---|---|---|
| short | plain / timed | 28.9 / 16.1 | 26.6 / 20.6 | 154 / 155 | 12 / 10 |
| guest_limit | plain / timed | 117.6 / 98.0 | 123.7 / 111.7 | 154 / 176 | 81 / 69 |

Reading the numbers:

- Work is CPU-bound: CPU-seconds are roughly constant (about 15 CPU-s for 20 minutes of audio),
  and wall time scales with the CPU quota (0.5 CPU ≈ 3–4x slower than unlimited, 2 concurrent jobs
  ≈ 2.3x slower than one). With a 0.1 CPU quota a 6.6-minute job took about 2 minutes. A 20-minute
  job at 0.1 CPU is **not measured**; extrapolating 17.6 CPU-s / 0.1 gives roughly 3 minutes [estimate, U].
- The summed RSS of the benchmark Python process and FFmpeg stayed below 310 MB in every case, and
  no OOM kill occurred **in the workloads measured**. That is not evidence that 512 MB is enough
  for production: the figure is process RSS only, not the container's whole memory. The idle app
  alone showed 154 MB of cgroup memory against 104 MB RSS (page cache, kernel and other memory
  that RSS does not include; cgroup peak was not recorded), and the harness runs without the web
  server, the liveness loops, real Azure responses or web traffic. No test pushed toward OOM on
  purpose. Each FFmpeg process adds about 50 MB; timed mode starts more of them at the same time
  (up to 198 MB of FFmpeg RSS for two 20-minute jobs).
- Peak temp disk grows with audio length and concurrency: 489 MB for two 20-minute plain jobs,
  because the lossless speech WAV (about 69 MB for the 24 minutes of plain speech) and the
  tempo-adjusted and decoded copies live in the work dir together. Finished MP3s add 0.71 MB per minute
  and stay in the result store for `RESULT_TTL_SECONDS` (3,600 s).
- The tempo filter dominated wall time: 3–5 FFmpeg starts per plain job, 1–3 per timed job [M].

### Not covered [U]

Azure Translator/Speech latency and the Speech rate limit (these will dominate wall time for real
jobs, see `scripts/timed_benchmark.py` part (b) for the simulated limiter wait); real transcripts
and the pronunciation detector; many concurrent web requests during processing; the liveness
loop under a 0.1 CPU quota while FFmpeg runs (a starved heartbeat could in theory let the 90 s
stale check fire; this was not observed because the harness runs the pipeline without the web
server); real Render disk size and I/O; memory beyond process RSS (cgroup peak, page cache).

### Verification of the review fixes

Run after the fixes, on the PR branch, using the `cb71cd2` image (so the measured code is the
same): unit tests (`test_harness.py`), `test_scripts.sh` (startup deadlines with a never-ready and
an early-exit container including credential masking, `run-idle.sh` with an app that exits at
once, run isolation, results-directory refusal, nine exit-code cases and a two-case matrix with
one failure), and three small real-pipeline smoke runs (not statistics):

| Smoke run | Result |
|---|---|
| short plain, 2 jobs, 3 runs | passed; decoded = target = 1,416,000 samples in every job; no leftovers; wall 1.5-2.7 s (the schema 1 median was 1.1 s: a smoke run on a busy machine, not a new measurement) |
| guest_limit plain with `--max-temp-mb 5` | stopped by the disk guard after 0.47 s (limit 5 MB, peak seen 30 MB because a large file copy overshoots a periodic check); case FAILED, exit 1, no FFmpeg left |
| guest_limit plain with `--run-timeout 0.4` | stopped at the deadline (0.46 s); case FAILED, exit 1 |

These are conditional evidence that the scripts behave as described; they say nothing new
about performance.

## 3. Cost estimate (conditional)

Product Owner statement: current plans are all Free. Audio-provider costs (Translator, Speech)
are **not** infrastructure and are excluded.

### Published facts used (fetched 2026-11-01)

| Item | Value | Source |
|---|---|---|
| Neon Free | 100 CU-hours/project/month, 1 GB storage/project, 5 GB egress, scale-to-zero after 5 min (fixed); compute suspended when CU-hours or transfer are used up, until next period | neon.com/pricing, neon.com/docs/introduction/plans |
| Neon Launch | pay as you go, no monthly minimum; $0.106 per CU-hour; $0.35 per GB-month; 500 GB egress included; scale-to-zero 5 min, can be disabled | same |
| Neon CU-hour | compute size × hours running (0.25 CU for 4 h = 1 CU-hour); suspended compute costs nothing; resume typically within a few hundred ms | same, neon.com/docs/introduction/scale-to-zero |
| Render Free web service | 0.1 CPU, 512 MB; 750 free instance hours/workspace/month; spins down after 15 min without inbound traffic; spin-up takes about one minute; ephemeral filesystem (lost on restart, redeploy, spin-down); no persistent disk; may be restarted at any time; "do not use for production" | render.com/docs/free, render.com/docs/compute-plans |
| Render paid web instances | Starter 0.5 CPU/512 MB, Standard 1 CPU/2 GB, Pro 2 CPU/4 GB (plan IDs `0.5c-512mb`, `1c-2g`, `2c-4g`) | render.com/docs/compute-plans |
| Render workspace | Hobby free (5 GB outbound included); Pro $25/month flat (25 GB included); outbound beyond included $0.15/GB | render.com/changelog/updated-plans-for-render-workspaces, render.com/docs/outbound-bandwidth |
| **Not found** | Monthly USD price per paid Render web instance; persistent disk price per GB; a Free-instance disk size; free workspace bandwidth cap wording for Free services; Neon's exact definition of "activity" | pricing pages are rendered by JavaScript and the docs link to them |

The unknown Render prices are left blank on purpose: no remembered or third-party number is
used. The Product Owner should read them in the Render dashboard (read-only) before deciding.

### Neon model

Assumptions: compute fixed at the smallest size (0.25 CU) [U: the autoscaling minimum on the
real project was not seen]; 730 hours per month; storage under 1 GB; egress negligible.

| Case | CU-hours/month | Free (100 CU-h) | Launch ($0.106/CU-h) |
|---|---|---|---|
| Asleep except when used (for example 100 awake hours) | 25 | Fits | 25 × 0.106 ≈ $2.65 + storage |
| Awake whenever the app runs, app runs continuously | 0.25 × 730 = 182.5 | **Does not fit**: exhausted after about 400 awake hours (about 16.7 days), compute then suspended until the next period [P] | 182.5 × 0.106 ≈ **$19.35** + storage (1 GB × $0.35) ≈ **$19.7** |

So combining an always-on app instance with Neon Free would exhaust the Free compute allowance
mid-month (published rule), and the database would be suspended until the next period or an
upgrade. Neon on Launch costs about $20/month if it is awake all the time, by this model.
At 0.5 CU the awake case doubles. This is arithmetic from published rates, not a bill.

### Render options (conditional resource fit, not proven production capacity; prices [U])

| Option | Fits the measured profile? | Behavior / risk |
|---|---|---|
| Free (0.1 CPU, 512 MB) | Conditional: measured RSS ≤ 310 MB, but see the memory caveat above; a 6.6-minute job took about 2 minutes under a 0.1 CPU quota; longer jobs several minutes [M, partly estimated] | Spins down after 15 minutes idle; about one minute cold start for the next visitor; results are lost on spin-down/restart; not for production per Render; 750 h/month cap. Idle spin-down is what lets Neon sleep |
| Starter (0.5 CPU, 512 MB) | Conditional (same memory caveat); 0.5 CPU gave 12 s / 35 s for 6.6 / 20 minutes alone, 27 s / 82 s with two jobs | Always on: no cold start, but then Neon is awake all month (about $20 Neon Launch by the model, or Free exhausted). Still no persistent disk requirement while results stay short-lived. Price: not found |
| Standard (1 CPU, 2 GB) | Headroom for 2 concurrent long timed jobs (300 MB) and ~2x faster than 0.5 CPU if the quota scaling holds [U] | Price: not found |

No claim is made about how many users or jobs any plan will carry: the benchmark has no
Azure latency, no web traffic and no real transcripts. Use the Azure rate limit (20 speech
requests/minute on Free F0) and the concurrency setting (2) as the practical throttle, and
size from the real usage once the per-job usage story is merged.

### Cold start, ephemeral files, egress

- Cold start (Render Free) about one minute [P]; Neon resume a few hundred milliseconds [P].
  The Neon resume latency on the real account was not measured [U].
- Results are written to the instance's local disk and expire after one hour [C]; on Render
  Free they also vanish at spin-down or restart [P]. The temp disk measured here (up to
  about 490 MB for two 20-minute jobs) must fit the instance's ephemeral disk, whose size is
  [U].
- Egress: finished MP3s are about 0.71 MB per minute (96 kbit/s). 1,000 downloads of a
  10-minute result is about 7 GB, which is above the free workspace allowance (5 GB) and
  would cost $0.15/GB beyond it on a plan without more included bandwidth [P + arithmetic].
  Real download counts are [U].

## 4. Risks and bottlenecks

1. **Heartbeat/stale check every 15 s keeps Neon awake** while the app runs [M]. Biggest cost lever
   (about $20/month on Launch, or Free exhausted in about 17 days).
2. Audio processing is CPU-bound; on 0.1–0.5 CPU instances a long job takes minutes of wall time
   and two concurrent jobs double it [M].
3. Temp disk up to about 0.5 GB for two 20-minute jobs, on an ephemeral disk of unknown size [M, U].
4. Free instances: cold start, restarts at any time, 750 h cap, "not for production" [P].
5. Real wall time will be dominated by Azure Speech latency and its rate limit, not measured here [U].

**Findings for separate stories (no product code changed here):** reduce idle DB activity
(stale check cadence while no jobs); a disk guard or per-job temp budget if the host's disk is
small; measure the liveness loop under a CPU quota with the web server running.

## 5. What to check on the real accounts (read-only)

Product Owner only; nothing here was accessed by this work.

- Neon console → project → Monitoring: compute **active time / CU-hours** this month and the
  compute size range; Billing: current plan and usage. Whether the compute shows as "idle/suspended"
  between app uses.
- Render dashboard → service → Metrics (CPU, memory, restarts, instance hours used of 750) and
  Events (spin-down/up); workspace Billing for the plan and bandwidth used. Paid instance
  prices and the instance's disk size are shown when choosing a plan.
- Do not run load against production. Compare the numbers with this document before any upgrade;
  upgrading, env changes and auto-top-up are Product Owner decisions.

## 6. Re-run on `86c6ca4` and deployment check (2026-11-01)

Verification only: no product, price or quota change. Raw results:
[results/86c6ca4/](../benchmarks/infra/results/86c6ca4/) (`run-v2idle/`, `run-v2matrix/`). These are
**new local measurements [M]** made with harness **schema 2** on the image built from `86c6ca4`
(`main` after PR #48 usage records and PR #49). The `cb71cd2` numbers above stay as **legacy-v1**
and were not overwritten. Environment as in "Test environment" (Docker Desktop, 16 CPUs, run
sequentially, nothing else of this project running; other unrelated containers were present on the
machine, so wall times carry some noise). Fake Azure, real FFmpeg, isolated PostgreSQL 17, no
production, no Azure/Supadata/Cognito. Harness checks ran first: 12 unit tests and
`test_scripts.sh` all pass. The full matrix (28 cases, concurrency 1 and 2, 3 runs after a warm-up)
finished with exit 0 and every case validated (`audio-summary.md`: no FAILED row). Not measured
here: Azure latency, the web server under load, cgroup peak memory, a 20-minute job at 0.1 CPU
(not in the matrix).

**Idle (660 s, defaults, no users):** 408 statements, 216 without BEGIN/COMMIT (legacy: 396 / 208);
longest gap without any statement 15.0 s; stale-job check (2 statements) every 15.0 s; cleanup every
300 s. The extra 8 statements per window are the two usage-retention DELETEs
(`job_usage_attempts`, `job_usage`) that cleanup now runs every 300 s. CPU 8.3 s per 660 s
(legacy 9.9 s). RSS 105 MB; cgroup memory 82 MB at the end (legacy 154 MB; cgroup memory depends on
page cache and is not a stable figure). The conclusion is unchanged: while the app runs, the DB sees
a statement at least every 15 s **[M, local]**, so Neon's 5-minute autosuspend [P] cannot trigger;
whether production Neon really stays awake is not verified.

**Audio, against legacy-v1 (median wall s, same workloads):**

| Case | New | Legacy |
|---|---|---|
| unlimited long plain c1 / c2 | 10.3 / 11.9 | 9.4 / 10.7 |
| 0.5 CPU long plain c1 / c2 | 36.6 / 81.8 | 35.2 / 82.3 |
| 0.5 CPU long timed c2 | 87.9 | 83.1 |
| 0.1 CPU guest_limit plain c1 | 110.9 | 123.7 |
| 0.1 CPU short plain c1 | 30.7 | 26.6 |

Peak RSS (python + FFmpeg) is within 1-3 MB of legacy in every case (max 303 MB, long timed c2) and
peak temp disk matches (max 487 MB, long plain c2). Wall times are within about ±15 % (single
runs at 0.1 CPU vary more). No timeout, no OOM, no disk-guard trip. The usage recording added by PR
\#48 is not exercised by this harness (it calls the pipeline directly with the fake provider), so
it does not show up in these numbers. RSS is still not the container's memory and does not prove
that 512 MB is enough for production.

**Deployment (read-only, from GitHub Actions logs) [M, indirect]:** the `Deploy to Render` job of the
CI run for merge commit `86c6ca4` (run 41353266464) reports Render deployment
`dep-dbjr8a7f3r2c73ctu3k0` **live for commit 86c6ca4** at 2026-11-01 21:51:33 UTC, service
`mydubb` (auto-deploy off), and the following production smoke check passed (health ok, ready with
database ok, providers azure/azure/ffmpeg, mock_mode false). The earlier merge `0c7a0b0` (PR #48)
was also reported live (run 41347929701, 20:47 UTC). `86c6ca4` contains PR #48 and #49.
Migration `0020`: the container entrypoint runs `alembic upgrade head` and exits on failure
(default `RUN_MIGRATIONS_ON_START=true`; the value set on Render was not readable), so a deployment
that went live with a ready database implies the migration ran. This is inference, **not** direct
evidence: neither the Render logs, `alembic_version` nor the existence of the two usage tables
was seen. Render and Neon dashboards, production metrics and the production usage report were not
accessible, so plan, CPU/memory, restarts, spin-downs, Neon active/idle hours, CU-hours, storage and
real job usage are **unverified** (see section 5 for what to read).

**Production usage:** no access; no number reported. Jobs created before the deploy have no usage
rows by design. Until real jobs after the deploy are counted (`usage_report`, read-only, UTC), the
conclusion is "not enough data"; synthetic data must not stand in for it.
