# Guest access ("Try as guest")

People without an invitation can try the Studio: on the sign-in screen, **Try as guest** opens a
guest session, and the guest pastes a transcript, generates the translation and audio, listens
and downloads it, like an invited user but with quotas. HTTP contract: [API.md](API.md#guest-access).

Off by default (`GUEST_ACCESS_ENABLED=false`); it needs `AUTH_MODE=cognito`. Nothing in production
was changed by the pull request that added it (see "Enabling" below).

## What a guest can and cannot do

| Allowed | Not allowed |
|---|---|
| Start, read and end its own guest session (`/api/guest/session`) | YouTube caption import (`POST /api/transcripts/youtube` answers `403 guest_not_allowed`; the UI does not offer it) |
| Create jobs (`POST /api/jobs`): plain and timed mode, glossary, both voices, every speed, FFmpeg, the same pipeline as accounts | Reading any job that is not its own guest session's (`404 job_not_found`, like any foreign job) |
| Poll, read the result of and download its own jobs | Account endpoints (`/api/auth/me`, `/api/auth/logout`: `401`) and any administration |

A guest is its own principal (`Principal.guest`), never a Cognito user or an Access Code session:
`require_session`, which every account-only endpoint uses, never accepts a guest session; only the
job endpoints (`require_job_session`: account first, then guest) and the guest endpoints read it.
Guest jobs carry `jobs.guest_session_id` (and `user_id` / `session_id` `NULL`).

Opening the page or starting a guest session never calls Azure (or Supadata): only submitting a
job does, exactly as for accounts.

## Quotas

| Limit | Default | Setting | Counted |
|---|---|---|---|
| Jobs per guest session | 5 | `GUEST_JOBS_PER_SESSION` | Completed jobs over the session's lifetime |
| Jobs per client network | 20 per sliding 24 hours | `GUEST_JOBS_PER_IP`, `GUEST_IP_WINDOW_SECONDS` | Completed jobs of **every** guest session from that network; a used job counts from its completion |
| Words per guest job | 1,000 | `GUEST_MAX_WORDS` | The text that would be translated (`CreateJobRequest.spoken_text`: the cleaned transcript in plain mode, the blocks in timed mode), so timestamp lines and cue markup never count; a word is a whitespace-separated token with a letter or digit |
| Guest sessions started per network / overall | 10 / 300 per hour | `GUEST_SESSIONS_PER_IP`, `GUEST_SESSIONS_GLOBAL`, `GUEST_SESSION_RATE_WINDOW_SECONDS` | Bounds how fast new sessions (and rows) can be created |

Invitation accounts have none of these limits (no quota row is written for them).

The backend decides every limit; the UI only previews the word count and shows the remaining jobs
the server reports (`GET /api/guest/session`).

### Lifecycle of a quota place

`guest_job_quota` holds one row per guest job: `reserved` → `used` or `released`.

1. **Accepted:** the job row and its `reserved` row are written in one transaction, after both
   quotas were checked under the guest session's row lock (`SELECT … FOR UPDATE`) and a
   transaction-scoped advisory lock of the network, always in that order. Concurrent requests of
   one session or one network are serialized, so together they never pass a quota (tested with
   12 concurrent requests on one session and 28 concurrent sessions on one network; removing
   either lock makes those tests fail). A reserved place counts like a used one.
2. **Completed:** `used`, in the same transaction as `processing → completed`.
3. **Failed** (provider, internal error, interrupted by a restart or deploy): `released`, in the
   same transaction as the failure.
4. **Never charged:** validation errors (`422`, including the word limit), `403` CSRF/Origin,
   `401`, `409 timing_mode_unavailable`, `503 server_at_capacity` (the executor slot is reserved
   before the quota, and nothing is written when it is full), and any request refused by a quota.

Settling (`guest/service.py: settle_jobs`) only changes rows still `reserved` and only for jobs in
a terminal state, so a place is charged or given back exactly once, whatever runs it twice
(retries, a late worker, recovery). Terminal job states never change (compare-and-set).

**Crash and restart recovery.** Startup recovery and the liveness loop fail only jobs whose
heartbeat is stale (`JOB_STALE_AFTER_SECONDS`), and give their places back in the same
transaction; a job still running on another live instance (overlapping deploy) keeps its
heartbeat and its place. The periodic cleanup also settles any reserved row whose job already
ended without settling it (for example a job failed by an instance running code from before this
feature).

## Guest session and cookie

- `POST /api/guest/session` creates a random 256-bit token, sent only as the `mydubb_guest`
  cookie (HttpOnly, `SameSite=Strict`, `Secure` in production, path `/`). `guest_sessions`
  stores its SHA-256 hash, the CSRF token, the network's keyed hash, `created_at`, `expires_at`,
  `revoked_at`. Like the other sessions: synchronizer CSRF token in `X-CSRF-Token` for
  `POST /api/jobs` and `DELETE /api/guest/session`, plus the Origin check on every unsafe API
  request. The CSRF token is kept in page memory only.
- **Lifetime: 24 hours, absolute** (`GUEST_SESSION_TTL_SECONDS`, at most the network window).
  Nothing extends it: calling `POST /api/guest/session` with a valid guest cookie returns the same
  session unchanged (no new token, no new expiry, same quota), so asking again never resets a
  quota.
- Ending it (`DELETE /api/guest/session`, "Leave guest mode" / "Sign in with an invitation")
  revokes the row and deletes the cookie. Its jobs are not moved anywhere and become unreachable.
- **Signing in to an account ends the guest session** of that browser (revoked, cookie deleted)
  in the same response that sets the account cookie. Jobs never move between a guest and an
  account, and signing out later never falls back into guest mode. A signed-in browser cannot
  start a guest session (`409 already_signed_in`).
- Clearing cookies or another browser gives a new guest session (a new 5), but the same network
  quota. This is accepted: there is no device fingerprinting, CAPTCHA or email check.

## Client network (IP) and its trust boundary

The network quota needs the client's address, and a wrong one either merges unrelated guests or
lets one escape the limit, so `guest/client_ip.py` is stricter than the brute-force protection:

- **With `CLIENT_IP_HEADER`** (production: `cf-connecting-ip`): exactly one occurrence holding
  exactly one IP address is accepted. A missing header, a repeated header, a comma list, a port,
  a zone id or anything that is not an address: the request is refused with
  `503 guest_network_unknown` (session start and job creation). `X-Forwarded-For` is never read:
  Render's proxy appends to a client-supplied one, so its left-most entry is whatever the client
  sent. uvicorn's `--proxy-headers` with `FORWARDED_ALLOW_IPS="*"` makes the peer address come from
  that header, so the peer address is not used either.
- **Without it** (local development, tests): the connection peer, also only if it is an address.
  Production refuses to start with guest access on and no `CLIENT_IP_HEADER`.
- **Normalization:** IPv4 as is; an IPv4-mapped IPv6 address as its IPv4; other IPv6 grouped by
  its **/64** prefix (a subscriber usually holds a whole /64 and could take a new address per
  request).
- **Storage:** only `HMAC-SHA256(GUEST_IP_HASH_KEY, network)` (64 hex characters) is stored, in
  `guest_sessions.ip_key` and `guest_job_quota.ip_key`. The key is its own secret (32 random bytes,
  URL-safe base64); startup refuses it if it equals `AUTH_TOKEN_ENCRYPTION_KEY`. Rotating it only
  makes existing counts unrecognizable (every network starts fresh for at most a day).
- **Logs**: the application's own log lines never contain the address, its hash, the token or the
  transcript. Not changed by this feature: uvicorn's access log (on by default since Milestone 1)
  prints the connection's client address for every request, including guest requests; behind
  Render's proxy that address comes from `X-Forwarded-For`. Turning it off (`--no-access-log`) or
  masking it is a separate operations decision.

**Render.** Both `https://mydubb.com` and the direct `https://mydubb.onrender.com` go through
Render's edge; the deployment notes record that `cf-connecting-ip` is present on production
requests (no "configured but absent" warning; DEPLOYMENT.md, "Current deployment"). Render does
not document its proxy chain or that this header is always overwritten; it is Cloudflare's header,
which Cloudflare sets to the address that connected to it. This was not re-verified for this
feature (no production request was made). Cookies are per host, so a guest on the onrender.com
host has a separate guest session, but the same network quota. If Render ever stops sending the
header, guests get `503 guest_network_unknown` (fail closed), not a shared or bypassable quota.

**Known limits of a network quota:** everyone behind one address (a family, an office, a school,
mobile carrier NAT) shares the 20 jobs; a VPN or another network gives a new quota.

## Retention

Run by the periodic cleanup (`CLEANUP_INTERVAL_SECONDS`, also at startup), also while guest access
is off:

- `guest_job_quota`: `used`/`released` rows once they left the network window (24 hours after
  their charge/settlement). `reserved` rows are never deleted; their job settles them.
- `guest_sessions`: expired or ended sessions once they no longer count towards the
  session-start limit (1 hour after creation). Their jobs keep their metadata with
  `guest_session_id = NULL` (unreachable), like Access Code jobs after session cleanup.
- Job metadata itself has no cleanup yet (existing limitation, context.md section 6).

Because session starts are limited per network and overall, the tables stay bounded: at most
`GUEST_SESSIONS_GLOBAL` new sessions per hour, each kept about a day.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GUEST_ACCESS_ENABLED` | `false` | Needs `AUTH_MODE=cognito` |
| `GUEST_IP_HASH_KEY` | none | Required when enabled; 32 random bytes, URL-safe base64 (`python -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"`); never the auth key |
| `CLIENT_IP_HEADER` | none | Required in production when enabled (`cf-connecting-ip` on Render, already set by `render.yaml`) |
| `GUEST_SESSION_TTL_SECONDS` | `86400` | Absolute; at most `GUEST_IP_WINDOW_SECONDS` |
| `GUEST_JOBS_PER_SESSION` | `5` | |
| `GUEST_JOBS_PER_IP` | `20` | |
| `GUEST_IP_WINDOW_SECONDS` | `86400` | Sliding window of the network quota |
| `GUEST_MAX_WORDS` | `1000` | |
| `GUEST_SESSIONS_PER_IP` / `GUEST_SESSIONS_GLOBAL` / `GUEST_SESSION_RATE_WINDOW_SECONDS` | `10` / `300` / `3600` | Session starts |

`/api/meta` reports `guest_access` (`enabled` and, when on, the limits).

## Enabling (a Product Owner decision; not done)

1. Merge and deploy; migration `0007` runs at startup whether or not the feature is on.
2. Render → Environment: add `GUEST_IP_HASH_KEY` (generate locally, never reuse another key) and
   `GUEST_ACCESS_ENABLED=true`. `CLIENT_IP_HEADER=cf-connecting-ip` is already declared in
   `render.yaml`. Save (Render redeploys).
3. Check `/api/meta` → `guest_access.enabled=true`, then on https://mydubb.com: "Try as guest",
   one short job, the banner count, and Render logs without
   `CLIENT_IP_HEADER … configured but absent`.

Guests spend the same Azure Free (F0) allowance as accounts: at the defaults, one network can use
up to 20 jobs × 1,000 words a day, and many networks more. Watch the Translator and Speech usage
after enabling.

**Turning it off:** `GUEST_ACCESS_ENABLED=false`. Guest endpoints answer `404`, guest cookies are
ignored, guest jobs become unreachable, and the cleanup still removes old guest rows.

## Tests

Backend (`tests/test_guest_access.py`, PostgreSQL, mock providers, fake Cognito): configuration,
session cookie/hash storage, no renewal, CSRF/Origin, ownership both ways, YouTube import and
account endpoints refused, sign-in ends the guest session, accounts unlimited, word limit with
timestamps, 5 per session, 20 per network shared by sessions, IPv6 /64, sliding window boundary,
failure releases, concurrency, idempotent settling, recovery that spares live instances, startup
recovery, retention, session-start limits, proxy headers, logs. Frontend
(`src/App.guest.test.tsx`, `src/lib/wordCount.test.ts`). Browser (`e2e/tests/auth.guest.spec.ts`,
desktop and mobile Chromium).
