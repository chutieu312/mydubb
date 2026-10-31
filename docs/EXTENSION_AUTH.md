# Chrome extension: connecting to a MyDubb account

How the MyDubb Chrome extension ([extension/README.md](../extension/README.md)) gets access to the
job endpoints for an **invitation account** (Cognito mode). Guests cannot connect the extension.
Status: implemented and tested locally (backend against the fake user pool, extension against a fake
MyDubb server). Not enabled on production: `EXTENSION_IDS` is unset there until the Product Owner
sets it.

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
| `POST /api/extension/token` `{grant_type: "authorization_code", client_id, redirect_uri, code, code_verifier}` | extension | none (the code and the verifier) | `200 {access_token, token_type: "Bearer", expires_at, user: {id, email, display_name}}`; every failure (unknown, expired, used, other client or redirect, wrong verifier, user revoked or disabled since) is `400 invalid_grant`. The code is consumed by the **first** attempt, also a failed one |
| `GET /api/extension/session` | extension | bearer | `200 {user, expires_at}`; `401 not_authenticated` |
| `POST /api/extension/logout` | extension | bearer | `204`, ends this token only (not the website session); `401` when already invalid |
| `/api/jobs*` | extension | bearer | unchanged contract; see API.md "Chrome extension" |

Origin rule: `chrome-extension://<id in EXTENSION_IDS>` is accepted only for `POST /api/extension/token`
and, with `Authorization: Bearer`, `POST /api/jobs` and `POST /api/extension/logout`. CORS is not
opened: the extension calls MyDubb through its host permission, which Chrome exempts from CORS, and
always with `credentials: "omit"`.

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
  `/result/audio` with the token, keeps the MP3 as a `Blob` in memory and plays it from an object URL
  (never a data URL, never stored); the URL is revoked when the result is replaced, the account or
  lecture changes, or the panel closes.

## Verified, and not

- Verified locally: backend tests (`tests/test_extension_auth.py`, fake Cognito, disposable
  PostgreSQL): flow, PKCE and replay, client/redirect binding, expiry, origin rule, no cookie/bearer
  mixing, logout, password reset and administrator revocation, cleanup, guest unchanged. Website
  page (`ExtensionConnect.test.tsx`). Extension unit and Playwright tests against a fake MyDubb server
  in which a test hook stands in for Chrome's sign-in window.
- **Not verified**: `chrome.identity.launchWebAuthFlow` with the real website (Playwright cannot drive
  that window), whether that window shares the profile's mydubb.com cookies (if it does, an already
  signed-in user goes straight to the Connect button; if not, they sign in there — both are handled),
  and anything on production (no `EXTENSION_IDS` there, no job created).
