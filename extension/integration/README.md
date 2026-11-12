# Story 5 integration check (real sign-in window, real backend)

Not run by CI. It answers what the fixture tests cannot: does Chrome's sign-in window
(`chrome.identity.launchWebAuthFlow`) share the profile's mydubb.com cookies, so that the extension
continues the website's guest session and the website opens the one the extension started?

- An **ordinary** extension build (no test hook) whose server is a local stack.
- The real backend and React build from this repository (Docker image), mock providers, the
  in-memory user pool and fake reCAPTCHA siteverify of `e2e/`, a throwaway database (tmpfs).
- Playwright's Chromium, a new empty profile per test. Google's reCAPTCHA script is replaced at its
  address by a stand-in, as in `e2e/tests/signup.flow.spec.ts`. Nothing leaves 127.0.0.1 otherwise.

## Run

```bash
# 1. The extension, pointed at the local stack, copied to a folder of its own (its ID follows the path).
cd extension
MYDUBB_ORIGIN=http://127.0.0.1:8105 node build.mjs && cp -r dist /tmp/mydubb-uat-ext
# Read its ID once: chrome://extensions after Load unpacked of /tmp/mydubb-uat-ext, or from a
# Playwright launch (the host of the service worker URL).

# 2. The stack (from the repository root): image, then compose with random keys and that ID.
docker build -t mydubb-s5-uat:local .
export UAT_REPO="$PWD" UAT_EXTENSION_IDS='["<extension id>"]' \
  UAT_AUTH_KEY="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_')" \
  UAT_GUEST_KEY="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_')"
docker compose -f extension/integration/docker-compose.yml up -d --wait

# 3. The check.
cd extension && UAT_EXTENSION_DIR=/tmp/mydubb-uat-ext npx playwright test -c integration/playwright.config.ts

# 4. Remove the stack (and its database).
docker compose -f extension/integration/docker-compose.yml down -v
```

## What it covers

`onboarding.real.spec.ts`:

1. **Web first**: Try as guest on the website, 2 jobs, website closed; the panel's Try as guest
   opens the real sign-in window, which shows "3 of 5 audio jobs left" (the profile's guest cookie)
   and continues that session; one Generate in the panel; the website, opened again, shows the same
   guest session with 2 left.
2. **Extension first, website never opened**: the window is closed once (nothing connects), then
   Start guest session; one Generate; Disconnect and Try as guest again give no new job; the website
   then opens that same guest session (same id) with 4 left.
3. **Create a MyDubb account** from the panel opens `/signup`; create, verify with the code of the
   stand-in user pool, then Connect to MyDubb and sign in in the window: the panel shows the Free
   plan (20, then 19 after a Generate).

Last run (2026-11-11, this pull request): 3 passed in about 21 s.

Not covered: Google Chrome itself (this is Playwright's Chromium build), https with
`SameSite=Strict` on the real domain, the Store build, production.
