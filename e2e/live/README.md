# Live browser acceptance (opt-in, never part of CI)

Real Chromium, the real built UI, a **local** backend and a real Cognito **dev** user pool with two
pre-onboarded, email-verified users. Providers should be mock (no Azure). It only signs in, runs
mock jobs and signs out: it never changes a password, never asks for a code and never sends email.
The default Playwright config, `npm test`, `run-e2e.sh` and CI never pick up this folder.

Last result: **14/14 on `ae1fa18`** (local backend, real Cognito dev pool, mock providers,
Chromium desktop and 390 px). That is not production and not onboarding/verification/reset.

## Run

1. Fill `e2e/.env.live` with an editor (it is Git-ignored; never paste it anywhere else).
2. Build the UI: `cd frontend && npm run build`.
3. Serve it on the same origin as the API: `cd e2e && LIVE_BACKEND=http://127.0.0.1:58090 node live/serve.mjs`.
   The server keeps Host, Origin and cookies untouched, so the backend's own same-origin check passes
   without `TRUSTED_ORIGINS`.
4. Run: `cd e2e && npx playwright test -c playwright.live.config.ts`
   (`LIVE_UI_URL`, default `http://127.0.0.1:5199`).

## Credentials file format

`e2e/.env.live` (or the file named by `LIVE_ENV_FILE`, used with fake users by the tooling checks):

```
# comments and empty lines are ignored
LIVE_USER1_EMAIL=first@example.com
LIVE_USER1_PASSWORD=everything after the first = is the password
LIVE_USER2_EMAIL=second@example.com
LIVE_USER2_PASSWORD=...
```

- Exactly these four names, each once, at the start of the line, `=` right after the name.
- The value is used **byte for byte**: no trimming, no quotes, no escapes, no inline comments.
  `#`, `=`, quotes, backslashes and spaces are part of the password. A password that starts or ends
  with whitespace triggers a warning (by field name) and is still used as written.
- CRLF line ends and a UTF-8 BOM are fine. Any other line is an error that names the line number and
  the problem, never its content.

## Safety

- **Local only.** `LIVE_UI_URL` and `LIVE_BACKEND` must be `http://` on a loopback address
  (localhost, 127.0.0.0/8, ::1) with no path or user info; the config refuses anything else before a
  browser starts or the credentials file is read. `serve.mjs` refuses a non-loopback backend, a
  non-loopback `Host` header (DNS rebinding) and a backend redirect that leaves the browser's
  origin. Every browser profile aborts requests to any other origin.
- **Credentials stay out of messages.** They are typed with `keyboard.insertText` after focusing the
  field, so no Playwright call that waits or can fail carries them (a failed `fill(value)` prints
  the value in its call log). Assertions compare them in code and assert booleans. Every failure
  message is additionally scrubbed of their raw, JSON-escaped and URL-encoded forms.
- **Artifacts.** Trace, video and automatic screenshots are off, and `PLAYWRIGHT_NO_COPY_PROMPT=1`
  stops Playwright 1.64 from adding the page's aria snapshot to `error-context.md`. The run's own
  output folder (`e2e/test-results/live`, checked as an absolute path) is deleted by the global
  teardown after every run, passed or failed. Playwright writes `.last-run.json` (status and test ids
  only) there after the teardown. Manual screenshots (`test-results/live-shots/`) mask the account
  name and the form fields and are taken before anything is typed on the sign-in screen.
- **Sessions.** Every browser profile is signed out (`/api/auth/me` for the CSRF token, then
  `POST /api/auth/logout`) before it is closed, in `afterAll` and in the mobile test's `finally`,
  also when a test failed; a cleanup problem is counted, never thrown, so it cannot hide the test's
  own error. The run prints `live cleanup: N session(s) signed out, ...`.

## Limits (what cleanup cannot guarantee)

- If the process is killed (kill -9, a crash, closing the terminal, a power cut), neither the
  sign-out nor the teardown runs: sessions stay valid until they expire (`SESSION_TTL_SECONDS`, 12 h by
  default) and `test-results/live` may keep an `error-context.md`. Delete that folder without opening
  it, and revoke the sessions with `scripts/auth_users.py revoke-sessions` if needed.
- A session whose cookie was lost cannot be signed out from the browser side.
- Redaction is a last line of defence, not a guarantee for every possible encoding.

## Tooling checks (fake data only)

`cd e2e && npm run test:live-tooling` runs `live/core.test.mjs`: loopback URLs, redirects, path
traversal and sibling `dist*` folders, malformed encoding, the credentials parser with tricky values,
redaction of escaped forms, `serve.mjs` against a fake backend, and the teardown deleting only its
own folder.
