# Public sign-up (Create account) with Google reCAPTCHA

New people create an account on the website with an email and a password, verify the email with a
code, sign in with the existing sign-in, and use the Studio on the **Free** plan assigned by the
backend (Story A, [API.md](API.md#usage-limits)). **Off by default** in the code and on production.
The Product Owner turns it on after the checklist at the end.

Status: implemented and tested locally and in CI against a **fake** user pool and a **fake**
Google siteverify. Never run against real Cognito or Google; no AWS or Google setting was changed.

HTTP contract: [AUTH_API.md](AUTH_API.md#public-sign-up). Sign-in design: [AUTHENTICATION.md](AUTHENTICATION.md).

## Flow

```
Sign in screen ── Create account ──► Create account screen (email, password, Google checkbox)
                                       │ POST /api/auth/signup
                                       │   limits (every request counts) -> reCAPTCHA siteverify
                                       │   (fails closed) -> Cognito SignUp (never retried)
                                       ▼
                                     Verify email screen (code, Resend code, different email, back)
                                       │ POST /api/auth/signup/confirm -> Cognito ConfirmSignUp
                                       ▼ (Cognito marks the email verified)
                                     Sign in screen, email filled in, "Your email is verified"
                                       │ POST /api/auth/login (existing): session only when Cognito
                                       ▼ reports email_verified=true; users row created, plan = 'free'
                                     Studio, "Your plan": 20 Generates, 5 imports, reset 00:00 UTC
```

- **No session is created by sign-up.** The existing sign-in creates it, and only for a verified
  email (`_finish_sign_in` checks `email_verified` from Cognito `GetUser` on every sign-in). An
  account that has not confirmed its code cannot sign in at all (Cognito refuses it), and an
  account whose email is not verified gets the existing email-verification step, never a session.
  The extension connects only from a website session, so the same rule covers it.
- **Auto sign-in after sign-up is not used.** Cognito offers it only with the `USER_AUTH` flow on the
  Essentials tier; MyDubb uses `USER_PASSWORD_AUTH` on Lite. Signing in once more is the cost.
- **Identity** stays `(cognito_issuer, cognito_sub)`. The email is profile data; nothing joins or
  merges two identities by email, and `ConfirmSignUp` never sets `ForceAliasCreation` (an email
  can never move from one user to another).
- **Free plan**: the `users` row is created by the existing sign-in upsert, which does not name
  `plan` or `role`, so the database defaults apply (`plan='free'`, `role='user'`), exactly as Story
  A's contract says. Nothing reads a role, plan or user id from a request (extra fields in the
  sign-up body are ignored). The quotas, the per-job limits and the shared caps are Story A's code;
  sign-up adds no counter and no rule.

## Feature gate and configuration

| Variable | Default | Notes |
|---|---|---|
| `PUBLIC_SIGNUP_ENABLED` | `false` | `true` turns it on, if everything below is set |
| `RECAPTCHA_SITE_KEY` | — | reCAPTCHA v2 Checkbox site key (public, sent to the browser via `/api/meta`) |
| `RECAPTCHA_SECRET_KEY` | — | **Secret.** Only sent to Google's siteverify |
| `RECAPTCHA_ALLOWED_HOSTNAMES` | — | Comma-separated, e.g. `mydubb.com`; checked against siteverify `hostname` on every sign-up |
| `RECAPTCHA_TIMEOUT_SECONDS` | `10` | One siteverify request; never retried |
| `COGNITO_CLIENT_SECRET` | — | **Required for sign-up** (confidential app client), see "Bypass" |
| `CLIENT_IP_HEADER` | — | Required for sign-up when `APP_ENV=production` (production: `cf-connecting-ip`) |
| `SIGNUP_MAX_PER_CLIENT` / `_PER_EMAIL` / `_GLOBAL` / `SIGNUP_WINDOW_SECONDS` | 5 / 3 / 30 / 3600 | See "Limits" |

- **Off** (`false`, the default): `/api/meta` reports `auth.self_registration: false` and
  `signup: {"enabled": false}`; the Sign in screen is unchanged ("Access is currently by invitation
  only."); the CSP is byte for byte the previous one; every sign-up endpoint answers
  `404 signup_disabled` before anything else: no CAPTCHA check, no Cognito call, no email.
- **On but incomplete** (any value above missing or malformed): the service still starts and
  sign-in, password reset, guest, Admin and the extension work; the log says
  `PUBLIC_SIGNUP_ENABLED=true but sign-up is OFF: missing or invalid <names>` (names only, never
  values); `/api/meta` reports sign-up off; the endpoints answer `503 signup_unavailable`.
- **On**: `/api/meta` reports `self_registration: true` and
  `signup: {enabled, recaptcha_site_key, free_plan: {...}}` (the Free numbers come from
  `PLAN_LIMITS`, for the description only); the CSP adds Google's reCAPTCHA sources.
- A CAPTCHA outage or an over-quota Google key refuses **sign-up only** (`503 captcha_unavailable`);
  nothing else depends on Google.

## Google reCAPTCHA

Read from Google's documentation (developers.google.com/recaptcha/docs/verify, display, faq,
domain_validation, settings), 2026-11-09:

- Key type: **reCAPTCHA v2, "I'm not a robot" Checkbox**. Not v3 or Enterprise, no score, no
  `action` (those do not exist for this key type), so no threshold was chosen.
- Browser: the script `https://www.google.com/recaptcha/api.js?render=explicit&onload=...&hl=en` is
  loaded **only when the Create account screen opens** (never on Sign in or the Studio), once per
  page. The widget follows the site's light/dark choice and uses the compact size under 304 px.
- Server: `POST https://www.google.com/recaptcha/api/siteverify` with `secret` and `response` (the
  user's IP address, `remoteip`, is optional and **not sent**). Only `success: true` **and** a
  `hostname` in `RECAPTCHA_ALLOWED_HOSTNAMES` passes. Google: "Each reCAPTCHA user response token is
  valid for two minutes, and can only be verified once"; an expired or reused token comes back as
  `timeout-or-duplicate`, so expiry and replay are decided by Google. Google requires the backend to
  check `hostname` when the key's origin check is off; MyDubb checks it always.
- Fails closed: `timeout-or-duplicate`, `invalid-input-response`, `missing-input-response` or a
  wrong hostname -> `400 captcha_invalid` (tick the box again); our key or request wrong
  (`invalid-input-secret`, `missing-input-secret`, `bad-request`, unknown codes), timeout, network
  error, non-200 (over quota included), non-JSON or an answer that is not the contract ->
  `503 captcha_unavailable`. In both cases Cognito is not called. Nothing is retried.
- Google's documentation does not say what siteverify returns for a v2 key over its quota (it says
  the widget may show "This site is exceeding reCAPTCHA quota"); MyDubb does not assume an answer:
  anything but a pass refuses.
- Logs carry Google's error codes and nothing else (no token, secret, IP or email).

### Google data flow (website only)

When someone opens **Create account** on the website, their browser loads Google's reCAPTCHA script
and widget from `www.google.com` / `www.gstatic.com` / `recaptcha.google.com`; Google receives what
any such request carries (IP address, browser details, its own cookies such as `_GRECAPTCHA`) and how
the box was used, under Google's Privacy Policy and Terms, which the screen links to ("This site is
protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply."). When the form is
sent, MyDubb's server sends Google the token and the secret key only (not the email, password or IP
address) and keeps neither the token nor Google's answer. People who only sign in, use the Studio or
a guest session never load Google's code. The Chrome extension never loads reCAPTCHA; its privacy
policy ([extension/store/PRIVACY-POLICY-DRAFT.md](../extension/store/PRIVACY-POLICY-DRAFT.md)) covers
the extension only and is unchanged. Internal notes for a future website policy:
[WEBSITE-POLICY-NOTES.md](../extension/store/WEBSITE-POLICY-NOTES.md).

## No account enumeration

| Request | New email | Email that already has an account | Unconfirmed earlier sign-up |
|---|---|---|---|
| Create account | `200 verification_required`, code emailed | **the same** `200`, nothing emailed, password unchanged | **the same** `200`, nothing emailed (Resend code sends one) |
| Resend code | `202 accepted` | **the same** `202` (Cognito: "already confirmed", hidden) | `202`, code emailed |
| Confirm code | `200 verified` (right code) | **one** `400 code_invalid` for unknown, already confirmed or wrong | `400 code_expired` only for a code Cognito says expired |

The Verify screen therefore says "If *email* can be used for a new account, we sent it a code …
If you already have an account, sign in or use Forgot password." Remaining signals, stated: an
expired code (`code_expired`) needs a code that was really sent; Cognito's own per-user limits are
answered like a success on Resend (logged). Timing differences between a new and an existing email
were not measured.

## Lost answers, repeated requests, concurrency

- **Create account answer lost** (Cognito timeout/5xx): `503 signup_outcome_unknown` ("If a code
  arrives by email, enter it on the next screen"); the UI offers **I received a code** -> Verify.
  Never retried. Pressing Create account again is answered like an existing email (Cognito keeps one
  user per email): no duplicate account.
- **Cognito created the user but could not send the code** (`LimitExceededException`, e.g. its email
  quota; `CodeDeliveryFailureException`): the usual `200`; the Verify screen offers Resend code.
- **Confirm answer lost**: `503 verification_outcome_unknown` ("Try signing in"): the email may be
  verified; sign-in tells.
- **Double click / Enter + click**: one request (the form's lock); concurrent requests for one email
  create one user (tested with 8 parallel requests).
- **Back, Use a different email, or a new attempt while a request waits**: the late answer changes
  neither the screen nor the email (each answer is applied only if its screen is still the current
  one; Vitest regression tests for Create account and Verify).

## Limits

Every Create account request counts **before** Google or Cognito is asked, so pressing the button
repeatedly multiplies neither CAPTCHA checks nor emails. In-memory sliding windows (single instance,
reset on restart), keyed by `CLIENT_IP_HEADER` (production: `cf-connecting-ip`) and by a SHA-256 of
the lower-cased email.

| What | Limit (code default) | Test config (E2E stack) | Proposal for production | Approved by PO |
|---|---|---|---|---|
| Create account | 5 / client, 3 / email, 30 overall per hour | 500 / client, 1000 overall | the defaults, with SES; without SES lower `SIGNUP_MAX_GLOBAL` (see email quota) | **not yet** |
| Resend code | the recovery limits: 5 / client, 3 / email, 50 overall per 15 min (shared with forgot/reset password) | 500 / 500 / 1000 | unchanged | existing values |
| Wrong codes | the failed sign-in limiter: 5 / client, 50 overall per 15 min (shared with sign-in) | 200 / 1000 | unchanged | existing values |
| Cognito (not MyDubb) | per user per hour: 5 ResendConfirmationCode, 15 ConfirmSignUp; SignUp/ConfirmSignUp 50 RPS per pool; code valid 24 h | — | — | AWS quotas |

Why these defaults: one person needs one Create account (two with a typo) and a couple of resends;
3 per email per hour stops mailing one address repeatedly; 30 sign-ups an hour overall is far above
the expected rate yet bounds the emails Cognito sends. **Email capacity is the real ceiling**: with
Cognito's default email (`COGNITO_DEFAULT`), AWS documents **50 emails per day** (resets 09:00 UTC),
shared by invitations, verification codes, password resets and sign-ups. Configure SES before
turning sign-up on, or expect codes to stop arriving after about 50 emails a day.

## Bypass: creating a user without the CAPTCHA

The CAPTCHA and the limits sit in MyDubb's backend, in front of Cognito's public `SignUp`. Every
way to create a user in the pool, and what stops it:

| Path | What stops it | Enforced by |
|---|---|---|
| MyDubb `/api/auth/signup` | limits, then reCAPTCHA (fails closed), then `SignUp` | **code** (tests) |
| Cognito `SignUp`/`ConfirmSignUp` called directly with MyDubb's client ID | a confidential app client: every call needs `SECRET_HASH` of the client secret, held only by the backend. MyDubb **refuses to turn sign-up on without `COGNITO_CLIENT_SECRET`**; every sign-up request carries the hash | code (refusal, request shape) + **Cognito configuration** (the client has a secret) |
| Another app client of the same pool | self-service sign-up is pool-wide: any client could call `SignUp`, and a client without a secret needs nothing but its ID | **Cognito configuration**: the pool has only MyDubb's client |
| Managed login / hosted UI | with a domain, "all app clients serve public authentication pages", including sign-up (and it knows the secret) | **Cognito configuration**: no domain, no OAuth flows |
| Federation (Google, SAML, …) | none configured | **Cognito configuration**: `SupportedIdentityProviders` is `COGNITO` only |
| `AdminCreateUser` (invitations) | IAM credentials of an administrator | AWS IAM (intended path) |

What a bypass would still not get: a session without a verified email (enforced at every sign-in),
any role or plan but Free (database defaults). So a bypass skips the CAPTCHA and MyDubb's limits,
nothing else. **Do not turn sign-up on until the three configuration rows are verified** (checklist).
Optional hardening, not built (needs an AWS Lambda): a Pre sign-up trigger that rejects `SignUp`
calls without a value only MyDubb's backend can produce (`ClientMetadata`).

## Checks done (local and CI)

- Backend (`tests/test_signup.py`, `tests/test_signup_clients.py`; fake Cognito, fake siteverify,
  disposable PostgreSQL): the whole flow to the Studio with Story A's quotas (word limit, 20/21
  Generates, 5/6 imports, the extension sharing the quota, no Admin), client fields `role`/`plan`
  ignored, gate off (404, nothing called, CSP unchanged), each missing setting (503, sign-in works),
  production needs `CLIENT_IP_HEADER`, reCAPTCHA refused/unavailable/replayed (Cognito never called),
  enumeration (same answers), wrong/expired/resent codes, limits before Google, lost answers, 8
  concurrent sign-ups, unverified emails never get a session, cross-origin refused, logs free of
  password/code/token/email; siteverify request shape and every answer class; `SECRET_HASH` on all
  three Cognito calls. Mutation checks: skipping the CAPTCHA check or answering an existing email
  differently makes these tests fail.
- Frontend (`PasswordAuthFlow.signup.test.tsx`, Google's script mocked): screens, field messages and
  focus, robot-check reset after each attempt, server-paced resend, theme, script load failure,
  late answers after Back / Use a different email (mutation-checked).
- Browser E2E (`e2e/tests/signup.flow.spec.ts`, the `app-signup` stack; Google's script served by
  the spec at its real URL, every other outside request refused): flow to the Studio with "Your
  plan", unverified account cannot sign in, forged token, existing email, wrong code + resend,
  keyboard, dark mode, 320 px. The `app-cognito` stack keeps sign-up off and its specs still check
  the invitation-only Sign in.

**Not verified**: real Google (the widget in the real CSP, `style-src 'self'` with Google's iframe,
quota behaviour), real Cognito (`SignUp` errors and messages, `UserNotConfirmedException` wording,
email delivery), screen readers, Safari/Firefox, production.

## Before turning it on in production (Product Owner checklist)

Nothing below has been done. Order matters: sign-up stays off until the last step.

1. **Story A guardrails.** Decide and configure the shared daily caps (`USAGE_CAPS_ENABLED`,
   `USAGE_CAP_*`, [API.md](API.md#usage-limits)); MyDubb does not choose them. Admin and Guest keep
   Story A's policy.
2. **Email capacity.** Configure Amazon SES for the user pool (verified sender/domain, out of the SES
   sandbox), or accept the 50 emails/day of Cognito's default email (then lower
   `SIGNUP_MAX_GLOBAL`). Customize the verification email (sign-up code) text.
3. **Google.** Create a **reCAPTCHA v2 "I'm not a robot" Checkbox** key for `mydubb.com` (add any
   other host the site is served from, e.g. `www.mydubb.com`); keep **Verify the origin of
   reCAPTCHA solutions** on. Use a separate key with `localhost` for development; never Google's test
   keys in production. Check in the Google Cloud console which project and billing/quota the key
   falls under (not verified here).
4. **Cognito (verify, then change one setting last).** With AWS CLI read-only calls:
   - `aws cognito-idp list-user-pool-clients --user-pool-id <pool>`: only MyDubb's client.
   - `aws cognito-idp describe-user-pool-client --user-pool-id <pool> --client-id <id>`:
     `ClientSecret` present; `ExplicitAuthFlows` as in AUTHENTICATION.md; `AllowedOAuthFlowsUserPoolClient`
     false; `PreventUserExistenceErrors` `ENABLED`; `SupportedIdentityProviders` only `COGNITO`.
   - `aws cognito-idp describe-user-pool --user-pool-id <pool>`: no `Domain`/`CustomDomain`;
     `AutoVerifiedAttributes` contains `email`; `UsernameAttributes` is `email`; MFA off; password
     policy as you want users to meet it (the UI does not repeat it; `password_rejected` is shown).
   - Optional, on a **test** pool, not production: `aws cognito-idp sign-up --client-id <id>
     --username a@example.com --password ...` **without** `--secret-hash` must fail with
     `NotAuthorizedException` ("Unable to verify secret hash").
   - Last: **Sign-up -> Self-service sign-up: enabled** (`AdminCreateUserConfig.AllowAdminCreateUserOnly=false`).
5. **Render environment** (secrets entered in the dashboard, never in chat or the repository):
   `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY` (secret), `RECAPTCHA_ALLOWED_HOSTNAMES=mydubb.com`,
   `COGNITO_CLIENT_SECRET` (already set), `CLIENT_IP_HEADER=cf-connecting-ip` (already set), the
   `SIGNUP_*` limits you approve, then `PUBLIC_SIGNUP_ENABLED=true` and a redeploy/restart.
6. **Acceptance** (a real mailbox you own): `/api/meta` shows `self_registration: true` and the CSP
   has `https://www.google.com/recaptcha/`; Create account -> code email -> Verify -> Sign in ->
   Studio shows "Your plan" with 20 Generates and 5 imports; signing in before verifying fails;
   Create account with an existing email shows the same Verify screen and sends nothing; wrong code
   and Resend work; the logs (Render) contain no email, code, token or password; light/dark, phone.
7. **Turning it off**: `PUBLIC_SIGNUP_ENABLED=false` and restart (Create account disappears, the
   endpoints answer 404, the CSP drops Google). Optionally also disable self-service sign-up in
   Cognito. Accounts already created stay (Free); unconfirmed sign-ups cannot finish while it is off.
