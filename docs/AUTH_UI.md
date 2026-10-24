# Sign-in UI (email + password)

Status: **UI components and tests are done; not integrated.** The screens are not wired into
`App.tsx`, so production still uses the Access Code. The official API contract
(`docs/AUTH_API.md`) and the backend design (`docs/AUTHENTICATION.md`) come with the backend pull
request; everything here that depends on them is marked **provisional** and must be re-checked
after that pull request is merged. Nothing in this document says authentication is finished.

## Screens

All screens reuse the Studio sign-in card (`.gate`), design tokens, Light/Dark theme and button
styles. English only. There is no public sign up.

| Screen | Purpose | Notes |
|---|---|---|
| Sign in | Email, Password (Show/Hide), Sign in, Forgot password | Shows "Access is currently by invitation only." |
| Set your password | New password, Confirm password | Temporary-password flow. Requirements list under the field; the server decides |
| Verify your email | Verification code, Verify email, Send/Resend code | Resend is disabled for the wait the server gives (`Retry-After`) |
| Reset your password / Choose a new password | Email, then emailed code + new password | The message after step 1 is identical for every address |
| Account (header) | Display name (or email) and **Sign out** | `AppHeader` takes an optional `user`; without it the Access Code header is unchanged |

Behaviour common to all screens:

- Labels on every input, `aria-invalid` and `aria-describedby` on invalid fields, errors in
  `role="alert"`, status in `role="status"`, focus moves to the screen title after each step.
- One request at a time per action (a ref blocks a second submit before React re-renders).
- Passwords live in the component state of the form that typed them. They are cleared when the
  server rejects them or the attempt ends, and kept only after a failure that says nothing about
  them (network error, 5xx, rate limit) so the user can retry. Leaving a screen unmounts the form.
- No `localStorage`, `sessionStorage`, cookies, URL or console use for passwords, codes or
  `challenge_id` (enforced by `authSafety.test.ts`).
- No AWS, Cognito or JWT wording. A server message that names them is replaced by a generic one.
- Rate limits show the server's wait ("Try again in about 10 minutes"); the UI invents no limit.

## Provisional contract

Adapter: `frontend/src/api/authApi.ts`; types and response guards: `frontend/src/api/authTypes.ts`.
A response that does not match the guards is treated as an error, never as a sign-in.

| Call | Request | Success |
|---|---|---|
| `POST /api/auth/login` | `{ email, password }` | `AuthStep` |
| `POST /api/auth/new-password` | `{ challenge_id, new_password }` | `AuthStep` |
| `POST /api/auth/email-verification/send` | `{ challenge_id }` | no body (`204`) |
| `POST /api/auth/email-verification/confirm` | `{ challenge_id, code }` | `AuthStep` |
| `POST /api/auth/forgot-password` | `{ email }` | no body (`204`), same for unknown emails |
| `POST /api/auth/reset-password` | `{ email, code, new_password }` | no body (`204`) |
| `GET /api/auth/me` | — | `{ user, csrf_token? }` |
| `POST /api/auth/logout` | — | no body (`204`) |

`AuthStep` is `{ status: "authenticated", user, csrf_token? }`,
`{ status: "new_password_required", challenge_id }` or
`{ status: "email_verification_required", challenge_id }`. `user` is `{ id, email, display_name }`.
Errors use the existing `{ "error": { "code", "message" } }` shape. Same-origin requests with
cookies; the CSRF header is sent only if the backend returns a `csrf_token`.

### Assumptions to confirm against `docs/AUTH_API.md`

1. Whether login sends the verification email by itself. The screen always offers "Send code" /
   "Resend code" so it works either way, but may send a second email.
2. A `401` (or an error code containing `challenge`) on new-password or email verification means
   the sign-in attempt expired: the UI returns to Sign in with a notice.
3. Password policy. `lib/passwordPolicy.ts` has a provisional default (8+ characters, lower, upper,
   number) used for early hints only. It should come from the contract or from the backend, and
   `PasswordAuthFlow` already takes it as a prop.
4. How the CSRF token and session expiry are reported (`/api/auth/me` vs the login response).
5. What the logout endpoint returns for an expired session (the Access Code flow treats `401` as
   signed out).
6. Rate-limit responses: `429` with `Retry-After` is assumed.

## Not done yet (needs the real contract)

- Selecting the sign-in mode from backend metadata. The UI must not switch on a frontend-only
  environment variable; the capability field is whatever `docs/AUTH_API.md` defines.
- Wiring `PasswordAuthFlow` and the header `user` into `App.tsx`, including session start
  (`/api/auth/me`), session-expiry handling and sign out. Sign out must follow the existing rule:
  signed out only after `204` or `401`; any other failure keeps the user signed in with an error
  and a retry.
- Keeping an unsent transcript in page memory across a session expiry. It must be cleared on
  explicit sign out and restored only for the same user id, so one account never sees another's
  draft. Not implemented because it needs the user id from the real contract.
- Playwright E2E for the new flows.

## Tests

```bash
cd frontend
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

- `PasswordAuthFlow.test.tsx`: every screen and transition, validation, loading, double submit,
  rate limit, expired attempt, rejected input, no storage or console use.
- `authApi.test.ts`: endpoints, bodies, CSRF header, response guards, failed logout is an error.
- `passwordPolicy.test.ts`, `AppHeader.test.tsx`.
- `authSafety.test.ts`: shipped source never uses storage, cookies, console or build-time flags in
  sign-in code, has no mock or bypass sign-in, no sign up, and does not name the identity provider.

**These are fake tests.** `src/test/authFetch.testkit.ts` replaces `fetch`; it is imported only by
test files and is not part of the build. No Cognito, AWS or network call is made, and none of them
prove the real backend behaves as assumed.

## Live acceptance checklist (not run)

Run against a staging or local stack with the merged backend and a real test pool, never
production data. Record results in the pull request.

- [ ] Sign in with a normal account; reload keeps the session; account name shows in the header.
- [ ] Temporary password: Set your password, then Studio opens.
- [ ] Unverified email: code arrives, wrong code rejected, right code signs in, resend honours the limit.
- [ ] Forgot/reset: unknown and known emails show the same message; reset works; old password stops working.
- [ ] Session expiry returns to Sign in with a notice; the next sign in works.
- [ ] Sign out succeeds; with the backend unreachable it reports failure, stays signed in, retry works.
- [ ] Two accounts in turn: neither sees the other's jobs or results.
- [ ] Dubbing workflow with a signed-in account: voice, speed, playback, download.
- [ ] Light and Dark themes, 320/390/412 px widths, keyboard-only use, one screen reader pass.
- [ ] Browser dev tools: no password, code or challenge id in storage, URL or console.

## Production cutover

Coordinate with the backend document; this document covers only the browser side.

1. Merge the backend pull request and confirm the new metadata field reports the intended mode
   while the Access Code is still active.
2. Integrate and merge this UI pull request with the Access Code path still working.
3. Complete the live acceptance checklist on staging.
4. Switch production to email + password on the backend side (its steps are in `AUTHENTICATION.md`).
   The UI follows the backend mode; there is no frontend switch.
5. Verify production, then update `docs/context.md` in its own pull request.

## Not verified

- Anything against the real backend or identity service.
- Appearance: layout, Dark theme, 320/390/412 px widths and focus rings of the new screens were not
  checked in a browser, and there is no Playwright coverage yet.
- Screen reader behaviour, Safari/iOS password-manager behaviour (autocomplete attributes are set
  but not tested).
