# MyDubb authentication API (Amazon Cognito mode)

Contract between the backend and the Studio UI for email/password sign-in. Status: **implemented
in the backend PR "Cognito backend authentication"**; production still runs the Access Code
(`AUTH_MODE=access_code`) until the cutover in [AUTHENTICATION.md](AUTHENTICATION.md).

Conventions are the ones in [API.md](API.md): JSON bodies, errors as
`{"error": {"code", "message", ...}}` (`fields` only for `validation_error`), same-origin requests,
the Origin check on every `POST/PUT/PATCH/DELETE`, and the body-size guard. Success bodies are plain
objects (there is no success envelope in this API).

## Choosing the login UI

`GET /api/meta` (public, no session) now contains:

```json
"auth": { "mode": "cognito", "self_registration": false, "password_reset": true }
```

| `auth.mode` | Login UI | Endpoints that exist |
|---|---|---|
| `access_code` (default) | Access Code form | `/api/session` (unchanged, see API.md). `/api/auth/*` does not exist |
| `cognito` | Email + password form, forgot/reset password | `/api/auth/*` below. `/api/session` does not exist |

"Does not exist" means `404 not_found`; on a server that also serves the built UI (production
image), a `POST`/`DELETE` to such a path answers `405 method_not_allowed` instead, because the UI's
catch-all route matches the path for `GET` only. Either way the UI must not call the other mode's
endpoints.

The two modes are exclusive. In `cognito` mode an Access Code session cookie is never accepted and is
never upgraded to a user session. `self_registration` is always `false` (accounts are created by an
administrator; there is no sign-up endpoint). The UI must take the mode from `/api/meta`, not from
its own build configuration.

## Cookies (set by the server; JavaScript never reads or writes them)

| Cookie | Set by | Purpose | Attributes |
|---|---|---|---|
| `mydubb_auth` | an `authenticated` response | Opaque MyDubb session token (only its SHA-256 is stored server-side) | `HttpOnly`, `SameSite=Strict`, `Secure` in production, `Path=/`, `Max-Age` = session TTL |
| `mydubb_auth_challenge` | a `new_password_required` or `email_verification_required` response | Binds the pending sign-in step to this browser | `HttpOnly`, `SameSite=Strict`, `Secure` in production, `Path=/api/auth`, `Max-Age` = challenge TTL |

No Cognito token (ID, access, refresh) or Cognito session string is ever sent to the browser. Do not
store anything auth-related in `localStorage`/`sessionStorage`.

## Sign-in step response (`AuthStep`)

`POST /api/auth/login`, `POST /api/auth/new-password` and `POST /api/auth/email-verification/confirm`
answer `200` with exactly one of:

```json
{ "status": "authenticated",
  "user": { "id": "uuid", "email": "user@example.com", "display_name": "Lan" },
  "csrf_token": "…", "expires_at": "<ISO 8601>" }
```
```json
{ "status": "new_password_required", "challenge_id": "…", "challenge_expires_at": "<ISO 8601>" }
```
```json
{ "status": "email_verification_required", "challenge_id": "…", "challenge_expires_at": "<ISO 8601>" }
```

- Only `authenticated` creates a session (sets `mydubb_auth`) and gives access to the Studio and jobs.
- `display_name` may be `null` (show the email then).
- `csrf_token` must be sent as `X-CSRF-Token` on `POST /api/jobs` and `POST /api/auth/logout`
  (same rule as the Access Code session).
- `challenge_id` is an opaque, random, single-purpose value created by MyDubb (not a Cognito session
  or token). It is valid only together with the `mydubb_auth_challenge` cookie of the same browser,
  only for the step named in `status`, until `challenge_expires_at` (defaults: 3 minutes for a new
  password, 15 minutes for email verification), and it is consumed when the step completes. It never
  grants access to jobs. A new login replaces any pending challenge of this browser.

## Endpoints

### `POST /api/auth/login`
Body `{ "email": "…", "password": "…" }` (email 3-320 characters, password 1-256).

- `200` `AuthStep`.
- `401 invalid_credentials`: wrong email or password, unknown account, account disabled in Cognito,
  or an administrator-required password reset. The message is the same in every case
  ("Incorrect email or password. If you forgot your password, use Forgot password.") so the
  response never reveals whether an account exists.
- `403 account_disabled`: the password was correct but the account is disabled **in MyDubb**.
- `409 password_changed`: the account's access changed while this sign-in was in progress (a
  password reset, an administrator's `revoke-sessions`/`disable`, or a reset whose outcome is still
  unknown, for up to about 80 s); sign in again (later, in the last case).
- `429 too_many_attempts` (+ `Retry-After`, `retry_after_seconds`): too many failed sign-ins from
  this client or overall (`ACCESS_MAX_FAILURES_*` settings).
- `429 auth_rate_limited`: Amazon Cognito throttled the request; try again later (no `Retry-After`).
- `503 auth_unavailable`: Cognito timed out, was unreachable, returned an unexpected answer, or asked
  for a step MyDubb does not support (for example MFA). Nothing is retried automatically.

### `POST /api/auth/new-password`
Body `{ "challenge_id": "…", "new_password": "…" }`. Used after an administrator invited the user
with a temporary password.

- `200` `AuthStep` (`authenticated`, or `email_verification_required` when the email is not verified).
- `422 password_rejected`: the password does not meet the Cognito password policy. The challenge
  stays usable (up to 5 failed attempts in total).
- `400 challenge_invalid`: unknown, expired, already used, wrong step, other browser, too many
  attempts, or Cognito's sign-in session expired. Start again at login.
- `409 challenge_busy`: another request for the same challenge is running, or took it over while
  this one was waiting for Cognito (this request then completes nothing and creates no session).
  The new password may already be active at Cognito in that case: if the other request does not
  finish, sign in with the new password.
- `400 challenge_invalid` is also returned when the step expired while Cognito was answering; the
  new password may already be active (sign in with it).
- `403 account_disabled`, `409 password_changed`, `429 auth_rate_limited`, `503 auth_unavailable` as
  above. `409 account_setup_incomplete`: Cognito requires profile attributes that the administrator
  did not set (an administrator must fix the account).

### `POST /api/auth/email-verification/send`
Body `{ "challenge_id": "…" }`. Asks Cognito to email a verification code. The UI calls it when it
shows the verification step (the backend does not send a code automatically) and for "Resend code".

- `200 { "status": "code_sent", "destination": "u***@e***", "challenge_expires_at": "…" }`
  (`destination` is Cognito's masked address, may be `null`).
- `429 too_many_attempts`: at most 3 sends per challenge, plus the per-client recovery limit.
- `400 challenge_invalid`, `409 challenge_busy`, `429 auth_rate_limited`, `503 auth_unavailable`.

### `POST /api/auth/email-verification/confirm`
Body `{ "challenge_id": "…", "code": "123456" }` (code 1-10 digits).

- `200` `AuthStep` with `authenticated`.
- `400 code_invalid`: wrong or expired code (the same code for both); the challenge stays usable up to
  5 failed attempts.
- `400 challenge_invalid`, `409 challenge_busy`, `403 account_disabled`, `409 password_changed`,
  `429 auth_rate_limited`, `503 auth_unavailable`. As for the new password, a request that lost the
  step (`409 challenge_busy`) or whose step expired meanwhile (`400 challenge_invalid`) creates no
  session even though Cognito may already have verified the email; signing in again then goes
  straight to `authenticated`.

### `POST /api/auth/forgot-password`
Body `{ "email": "…" }`.

- `202 { "status": "accepted" }` whether or not the account exists, is disabled or has a verified
  email (Cognito only emails a code to an existing user with a **verified** email). The UI should say
  "If an account exists for this email, we sent a code" and move to the reset form.
- `429 too_many_attempts` (+ `Retry-After`): recovery limit per client, per email address or overall.
- `503 auth_unavailable`.

### `POST /api/auth/reset-password`
Body `{ "email": "…", "code": "123456", "new_password": "…" }`.

- `200 { "status": "password_reset" }`. The user is **not** signed in; show the login form. Every
  existing MyDubb session of that account is revoked, including a sign-in that was in progress with
  the old password.
- `400 code_invalid`: wrong, expired or never requested code, or no such account (indistinguishable).
  Never signs anyone out.
- `422 password_rejected`, `429 too_many_attempts`, `429 auth_rate_limited`.
- `503 auth_unavailable` has two cases, told apart by the `message` (show it as is):
  - MyDubb could not record the attempt before contacting Cognito: nothing was sent, nothing changed;
    try again later.
  - Cognito did not answer (timeout, network, server error): MyDubb cannot know whether the password
    changed, so the account is **signed out everywhere** (fail closed). Sign-ins are refused with
    `409 password_changed` for up to about 80 s; then the user signs in with the new password, or,
    if that fails, with the old one or requests a new code. Nothing is retried automatically.

### `GET /api/auth/me`
- `200 { "user": { "id", "email", "display_name" }, "csrf_token": "…", "expires_at": "…" }`.
- `401 not_authenticated`: no cookie, unknown, expired, logged out, revoked by a password reset, or
  the user is disabled in MyDubb. The UI shows the login form.

### `POST /api/auth/logout`
Requires the session and `X-CSRF-Token`. `204`, revokes the session server-side and clears the
cookie. `401 not_authenticated` when the session is already invalid (treat as logged out, like the
Access Code logout). `403 csrf_failed` leaves the session active.

## Jobs in Cognito mode

`/api/jobs*` are unchanged for the UI. Ownership is by user, taken from the session (never from the
request): a job created in Cognito mode belongs to that user and is visible from any of the user's
sessions; another user's job (or an Access Code-era job) returns `404 job_not_found` for the job,
its result and its audio. Missing or invalid sessions return `401 not_authenticated` as before.

## Changes from the proposed contract

The endpoint names and request bodies are as proposed. Additions and precisions:

1. `authenticated` responses and `GET /api/auth/me` also return `csrf_token` and `expires_at`, and
   the user is nested in `user` (`/me` cannot return only `{id, email, display_name}` because the UI
   needs the CSRF token for jobs and logout after a page reload).
2. `email-verification/send` must be called by the UI; login does not send a code by itself (this
   keeps code emails, which Cognito limits, to explicit user actions).
3. A pending step is bound to the browser with the `mydubb_auth_challenge` cookie, so `challenge_id`
   alone is not enough.
4. `forgot-password` answers `202` and `reset-password` does not sign the user in.
5. `GET /api/meta` gains `auth`; the Access Code endpoints disappear in Cognito mode (and vice versa).
6. Extra error codes beyond the proposal: `account_disabled`, `password_changed`,
   `account_setup_incomplete`, `challenge_busy`, `auth_rate_limited`, `auth_unavailable`.

### Revision after review (PR #25, second round)

No endpoint, body, response shape or error code changed. Precisions to existing codes:

- `reset-password` `503 auth_unavailable` can now mean "outcome unknown, signed out everywhere"
  (see above); its `message` says which case applies, so the UI should display the server message
  for this endpoint rather than a fixed text.
- `409 password_changed` also covers an administrator revocation and an unknown reset outcome; its
  message is now "Your password or account access changed while you were signing in. Please sign in
  again."
- `409 challenge_busy` / `400 challenge_invalid` can also come back from `new-password` and
  `email-verification/confirm` after Cognito already accepted the step (the request lost its lease
  or the step expired meanwhile). Treat them as before: back to the login form.
