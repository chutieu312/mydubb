# Live browser acceptance (opt-in, never part of CI)

Real Chromium, the real built UI, a running backend and a real Cognito **dev** user pool with two
pre-onboarded, email-verified users. Providers should be mock (no Azure). It only signs in, runs mock
jobs and signs out: it never changes a password and never triggers an email.

1. Put the two users in `e2e/.env.live` (Git-ignored; fields `LIVE_USER1_EMAIL`, `LIVE_USER1_PASSWORD`,
   `LIVE_USER2_EMAIL`, `LIVE_USER2_PASSWORD`). Edit it with an editor; never paste it elsewhere.
2. Build the UI: `cd frontend && npm run build`.
3. Serve it same-origin with the backend: `cd e2e && LIVE_BACKEND=http://127.0.0.1:58090 node live/serve.mjs`.
   (The server keeps Host, Origin and cookies untouched, so the backend's own Origin check passes
   without `TRUSTED_ORIGINS`.)
4. Run: `cd e2e && npx playwright test -c playwright.live.config.ts`.

Safety: trace, video and automatic screenshots are off, failure messages are scrubbed of every
credential, and manual screenshots (`test-results/live-shots/`) mask the account name and the form
fields. Playwright still writes `test-results/live/*/error-context.md` when a test fails; it can contain
the account name, so delete that folder after a failed run.
