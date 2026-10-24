# Sign-in UI (email + password)

Status: **integrated with the merged backend contract and tested against fakes; not verified
against a real Amazon Cognito user pool.** Production keeps using the Access Code until the cutover
in [AUTHENTICATION.md](AUTHENTICATION.md). The official HTTP contract is
[AUTH_API.md](AUTH_API.md); this page describes only the browser side. It does not say that
authentication is finished.

## How the UI chooses a sign-in mode

`App` reads `GET /api/meta` and uses `auth.mode` (`lib/authMode.ts`), never a build-time variable:

| `auth.mode` | UI | Endpoints used |
|---|---|---|
| `access_code` | Access Code form (unchanged) | `/api/session` |
| `cognito` | Email + password screens | `/api/auth/*` |
| missing, `null` or any other value, or `/api/meta` failed | **No sign-in at all**: an error with "Try again" | none (only `/api/meta`) |

A mode is never guessed and the other mode's endpoints are never called. `auth.password_reset`
decides whether "Forgot password?" is shown. There is no sign-up screen; the sign-in screen says
"Access is currently by invitation only."

## Screens and flows

All screens reuse the Studio card, tokens and Light/Dark theme. English only.

| Screen | Contract calls | Notes |
|---|---|---|
| Sign in | `POST /api/auth/login` | Show/Hide password; focus is not moved on page load |
| Set your password | `POST /api/auth/new-password` | Temporary-password step; only the confirmation is checked locally |
| Verify your email | `POST /api/auth/email-verification/send`, `.../confirm` | See "Email verification" |
| Reset your password / Choose a new password | `POST /api/auth/forgot-password`, `.../reset-password` | Same message for every address; a reset never signs the user in |
| Studio header | `GET /api/auth/me`, `POST /api/auth/logout` | Display name, or the email when `display_name` is `null`; **Sign out** |

Each step moves focus to the screen title, errors are `role="alert"`, fields have labels and
`aria-invalid`/`aria-describedby`, and every action runs one request at a time.

### Session

- **Reload**: `/api/auth/me` restores the session. `401` shows the sign-in screen. Any other
  failure (network, 5xx, a body that does not match the contract) is **not** treated as signed out:
  the page says it could not check the session and offers "Try again".
- **CSRF**: `csrf_token` is required in `authenticated` and `/me` answers, kept in memory only and
  sent as `X-CSRF-Token` by the existing client on jobs and logout. It is cleared when the session
  ends and replaced on the next sign-in or restore.
- **`expires_at`** is validated and carried in the response types but not used for a client-side
  timer: the server's `401` is the only authority (a wrong device clock must not end a session).
- **Expiry**: a `401` on a job request returns to sign in with a notice and drops the CSRF token.
- **Sign out** succeeds only on `204` (or `401`, the session is already gone). A network error, 5xx,
  `403 csrf_failed` or any other answer shows "Sign out failed; you are still signed in." and the
  button works again for a retry.
- **Draft**: the unsent Studio form (transcript, times, voice, speed) is held in page memory only
  (`lib/studioDraft.ts`), tied to the user id. After a session expiry it comes back only when the
  same user signs in again; another user's sign-in drops it, and an explicit sign out discards it.
  It is never written to browser storage. Reloading the page loses it by design.
- **Jobs**: the current job is cleared when the session ends, so the next user sees none of it.

### Email verification

A code is sent **only when the user presses "Send code" / "Resend code"**, never by an effect, a
render or a remount. Verify and Resend share one lock, so they never run at the same time (also not
with the Enter key). Resend is disabled for the wait the server gives (`Retry-After`); the UI
invents no limit of its own. A wrong or expired code (`code_invalid`) keeps the user on the screen.
The code is checked locally for the documented format (1-10 digits) before it is sent.

AUTH_API.md says the UI calls `send` "when it shows the verification step" and also that code emails
are kept "to explicit user actions". The UI chose the explicit button, which satisfies both and
needs one more click. Confirm this with the product owner if auto-send was intended.

### Late answers

A response may change the screen only if the user is still where the request was made: every screen
change bumps a counter and an unmounted flow ignores everything, so an old answer never switches the
screen, signs anyone in or leaves a CSRF token behind.

## Errors: by status and `code`, never by message text

| Situation | UI |
|---|---|
| `401 invalid_credentials`, `403 account_disabled` (login) | The server's message, password cleared |
| `409 password_changed` | Fixed sentence: password or access changed, sign in again. On a pending step it returns to sign in |
| `400 challenge_invalid`, `409 challenge_busy` (new password, verify, send) | Back to sign in with a notice that the change may already be saved (the new password / verified email may be active) |
| `403 account_disabled`, `409 account_setup_incomplete` on a pending step | Back to sign in with a fixed notice |
| `400 code_invalid`, `422 password_rejected` | The server's message; stays on the screen; typed passwords are cleared |
| `422 validation_error` | The first field message |
| `429 too_many_attempts` with `Retry-After` | "Try again in about N minutes"; Resend is disabled for that time |
| `429 auth_rate_limited`, `503 auth_unavailable` | The server's message; nothing is retried |
| Network error, other 5xx | Generic message (network: "Cannot reach the server"); the password is kept for a retry |
| Answer that does not match the contract (wrong status or body) | Treated as an error, never as a sign-in |

A server message that names the identity service or token types is replaced by a generic one. The
old rule "any code containing `challenge`" was removed; only the codes above end a step.

### Password reset: an unknown outcome

For `POST /api/auth/reset-password` the password may have changed even when the answer is not a
clear success or refusal. Documented refusals (`code_invalid`, `password_rejected`,
`too_many_attempts`, `auth_rate_limited`, `validation_error`, `password_changed`) show their normal
message. `503 auth_unavailable` shows the **server's message as plain text** (it says which case
applies). A network error, any other 5xx or a malformed `200` shows: "We could not confirm whether
your password was changed. Wait a minute, then try signing in with your new password. If that does
not work, request a new code." The UI never says "unchanged", never retries or resubmits the reset
by itself, and success goes back to sign in (not signed in).

### Password policy: not available

The backend and the documents publish **no password policy** (`password_rejected` carries no rule;
AUTHENTICATION.md says to tell users the rule in the invitation). The UI therefore shows no rule
list and blocks nothing on its own except a confirmation that does not match; the server decides.
This is a gap to close with the backend or product owner (see below).

## Tests

```bash
cd frontend && npm ci && npm run lint && npm run typecheck && npm test && npm run build
cd e2e && npm ci && npx playwright install chromium && bash run-e2e.sh
```

Three different kinds of evidence, kept apart:

1. **Component and integration tests (Vitest, fake `fetch`)**: `PasswordAuthFlow.test.tsx`,
   `App.auth.test.tsx`, `authApi.test.ts` (adapter), `AppHeader.test.tsx` and
   `authSafety.test.ts`. They check flows, validation, loading, double submit, late answers,
   every error code above, mode selection (including invalid metadata), session restore, expiry,
   sign out failure and retry, draft rules, two accounts, no storage or console use, and that no
   mock or bypass sign-in exists in shipped code. The fake (`src/test/authFetch.testkit.ts`) is
   imported only by tests and is not part of the build.
2. **E2E with the real backend and a fake user pool (Playwright)**: `e2e/run-e2e.sh` starts a second
   stack, `app-cognito`, from the same image in `AUTH_MODE=cognito`. `e2e/fake-cognito/serve.py`
   injects the backend's own in-memory `FakeCognito` (`backend/tests/fake_cognito.py`, mounted
   read-only) through the documented `build_services(cognito_client=...)` hook, and a small control
   server plays the administrator and the inbox (create users, read the codes). Specs
   `auth.signin`, `auth.recovery`, `auth.session` and `auth.layout` run on desktop and phone
   viewports. Real: routers, sessions, CSRF, challenges, PostgreSQL, jobs, the built UI. Fake: the
   user pool. No AWS call, no credential.
3. **Live Cognito acceptance: not run** (see the checklist).

## Browser checks (Chromium via Playwright)

Checked automatically and by looking at screenshots (`e2e/test-results/auth-shots/`, not committed)
for sign in, forgot/reset, set password, verify email (initial, code sent, wrong code) and the
Studio header, in **Light and Dark**, at **320, 390, 412 and 1280 px**: no sideways overflow, no
element sticking out of its card (this found and fixed a real bug: a very long email or error word
widened the card and cut off the controls at 320 px), text contrast at least 4.5:1 and control
borders at least 3:1, a 140-character unbroken error word and 100+ character emails, keyboard tab
order, visible focus rings, Enter to submit, Show/Hide with Space, and `aria-invalid` /
`aria-describedby` / `role=alert` wiring.

**Not checked**: Safari/iOS, Firefox, real devices and password managers, a screen reader, `prefers-
reduced-motion`, and a hands-on review of every dark-theme screenshot beyond the ones listed above.

## Live acceptance checklist (not run)

Against a staging or local stack with a real **test** user pool and email delivery, never
production data. Record results in the pull request.

- [ ] Invitation email arrives; sign in with the temporary password; choose a new password.
- [ ] Verification email arrives only after "Send code"; wrong code rejected; right code signs in; resend limit honoured.
- [ ] The password rule of the real pool: what the UI shows when a password is rejected, and that users learn the rule somewhere.
- [ ] Forgot/reset with a real verified account and an unknown address: same message; reset works; an open session of that account is signed out.
- [ ] Reset when Cognito is slow or unreachable (unknown outcome): the message, no retry, and sign in after about 80 s.
- [ ] Session expiry, reload restore, sign out success and failure with the backend stopped.
- [ ] Two real accounts in turn: no shared jobs, results or drafts.
- [ ] Dubbing with a signed-in account: voice, speed, playback, download.
- [ ] Light/Dark, 320/390/412 px, keyboard only, one screen reader pass, Safari/iPhone.
- [ ] No password, code or challenge id in storage, URL or console (dev tools).

## Production cutover (browser side)

Coordinate with [AUTHENTICATION.md](AUTHENTICATION.md); this page adds only what the UI needs.

1. The backend (with `AUTH_MODE=access_code`) and this UI are merged and deployed; production still shows the Access Code and `/api/meta` reports `access_code`.
2. AWS setup, invitations and the live acceptance checklist above are done on staging.
3. The backend switches `AUTH_MODE=cognito`. The UI follows `/api/meta`; there is nothing to change in the frontend. Access Code sessions stop working at that moment.
4. Verify production with a test user (sign in, a job, sign out), then record the result in `docs/context.md` in its own pull request.
5. Rollback is `AUTH_MODE=access_code` in the backend; the UI follows.

## Gaps and observations for the backend

1. **No published password policy.** `422 password_rejected` has no rule text and no document or
   metadata field states the policy, so the UI cannot show or pre-check it. Needs a decision: expose
   it (for example in `/api/meta`) or state it in the invitation and a fixed UI sentence.
2. **`POST /api/auth/reset-password`, `503 auth_unavailable`, unknown outcome.** The message says the
   account "is signed out everywhere". If recording the outcome fails, old sessions stay valid until
   the attempt settles (about 80 s, AUTHENTICATION.md), so the sentence is stronger than the
   guarantee. The UI shows the message as is; consider wording such as "will be signed out".
3. **Send-code timing** is described two ways in AUTH_API.md (see "Email verification").
4. `challenge_expires_at` is validated but unused by the UI; the server's `challenge_invalid` is the
   authority.

## Not verified

- Anything against a real Amazon Cognito user pool or real email delivery.
- That migration `0006` exists on the production database (see the pull request for what was and was not checked).
- Browsers other than Chromium, assistive technology, password managers.
