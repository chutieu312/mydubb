# Chrome extension: connecting to a MyDubb account

How the MyDubb Chrome extension ([extension/README.md](../extension/README.md)) gets access to the
job endpoints for a **MyDubb account** (Cognito mode; invited or self-registered, both Free), and,
when the server offers it, for the **guest session** of mydubb.com in the same Chrome profile
([Guests](#guests-try-as-guest-in-the-extension)). Status: implemented and tested locally (backend
against the fake user pool, extension against a fake MyDubb server, and an integration check with
Chrome's real sign-in window against the real backend). `EXTENSION_IDS` on production is the
Product Owner's setting; the guest part is off until `EXTENSION_GUEST_ENABLED=true`.

## Why this design

The extension is a public client: it cannot keep a secret, and it must not see the user's password
or the website's cookie. MyDubb's sign-in is its own API in front of Cognito (no Hosted UI, see
[AUTHENTICATION.md](AUTHENTICATION.md)), and the website session is a `SameSite=Strict`, HttpOnly
cookie that an extension page does not (and must not) use. So MyDubb itself acts as the
authorization server for one flow, **OAuth 2.0 Authorization Code with PKCE (S256)**:

```
Side panel                         Chrome sign-in window                MyDubb backend
  │ verifier, S256 challenge, state  (chrome.identity.launchWebAuthFlow)
  ├──────────── open ─────────────► https://mydubb.com/extension/connect?client_id=<ext id>&
  │                                  redirect_uri=https://<ext id>.chromiumapp.org/&state&code_challenge
  │                                  │ normal website sign-in (email + password on mydubb.com)
  │                                  │ "Connect extension"  ── POST /api/extension/authorize ──►  code (one-time, 2 min,
  │                                  │                          (website session + CSRF + Origin)   SHA-256 stored)
  │ ◄── Chrome captures redirect ─── https://<ext id>.chromiumapp.org/?code&state
  │ checks state, then
  ├──── POST /api/extension/token {code, code_verifier, client_id, redirect_uri} ────────────────►  S256(verifier) = challenge?
  │ ◄──────────────────────────────────── {access_token, expires_at, user} ───────────────────────  user_sessions row, client='extension'
  │ Authorization: Bearer <token> on /api/jobs*  (credentials: "omit")
```

- No Cognito change: no app client, Hosted UI, callback URL or secret. Cognito still only sees the
  website's normal sign-in.
- The password is typed only on mydubb.com. The extension never reads cookies, never sees a Cognito
  token, and does not use the website session.
- The token is opaque (256 bits), only its SHA-256 is stored, it lives at most
  `EXTENSION_SESSION_TTL_SECONDS` (default and maximum 12 h, never longer than
  `SESSION_TTL_SECONDS`) and is never extended. It is a `user_sessions` row with
  `client='extension'`, so **every existing revocation ends it too**: password reset, the
  administrator's `revoke-sessions` and `disable`, and a reset whose outcome is unknown. A token
  issued from a website session carries that session's `auth_started_at`, so a revocation that covers
  the approving sign-in also refuses the code and the token made from it.
- A cookie never accepts an extension token and a bearer header never accepts a website token
  (`find_active_user_session(..., client)`).
- Like a website session, the token is not re-checked against Cognito: disabling a user only in
  Cognito does not end it (use the administrator tool, AUTHENTICATION.md).

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `EXTENSION_IDS` | `[]` (off) | JSON list of Chrome extension IDs (32 letters `a`-`p`) allowed to connect. Each is the `client_id` and fixes the only redirect URI `https://<id>.chromiumapp.org/` (exact match). Needs `AUTH_MODE=cognito`. Empty: every `/api/extension/*` endpoint answers `404 extension_disabled` and bearer tokens are refused |
| `EXTENSION_SESSION_TTL_SECONDS` | `43200` | Token lifetime, 60-43200 s, capped by `SESSION_TTL_SECONDS` |
| `EXTENSION_GUEST_ENABLED` | `false` | "Try as guest" in the extension ([Guests](#guests-try-as-guest-in-the-extension)). Takes effect only while `GUEST_ACCESS_ENABLED=true` and `EXTENSION_IDS` is set, so turning guest access off turns it off too (no startup error). `/api/meta` reports it as `guest_access.extension` |

The extension build fixes the server: `MYDUBB_ORIGIN` (default `https://mydubb.com`) becomes its only
host permission (see the extension README).

### Extension IDs: unpacked vs published

- **Load unpacked**: Chrome derives the ID from the folder's absolute path (no `key` in the
  manifest), so it is different on each computer and for each folder. Read it on
  `chrome://extensions` (Developer mode shows the ID on the card) after loading `extension/dist`.
- **Chrome Web Store** (not done): the store assigns a different, permanent ID.
- Both can be listed at the same time. A stable unpacked ID would need a `key` in the manifest; that
  is not done (and `check:dist` refuses a manifest with `key`), because it is a publishing decision.

### What the Product Owner sets up (not done)

1. Load the extension unpacked (README), copy its ID.
2. Render → service `mydubb` → Environment: `EXTENSION_IDS=["<that id>"]`, then let Render redeploy
   (a configuration change; nothing else changes for the website, invitation or guest sign-in).
3. Check: `curl -s -X POST https://mydubb.com/api/extension/token -H 'Content-Type: application/json' -d '{}'`
   answers `422 validation_error` (enabled) instead of `404 extension_disabled`.
4. Turning it off: remove `EXTENSION_IDS` (tokens are then refused at once; rows expire by themselves).

Migration `0011` (expand-only) runs on deploy whether or not `EXTENSION_IDS` is set.

## HTTP contract

All bodies are JSON; errors are `{"error": {"code", "message", ...}}` like [API.md](API.md).

| Endpoint | Caller | Auth | Answer |
|---|---|---|---|
| `POST /api/extension/authorize` `{client_id, redirect_uri, state, code_challenge, code_challenge_method: "S256"}` | the website page `/extension/connect` | website account session + `X-CSRF-Token` + same-origin `Origin` (guests: `401`) | `200 {"redirect_url": "<redirect_uri>?code=…&state=…"}`; `400 extension_unknown`, `400 redirect_uri_mismatch`, `422 validation_error` (state 16-128 URL-safe characters, challenge 43 base64url characters), `404 extension_disabled` |
| `POST /api/extension/guest/authorize` (same body) | the website page `/extension/connect?mode=guest` | website **guest** session (`mydubb_guest` cookie) + `X-CSRF-Token` of that session + same-origin `Origin` | `200 {"redirect_url": ...}` like above; `404 extension_guest_disabled` while guests are not offered; `401` without a live guest session; `409 already_signed_in` if the browser also has an account session. Starts no guest session and writes no quota |
| `POST /api/extension/token` `{grant_type: "authorization_code", client_id, redirect_uri, code, code_verifier}` | extension | none (the code and the verifier) | `200 {access_token, token_type: "Bearer", expires_at, kind: "account", user: {id, email, display_name}, guest: null}`, or for a guest code `{..., kind: "guest", user: null, guest: {id}}` (`id` = the guest session); every failure (unknown, expired, used, other client or redirect, wrong verifier, user revoked or disabled since, guest session ended or expired since, guests turned off since) is `400 invalid_grant`. The code is consumed by the **first** attempt, also a failed one |
| `GET /api/extension/session` | extension | bearer | `200 {kind, user, guest, expires_at, usage, quota}`, `Cache-Control: no-store`: an account has `usage` (the same object as `GET /api/account/usage`, today's Free numbers), a guest has `quota` (the same object as `GET /api/guest/session` `quota`); `401 not_authenticated` |
| `POST /api/extension/logout` | extension | bearer | `204`, ends this token only (not the website session, not the guest session); `401` when already invalid |
| `/api/jobs*` | extension | bearer | unchanged contract; see API.md "Chrome extension" |

Origin rule: `chrome-extension://<id in EXTENSION_IDS>` is accepted only for `POST /api/extension/token`
and, with `Authorization: Bearer`, `POST /api/jobs` and `POST /api/extension/logout`. CORS is not
opened: the extension calls MyDubb through its host permission, which Chrome exempts from CORS, and
always with `credentials: "omit"`.

An extension token never carries MyDubb's admin role, also when its user is an administrator: any
`/api/admin*` request with an `Authorization` header gets `401`
([AUTHENTICATION.md](AUTHENTICATION.md#administrators)).

## Guests ("Try as guest" in the extension)

Story 5. The website and the extension in **one Chrome profile** share one guest session: its
`guest_sessions` row, its jobs, the guest quotas (5 jobs per session, 20 per network in 24 hours,
1,000 words and 600 s of audio per job), the place reserved at acceptance and given back on
failure, and the shared non-administrator cap when it is on. Nothing is a second quota: the job
endpoints run exactly the same guest code (`reserve_job` under the guest session's row lock and
the network's advisory lock), whichever client sends the request.

```
Panel "Try as guest"  ── launchWebAuthFlow ──►  /extension/connect?mode=guest&client_id&redirect_uri&state&code_challenge
                                                 │ the window shares the profile's mydubb.com cookies
                                                 │ guest cookie already there?  ── yes ─► "Continue in the extension"
                                                 │                               └ no ──► "Start guest session" (POST /api/guest/session,
                                                 │                                         the website's usual rules)
                                                 │ POST /api/extension/guest/authorize (guest cookie + CSRF + Origin)
  ◄── https://<id>.chromiumapp.org/?code&state ──┘   code: one time, 2 min, SHA-256 stored, bound to the client,
  │                                                  redirect URI, S256 challenge and this guest session
  ├── POST /api/extension/token {code, code_verifier} ──►  guest_extension_tokens row (SHA-256) of that session
  │ ◄── {access_token, kind: "guest", guest: {id}} ──────  expires with the session (never later, never extended)
  │ Authorization: Bearer <token> on /api/jobs* and /api/extension/session|logout only
```

- **Both directions.** Web first: a guest on mydubb.com chooses Try as guest in the panel; the
  sign-in window sees the guest cookie and offers to continue that session (no new session, no new
  quota). Extension first: with no guest session yet, the window offers **Start guest session**,
  which is the website's own `POST /api/guest/session` (session-start limits, network key,
  24 h lifetime), and sets the website's guest cookie in the profile; opening mydubb.com later
  restores that very session and shows the jobs used in the extension.
- **Who the guest is** comes from the website's guest cookie at approval and then from the code and
  the token, never from the request: no guest id, user id or identity in any body or header is
  read. A guest token resolves to `Principal(guest=True, bearer=True, session_id=<guest session>)`,
  so ownership is the website guest's (`jobs.guest_session_id`), and usage records say
  `client=extension, access=guest`.
- **Scope.** The guest token opens only `/api/jobs*` (create, poll, result, audio) and
  `/api/extension/session|logout`. Account endpoints, `/api/guest/*` (cookie only), the YouTube
  import (cookie only) and administration (`401` for any request with an `Authorization` header)
  refuse it; as a cookie it means nothing.
- **Ending.** Disconnect in the extension ends that token only. Leaving guest mode on the website,
  signing in to an account in that browser (which ends its guest session), the session's expiry,
  `EXTENSION_GUEST_ENABLED=false` or `GUEST_ACCESS_ENABLED=false` end every guest token at once
  (checked on every request, joined with the guest session). Trying again or reconnecting gives a
  new token of the same session: never a new quota.
- **Guest to account.** Connect to MyDubb (also offered to a connected guest) replaces the guest
  connection in the panel: the usual change of identity (job, result, loaded audio and playback of
  the guest cleared from every panel; late answers of the guest dropped), then the old guest token
  is ended on the server; the website's guest session itself carries on until it ends there.
  Jobs never move from a guest to an account.
- **Schema** (migration `0022_extension_guest`, expand-only): `extension_auth_codes.user_id` is
  nullable, `guest_session_id` added, CHECK exactly one of the two; table `guest_extension_tokens`
  (`guest_session_id` FK cascade, `token_hash`, `client_id`, `created_at`, `expires_at`,
  `revoked_at`), cleaned up with the guest rows. The previous application version never reads the
  table; if it were asked to exchange a guest code it finds no user and answers `invalid_grant`.

## Rollout (backend, website, Store)

The website must describe what the Store version people install can do at every step, so the
order is fixed. Nothing here is done by the pull request.

| Step | Backend / website | Store | What the website says and the extension shows |
|---|---|---|---|
| 1 | Merge and deploy; migration `0022_extension_guest` runs; `EXTENSION_GUEST_ENABLED` unset (off) | 0.4.1 (published, Udemy only, Connect only) | Sign-in page: "MyDubb for Chrome" with the Udemy, Connect-your-account wording and **Install Chrome extension**. 0.4.1 keeps working: the token and session answers only gain fields it ignores (`kind`, `guest`, `usage`, `quota`) and its requests are unchanged |
| 2 | Same | Upload **0.5.0** (same Item ID `nndofiifflpbhefoehcbfpnaoiohicop`, release build with the Store key), review, publish | 0.5.0 shows Connect to MyDubb, and Create a MyDubb account only while sign-up is on (`/api/meta` `signup`), and no Try as guest while the flag is off |
| 3 | After the Product Owner accepted 0.5.0 from the Store on Chrome: `EXTENSION_GUEST_ENABLED=true` (needs `GUEST_ACCESS_ENABLED=true` and the Store ID in `EXTENSION_IDS`) | 0.5.0 | The extension offers Try as guest; the website adds "Udemy or another web page" and "or try it as a guest" (both read the same `guest_access.extension`) |
| Off | `EXTENSION_GUEST_ENABLED=false` | any | Try as guest disappears at the next panel load; every guest token is refused at its next request (the panel asks to connect again); the website's words go back to step 1 |

Conditions before step 3 on production: guest access itself is on there, and the open guest
decisions of `docs/context.md` (the spoofing check of GUEST_ACCESS.md has no evidence yet) apply to
guests from the extension in the same way, since they share the same quotas and network key. Chrome
updates installed extensions within hours, not at once: for a short time after step 3 someone may
still run 0.4.1, which simply has no Try as guest.

## Extension side

- PKCE verifier (32 random bytes), S256 challenge and state are made per attempt and kept in the
  panel's memory only. The redirect must be exactly `https://<own id>.chromiumapp.org/` with the same
  state, or the answer is ignored.
- The token, user and expiry are stored in `chrome.storage.session` (memory, cleared when the browser
  quits; access level `TRUSTED_CONTEXTS`, so content scripts and Udemy pages cannot read it). Never
  in `localStorage`, `sessionStorage`, the Udemy page or a message to the content script.
- Disconnect removes it from storage first (every panel clears its result and stops following its
  job), then asks the server to end the token. A `401` on any call removes the stored token.
- Audio: an `<audio>` element cannot send the Authorization header, so the panel fetches
  `/result/audio` with the token and hands the MP3 `Blob` to the extension's offscreen document
  (an extension-origin `BroadcastChannel`, never a data URL, never stored), which plays it from an
  object URL. The offscreen document never receives the token, and the Udemy page only gets display
  state. The audio is stopped and the URL revoked when the result is replaced, the lecture changes,
  the tab reloads or closes, or the account connection ends (Disconnect, another account, a
  refused token: the service worker reports the change to the offscreen document, also for tabs
  whose panel is closed). Closing the panel does not stop it (see extension/README.md).

## Verified, and not

- Verified locally: backend tests (`tests/test_extension_auth.py`, fake Cognito, disposable
  PostgreSQL): flow, PKCE and replay, client/redirect binding, expiry, origin rule, no cookie/bearer
  mixing, logout, password reset and administrator revocation, cleanup. Guests
  (`tests/test_extension_guest.py`): capability on/off, both directions, web 2/5 then extension 3
  then web 2, no new jobs on retry/reconnect, the last place sent by the website and the extension at
  once (two app instances: exactly one `202`), word/length limits, a failed job given back, session
  and network quotas, the shared cap, code reuse/expiry/PKCE/redirect/client, guest session ended
  before the exchange, feature turned off, token scope, isolation between two guests and between a
  guest and an account, no client-supplied identity, cleanup, migration up/down/up and model match.
  Website page (`ExtensionConnect.test.tsx`, `ExtensionConnect.guest.test.tsx`). Extension unit and
  Playwright tests against a fake MyDubb server in which a test hook stands in for Chrome's sign-in
  window (`e2e/onboarding.spec.ts`).
- **Verified with the real sign-in window, locally** (`extension/integration/`, see its README):
  Playwright's Chromium with an ordinary build (no test hook) calling
  `chrome.identity.launchWebAuthFlow`, against the real backend and website (mock providers, fake
  user pool, throwaway database). The window opens as a window of the same profile and **shares its
  mydubb.com cookies**: web first continues the website's guest session (2 of 5 used -> 3 left -> one
  job in the extension -> the website shows 2), extension first with the website never opened
  starts a session that the website then restores (same id, 4 left), closing the window connects
  nothing, reconnecting gives no new job, and Create account -> verify -> Connect shows the Free
  plan (20, then 19).
- **Not verified**: Google Chrome (branded) with the extension installed from the Store or
  unpacked (the check used Playwright's Chromium build), the real mydubb.com (`SameSite=Strict`
  cookies over https, Cloudflare/Render), and anything on production.
