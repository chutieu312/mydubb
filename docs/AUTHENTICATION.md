# Authentication: Access Code and Amazon Cognito

MyDubb has two exclusive sign-in modes, chosen by `AUTH_MODE`:

| Mode | Who can sign in | Default |
|---|---|---|
| `access_code` | Anyone with the Private Beta Access Code (one shared code) | **Yes** (production today) |
| `cognito` | Invited users with an email and a password in an Amazon Cognito user pool | No: needs the setup and cutover below |

The HTTP contract for the UI is [AUTH_API.md](AUTH_API.md). This page covers the design, the AWS
setup, operations, cutover, rollback and limits. Status: the backend is implemented and tested
against a **fake** user pool; it has **not** been run against a real Cognito user pool yet, and no
AWS resource has been created.

## Design

```
Browser (Studio UI) ──same origin──► FastAPI (Render) ──HTTPS, public user pool API──► Amazon Cognito
      │  cookie mydubb_auth (opaque, HttpOnly)          │                                (us-west-2, Lite)
      │                                                 ▼
      │                                          PostgreSQL (Neon): users, user_sessions,
      │                                          auth_challenges, password_reset_attempts,
      │                                          password_reset_events, jobs.user_id
```

- **Cognito owns credentials.** Passwords go from the browser to MyDubb over HTTPS, are forwarded
  once to Cognito over TLS and are never stored or logged. MyDubb has no password or password hash.
- **MyDubb owns the session.** After Cognito accepts a sign-in, MyDubb opens its own session: a
  random 256-bit token in the `mydubb_auth` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` in
  production, absolute lifetime `SESSION_TTL_SECONDS`, default 12 h) whose SHA-256 is stored in
  `user_sessions`. Cognito tokens are never sent to the browser and nothing goes to `localStorage`.
  CSRF (`X-CSRF-Token` synchronizer token), the Origin check and the body-size guard apply exactly
  as for Access Code sessions.
- **Cognito tokens are mostly not kept.** The ID and refresh tokens are dropped as soon as the
  response is parsed. The access token is used once (`GetUser`) and dropped, except while an email
  verification is pending, when it is stored **encrypted** (below). Nothing refreshes Cognito tokens.
- **Identity** is `(cognito_issuer, cognito_sub)`, unique in `users`. The email address and display
  name (`name` attribute) are profile data refreshed at each sign-in; the email is never an
  identity key (a different Cognito user who later gets the same email is a different MyDubb user).
- **Jobs** created in Cognito mode store `user_id` (from the session, never from the request) and no
  `session_id`. Reading a job, its result or its audio requires `jobs.user_id` to be the caller;
  anything else returns `404`. Access Code jobs keep `user_id = NULL` and are never visible to, or
  assigned to, a user.
- **No AWS credentials.** The backend calls only public and token-authorized user pool operations
  (`InitiateAuth` with `USER_PASSWORD_AUTH`, `RespondToAuthChallenge`, `GetUser`,
  `GetUserAttributeVerificationCode`, `VerifyUserAttribute`, `ForgotPassword`,
  `ConfirmForgotPassword`), which Cognito does not authorize with IAM. Plain HTTPS through `httpx`
  (the AWS JSON 1.1 protocol), like the Azure integrations: no boto3, no Identity Pool, Lambda or API
  Gateway. Requests never follow a redirect and are never retried; failures are reported
  (`503 auth_unavailable`), never hidden. **Time limits:** `COGNITO_TIMEOUT_SECONDS` (T, default
  10) bounds each phase of a request separately (waiting for a connection, connecting, each write,
  each read; that is what `httpx.Timeout` does, it is not a total deadline), and MyDubb adds a
  response deadline of T from the start of the call, checked while the answer is read. A read that
  started just before the deadline can still wait up to T, so a call ends within about 2T. Name
  resolution (DNS) goes through the operating system and is not bounded by MyDubb, and nothing
  bounds how long Cognito itself takes to apply a request it received.
- **No database transaction is open while Cognito is called.** Each step is a short transaction
  before or after the request.

### Pending sign-in steps (challenges)

A sign-in that is not finished yet (temporary password, unverified email) gets a row in
`auth_challenges`:

| Field | Purpose |
|---|---|
| `token_hash` | SHA-256 of the opaque `challenge_id` returned to the UI (32 random bytes) |
| `binding_hash` | SHA-256 of the `mydubb_auth_challenge` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/api/auth`): the step can only be finished in the same browser |
| `kind` | `new_password` or `email_verification`: a challenge only works for its own step |
| `encrypted_payload` | The Cognito sign-in session + username (new password) or the access token (email verification), AES-256-GCM with `AUTH_TOKEN_ENCRYPTION_KEY`, associated data = row id + kind. Erased when the step ends |
| `expires_at` | `AUTH_NEW_PASSWORD_CHALLENGE_TTL_SECONDS` (default 180, matching Cognito's default 3-minute sign-in session) or `AUTH_EMAIL_VERIFICATION_CHALLENGE_TTL_SECONDS` (default 900, below the access token's 60 minutes) |
| `locked_until`, `lease_token`, `consumed_at`, `attempts`, `sends` | Concurrency and replay protection, see below |

A request claims the challenge with one compare-and-set `UPDATE` (matching token, binding, kind,
not consumed, not expired, not held) that takes a short lease and stamps it with a fresh random
`lease_token`; a concurrent request for the same challenge gets `409 challenge_busy`, a replay
after completion gets `400 challenge_invalid`. Completing (consume) and releasing are
compare-and-set on **that lease token**, so a request whose lease ran out and was taken over by
another request changes nothing: it cannot release the new holder's lease, count an attempt,
complete the step or create a session, and it answers `409 challenge_busy`. Completing also
re-checks `expires_at`: a step that expired while Cognito was answering is closed without a
session (`400 challenge_invalid`). The lease length (`COGNITO_TIMEOUT_SECONDS` + 5 s) only decides
when a stuck request may be taken over; correctness does not depend on it.

Side effects at Cognito cannot be undone: if a request loses its step (or the step expires) after
Cognito already **set the new password** or **verified the email**, that change stays, and the next
sign-in uses the new password or finds the email verified. The step's session is never created by
the request that lost it.

The step that succeeds consumes the challenge; 5 failed attempts (wrong code or rejected password)
consume it; at most 3 verification emails per challenge. A challenge never gives access to jobs or
`/api/auth/me`. Rotating `AUTH_TOKEN_ENCRYPTION_KEY` only breaks steps in flight (they end with
`challenge_invalid`; sign in again).

### Flows

| Flow | Calls | Result |
|---|---|---|
| Sign-in | `InitiateAuth` -> `GetUser` | `authenticated`, or `new_password_required` / `email_verification_required` |
| Invitation (temporary password) | `InitiateAuth` returns `NEW_PASSWORD_REQUIRED` -> `RespondToAuthChallenge` -> `GetUser` | `authenticated` or `email_verification_required` |
| Email verification | `GetUserAttributeVerificationCode` (on "send"), `VerifyUserAttribute`, `GetUser` | `authenticated` only once Cognito reports `email_verified=true` |
| Forgot password | `ForgotPassword` | Always `202` (no account enumeration) |
| Reset password | Attempt recorded, `ConfirmForgotPassword`, outcome recorded (revocation) | `200`; not signed in. `503` when the outcome is unknown (signed out everywhere) |
| Logout | none | session revoked server-side |

**Email verification is enforced by MyDubb.** With email as the user pool's username attribute,
Cognito lets a user sign in with an unverified email. MyDubb therefore checks `email_verified` from
`GetUser` after every successful authentication and creates no session (and no user row) until it
is `true`. Nothing in MyDubb marks an email verified; an administrator must not tick "Mark email
address as verified" when inviting (the invitation email itself does not prove MyDubb's check). AWS
documentation does not state whether completing the temporary-password step marks the email
verified, so the code does not assume it either way: it reads the attribute.

**No account enumeration.** Wrong password, unknown user, user disabled in Cognito and an
administrator-forced reset all return the same `401 invalid_credentials`. `forgot-password` always
answers `202`; `reset-password` answers one `400 code_invalid` for a wrong, expired or never
requested code and for unknown or disabled accounts. This relies on the app client setting
**Prevent user existence errors** (`ENABLED`). Only a correct password reveals more
(`account_disabled` for a user disabled in MyDubb, or the next step).

**Rate limits.** Failed sign-ins use the existing limiter (`ACCESS_MAX_FAILURES_PER_CLIENT` /
`_GLOBAL` / `ACCESS_FAILURE_WINDOW_SECONDS`). Recovery requests (forgot, reset, verification-code
sends) count every request, per client (`AUTH_RECOVERY_MAX_PER_CLIENT`, default 5), per email address
(`AUTH_RECOVERY_MAX_PER_EMAIL`, default 3, hashed) and overall (`AUTH_RECOVERY_MAX_GLOBAL`, default
50) in `AUTH_RECOVERY_WINDOW_SECONDS` (default 900). Counters are in memory (reset on restart), like
the Access Code limiter. Cognito's own throttling returns `429 auth_rate_limited`.

### Password reset revokes sessions, including sign-ins in flight

A sign-in records `auth_started_at` from the **database clock** before its first Cognito request
and carries it through every step into the session. A completed reset runs one transaction: an
advisory lock on the email (hash), a row in `password_reset_events`,
`users.sessions_valid_after = now()` for the accounts with that email, and `revoked_at` on all
their sessions. Creating a session takes the same lock and refuses (`409 password_changed`) when a
reset event or `sessions_valid_after` is at or after its `auth_started_at`. So a sign-in that
verified the old password before the reset, but finishes after it, cannot create a session, even
for a first sign-in whose user row did not exist yet; and every request also checks
`auth_started_at > sessions_valid_after`. Reset events are deleted after a day.

#### Partial failures between Cognito and PostgreSQL

There is no transaction spanning Cognito and PostgreSQL, so the reset is recorded as an
**intent before** the Cognito request and its outcome **after** it (`password_reset_attempts`):

```
begin (commit)      pending, started_at = DB clock, settle_at = started_at + 2T + 60 s
                    (if this write fails: 503, ConfirmForgotPassword is NOT sent)
ConfirmForgotPassword (no transaction open, never retried)
  answer: success   -> succeeded: revoke now (sessions + sign-ins in flight), answer 200
  answer: refused   -> rejected:  nothing changes (wrong/expired code, password policy, ...)
  no answer         -> unknown:   revoke now and refuse sign-ins that started before settle_at;
  (timeout/5xx)                   answer 503 auth_unavailable ("could not confirm ... signed out")
recording the outcome fails (database error) or the process dies -> attempt stays pending:
  - once settle_at has passed, every request treats sessions that started before settle_at as
    revoked, and sign-ins that started before it are refused (fail closed);
  - the startup recovery and the periodic cleanup record it as unknown and revoke for good.
```

What this guarantees: once the password may have changed, old sessions stop working at the latest
when the attempt settles (about 80 s with the default timeout), even if MyDubb could not write
anything at that moment and later restarts; a reset with a wrong code never signs anyone out, and an
attempt still in flight blocks nothing. The answer to the user stays truthful: `200` when Cognito
confirmed the change (even if recording failed: enforcement follows when it settles), `503` when
the outcome is unknown.

Trade-offs (chosen for safety):

- **Unknown outcome or crash -> signed out**, even if Cognito did not change the password; after an
  unknown outcome, sign-ins (with either password) are refused with `409 password_changed` until
  the attempt settles (about 80 s).
- **An unrecorded rejection fails closed**: if even "rejected" cannot be written (database error at
  that moment), the account is signed out once the attempt settles. A caller cannot cause the
  database error, so this is not a way to sign someone out.
- **Window**: between Cognito applying the change and enforcement there are milliseconds normally,
  up to `settle_at` when recording failed.
- **Assumption**: `settle_at` assumes Cognito applies or drops a request within 60 s after MyDubb's
  own bound (2T). MyDubb cannot bound Cognito's processing or the operating system's DNS resolver;
  a change applied later than that would not revoke sign-ins that started after `settle_at`.

Other limits (stated, not hidden):

- Only resets done **through MyDubb's endpoint** revoke sessions. A password set by an administrator
  in the AWS console, or a reset done through any other client of the user pool, is not seen: also
  run `scripts/auth_users.py revoke-sessions` in that case.
- The match is by the email the user typed for the reset. If an administrator changed a user's
  email in Cognito and the user has not signed in since, their old sessions still carry the old
  email and are not revoked by a reset with the new one (revoke them with the tool).

### Disabling a user: what happens to existing sessions

| Action | New sign-ins | Pending steps | Existing MyDubb sessions |
|---|---|---|---|
| **Disable in Cognito** (console, `AdminDisableUser`) | Refused (`401 invalid_credentials`) | Email verification fails (`challenge_invalid`): Cognito revokes the access tokens. A pending new-password step fails at the Cognito call | **Not affected**: they stay valid until they expire (up to `SESSION_TTL_SECONDS`, 12 h by default) or are revoked. MyDubb does not ask Cognito on each request |
| **Disable in MyDubb** (`scripts/auth_users.py disable`) | Refused after the password check (`403 account_disabled`) | Cannot finish (`account_disabled`) | **Revoked immediately**; the next request returns `401` |
| **Revoke sessions in MyDubb** (`scripts/auth_users.py revoke-sessions`) | Allowed if they start after the command | Steps that started before cannot finish (`409 password_changed`) | **Revoked immediately** |

`disable` and `revoke-sessions` move `users.sessions_valid_after` to the database clock in the same
transaction that revokes the sessions. The update holds the user row lock, which a sign-in's session
creation also takes (its upsert of the user row), so a sign-in that had already passed Cognito but
had not created its session yet cannot create one afterwards, and a pending new-password or
email-verification step that started before the command cannot complete. `enable` only clears
`disabled_at`: it never moves `sessions_valid_after` back, so it does not revive a session or a
sign-in that started before the revocation. Other users are never touched.

To remove someone's access right away, do both: disable in Cognito (no new sign-in, no password
reset) **and** run `disable` in MyDubb (ends their sessions). Deleting a user in Cognito behaves like
disabling for MyDubb; their MyDubb row and jobs stay (job metadata, no transcript).

## AWS setup (to do later, by the Product Owner)

Nothing has been created. All of it is in the AWS console, region **us-west-2 (Oregon)**, next to
Render and Neon. Cost rule: **Lite** feature plan; see the
[Cognito pricing page](https://aws.amazon.com/cognito/pricing/) for the free monthly active users;
SES email is billed separately.

### 1. User pool

1. Cognito -> **User pools** -> **Create user pool**. Application type: **Traditional web
   application** (a confidential client with a secret). Name: e.g. `mydubb`.
2. **Options for sign-in identifiers: Email only.** Do not select Username or Phone number. This
   makes email the username attribute (the immutable username is the `sub`). It cannot be changed
   after creation. Keep usernames case-insensitive (default).
3. **Required attributes for sign-up: `email` only.** Do not make `name` (or anything else)
   required: a missing required attribute turns the first sign-in into a step MyDubb rejects
   (`account_setup_incomplete`). `name` stays optional and becomes the display name.
4. No return URL, domain or managed login is needed (MyDubb has its own UI). Create.
5. **Settings -> Feature plans: switch to Lite.** New user pools default to **Essentials**.
6. **Sign-up -> Self-service sign-up: disabled.** Invite-only.
7. **Authentication methods**: password policy as you like (MyDubb shows `password_rejected`
   when it is not met, without repeating the policy; tell users the rule in the invitation).
   **MFA: no MFA** (MyDubb does not handle MFA steps in this version).
8. **Sign-up -> Attribute verification**: Cognito-assisted verification by **email**, and
   **keep original attribute value active when an update is pending**. **Account recovery: email
   only.**
9. **Email**: "Send email with Cognito" works for a first test but has a low daily limit. For real
   use configure **Amazon SES** (us-west-2) with a verified identity (domain `mydubb.com` or a
   sender address); an SES account in the sandbox only delivers to verified recipients until you
   request production access. Customize the invitation message (it must keep `{username}` and
   `{####}`), e.g. with the sign-in URL `https://mydubb.com`.

### 2. App client

User pool -> **App integration / App clients** -> the client created above (or create one):

| Setting | Value |
|---|---|
| Client secret | **Generate** (confidential client). The backend computes `SECRET_HASH`; without a secret anyone could call the public API with the client ID and bypass MyDubb's rate limits |
| Authentication flows | **`ALLOW_USER_PASSWORD_AUTH`** only (plus the refresh-token flow the console always keeps; MyDubb never uses refresh tokens). Not SRP, not `ADMIN_USER_PASSWORD_AUTH`, not custom, not choice-based |
| Authentication flow session duration | 3 minutes (default). If raised, set `AUTH_NEW_PASSWORD_CHALLENGE_TTL_SECONDS` to the same or a lower value |
| Access token expiration | 60 minutes (default); must stay above `AUTH_EMAIL_VERIFICATION_CHALLENGE_TTL_SECONDS` (900 s) |
| ID / refresh token expiration | Defaults (unused by MyDubb) |
| Token revocation | Enabled (default) |
| Prevent user existence errors | **Enabled** |
| Attribute read permissions | `email`, `email_verified`, `name` (at least) |
| Attribute write permissions | As few as possible; users never get a token to call Cognito themselves, but keep `email` out of it |
| OAuth grant types / callback URLs | None |

Note the **User pool ID** (`us-west-2_...`), the **Client ID** and the **Client secret**.

### 3. IAM

The backend needs **no IAM credentials** (no access key on Render). Only the people who manage
users in the console need permissions on the user pool (for example `cognito-idp:AdminCreateUser`,
`AdminDisableUser`, `AdminEnableUser`, `AdminResetUserPassword`, `AdminDeleteUser`,
`AdminGetUser`, `ListUsers`, scoped to the user pool ARN), or the account administrator does it.

### 4. Environment variables (Render, only at cutover)

| Variable | Value | Secret |
|---|---|---|
| `AUTH_MODE` | `cognito` | no |
| `COGNITO_REGION` | `us-west-2` | no |
| `COGNITO_USER_POOL_ID` | `us-west-2_...` | no |
| `COGNITO_CLIENT_ID` | app client ID | no |
| `COGNITO_CLIENT_SECRET` | app client secret | **yes** |
| `AUTH_TOKEN_ENCRYPTION_KEY` | 32 random bytes, URL-safe base64: `python -c "import base64,secrets;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"` | **yes** |
| `COGNITO_TIMEOUT_SECONDS`, `AUTH_NEW_PASSWORD_CHALLENGE_TTL_SECONDS`, `AUTH_EMAIL_VERIFICATION_CHALLENGE_TTL_SECONDS`, `AUTH_RECOVERY_*` | optional, defaults above | no |

With `AUTH_MODE=cognito`, a missing or malformed value stops the service at startup with the
variable's name (never its value). `ACCESS_CODE` is then ignored (a warning is logged), so the
Render-generated value can stay for a quick rollback.

## Administration

- **Invite**: Cognito console -> Users -> **Create user**: email address, **Send an email
  invitation**, generate or set a temporary password, **do not** mark the email as verified. The
  user signs in at https://mydubb.com, sets a password, then verifies the email with a code.
  Temporary passwords expire after the period set in the password policy; resend from the console.
- **Disable / re-enable / sign out**: see "Disabling a user" above and the tool:

  ```bash
  cd backend
  read -rs DATABASE_URL && export DATABASE_URL     # Neon direct connection string, no echo
  uv run python -m scripts.auth_users list
  uv run python -m scripts.auth_users disable lan@example.com      # or the user id
  uv run python -m scripts.auth_users enable lan@example.com
  uv run python -m scripts.auth_users revoke-sessions lan@example.com
  unset DATABASE_URL
  ```

  `revoke-sessions` and `disable` also cancel every sign-in or pending step of that user that
  started before the command (even one that already passed Cognito); `enable` allows new sign-ins
  only. Use `revoke-sessions` after changing a user's password or email in the AWS console.
- **Password reset by the user**: "Forgot password" in the UI (only works once the email is
  verified). An administrator can also use **Reset password** in the console (then also
  `revoke-sessions`, see the limits above).

## Testing

**Automated (CI, no AWS):** `tests/fake_cognito.py` stands in for the user pool.
`tests/test_auth_cognito.py` covers sign-in, the temporary password and email verification steps,
expiry/replay/binding/concurrency of challenges, unverified users and jobs, two users and job
ownership, CSRF/logout/expiry, password reset and its races, disabled users, the two modes being
exclusive, and cleanup. `tests/test_auth_cognito_client.py` checks the real HTTP client against a
fake transport (request shape, `SECRET_HASH`, error mapping, timeouts, no redirects, no secrets in
logs) and the settings. `tests/test_auth_migration.py` checks migration `0005` with older rows.
`tests/test_auth_races.py` holds requests inside the fake Cognito (threading events, no sleeps) to
check administrator revocation against sign-ins in flight and the lease fencing of challenges;
`tests/test_auth_reset_recovery.py` covers a reset whose outcome cannot be recorded (database error
after Cognito succeeded, process interrupted, no answer from Cognito, unrecorded rejection), wrong
codes, a sign-in racing an unrecorded reset, lease operations and the client's response deadline.
Each fix was also checked by disabling it and seeing its tests fail.

**Local run in Cognito mode** (needs a real test user pool; never the production pool): put the
variables above in `backend/.env` with `AUTH_MODE=cognito`, start the backend as in the README and
call the endpoints from [AUTH_API.md](AUTH_API.md) (the UI work is separate). Use a test user with an
address you control.

**Live Cognito check (manual, not done yet).** Before the cutover, against the real pool with a
test user: invitation email arrives -> temporary password -> new password -> verification code
email -> signed in; wrong password; forgot/reset password (and an existing session is signed out);
disable in Cognito (new sign-in refused) and in MyDubb (session ended); `/api/meta` shows
`auth.mode=cognito`. None of these have been run; passing CI does not prove them.

## Production cutover (later, separate decision)

Prerequisites: this backend merged and deployed (production keeps `AUTH_MODE=access_code`, so the
deploy changes nothing visible; migration `0005` runs at startup), the Studio UI for Cognito mode
merged, the AWS setup above done, the live check passed.

1. Invite the first users in Cognito (they cannot sign in to MyDubb yet).
2. Render -> **Environment**: add the variables of step 4 with `AUTH_MODE=cognito`. Save; Render
   redeploys.
3. Check: `/api/meta` -> `"auth": {"mode": "cognito", ...}`; `POST /api/session` -> `405` (no
   Access Code login; `404` on a server without the UI); sign in with a
   test user; create a job; a second user cannot open it.
4. Effect on current users: Access Code sessions stop working immediately (they are never upgraded)
   and Access Code-era jobs are not visible to anyone in Cognito mode (their temporary results
   expire within `RESULT_TTL_SECONDS` anyway). Announce the switch.

## Rollback

- **Back to the Access Code** (configuration only): set `AUTH_MODE=access_code` (or remove it) in
  Render and save. `ACCESS_CODE` must still be set. Cognito sessions stop working (the Access Code
  mode never reads `user_sessions`), Access Code sign-in works again, and Cognito users' jobs are no
  longer visible (their rows stay; switching back to `cognito` shows them again to their owners).
- **Code rollback** follows [DEPLOYMENT.md, "Rolling back"](DEPLOYMENT.md#rolling-back): migration
  `0005` and `0006` are expand-only, but once the database is at `0006` only images that contain
  `0006` are supported Render rollback targets; older images need the emergency path
  (`RUN_MIGRATIONS_ON_START=false`), which was rehearsed (see DEPLOYMENT.md). Older code never reads
  the new tables, so it cannot accept a Cognito session.
- The tables can stay after a rollback; nothing needs to be deleted.

## Limits of this version

- No MFA, passkeys, social/SAML sign-in, self-registration, admin portal, account settings page,
  email change from MyDubb or "sign out everywhere" button (the tool does it).
- Sessions are not re-checked against Cognito: disabling or deleting a user in Cognito does not end
  existing MyDubb sessions (see above).
- Rate-limit counters are per process and reset on restart; the single-instance design applies.
- `password_rejected` does not repeat Cognito's policy text; the UI should state the rule.
- Not run against a real user pool yet.
