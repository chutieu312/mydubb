# Browser E2E tests

Playwright tests that drive the real production-style container (FastAPI serving the React
build) with **mock providers only**. Azure is never called.

## What is covered

Each test runs in two Playwright projects: `desktop` (Desktop Chrome) and `mobile`
(Pixel 7: 412 px viewport, touch, Chromium).

| Spec | Scenarios |
|---|---|
| `workflow.spec.ts` | Wrong Access Code rejected; session cookie and code not readable by JavaScript; server-side validation errors (empty transcript, last <= first); full mock job: 202 response, 360 s target, intermediate stages observed, transcript/result rendered as text only (HTML payload inert), timestamp-like spoken content ("10:30 is our meeting time.") preserved in order, mock notices, audio metadata loads, MP3 download (`attachment`, `audio/mpeg`), polling stops after completion; no horizontal overflow at phone width |
| `logout.spec.ts` | Successful logout ends the server session (reload stays signed out); network failure and HTTP 500 during logout keep the user signed in with an error, the real session stays valid, and a retry succeeds |

### Email + password sign-in (`auth.*.spec.ts`)

A second service, `app-cognito`, runs the same image with `AUTH_MODE=cognito`. It is **not** Amazon
Cognito: [fake-cognito/serve.py](fake-cognito/serve.py) injects the backend's own in-memory
`FakeCognito` (`backend/tests/fake_cognito.py`, mounted read-only) through the documented
`build_services(cognito_client=...)` hook, and a control server on `127.0.0.1:${E2E_CONTROL_PORT}`
plays the administrator and the inbox (create users, read the emailed codes, fail the next call of
one user). Everything else is the real backend and the built UI, with its own throwaway database.
These specs run in the projects `auth-desktop` and `auth-mobile` (`E2E_COGNITO_BASE_URL`).

| Spec | Scenarios |
|---|---|
| `auth.signin.spec.ts` | `/api/meta` announces `cognito` and `/api/session` is gone; sign in, reload restore, a dubbing job with CSRF, download; no display name; wrong password and unknown account answer the same; disabled account; temporary password then email verification (nothing sent until asked, wrong code, resend); an expired pending step |
| `auth.recovery.spec.ts` | Forgot password says the same for known and unknown addresses; reset then sign in with the new password only; wrong code and rejected password; local code/confirmation checks; an unknown reset outcome (one request, server message, no retry, sign-in refused meanwhile) |
| `auth.session.spec.ts` | Sign out and a fresh start; failed sign out (network, 503) and retry; session expiry with the draft coming back for the same user only; two accounts never see each other's jobs |
| `auth.layout.spec.ts` | Every screen in Light and Dark at 320/390/412/1280 px: no overflow, nothing sticking out of its card, contrast, long emails and messages; keyboard order and focus; field errors announced. Screenshots go to `test-results/auth-shots/` |

A live Amazon Cognito run is **not** covered here.

### Live browser acceptance (opt-in, not in CI)

[live/](live/README.md) holds a separate, manual run against a local backend on a real Cognito
**dev** pool (`npx playwright test -c playwright.live.config.ts`). It is never picked up by this
suite, `npm test` or CI. Its tooling is tested with fake data by `npm run test:live-tooling`.

Not covered: WebKit / iOS Safari, Firefox, real devices, Azure. The mock stack has no real audio
processing, so exact-duration fitting is covered elsewhere: the backend tests and
`docker/audio_runtime_check.py` run the real FFmpeg (see
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#duration-fitting-milestone-3c)).

## Isolation and destructive scope

`run-e2e.sh` starts a separate Compose project, **`mydubb-e2e`**
([docker-compose.e2e.yml](docker-compose.e2e.yml)):

- its own PostgreSQL with data on **tmpfs** (no volume, no published port);
- the app image built from the repository `Dockerfile`, published on `127.0.0.1:8001`;
- a second app container for email + password sign-in on `127.0.0.1:8003` (control server on `8004`) with its own database;
- a random Access Code for the run (`E2E_ACCESS_CODE`).

When the run ends, the script runs `docker compose down --volumes` **for the `mydubb-e2e`
project only**, which deletes that throwaway database. The development stack
(`docker-compose.yml`, project `mydubb`, volume `mydubb_pgdata`) is never touched.

## Running

Prerequisites: Docker running, Node.js 22+, bash (Git Bash on Windows).

```bash
cd e2e
npm ci
npx playwright install chromium     # CI uses: npx playwright install --with-deps chromium
bash run-e2e.sh                     # build image, start stack, run all tests, tear down
```

Options:

```bash
bash run-e2e.sh --project=mobile          # extra arguments go to `playwright test`
E2E_PORT=8101 bash run-e2e.sh             # if port 8001 is taken (also E2E_COGNITO_PORT, E2E_CONTROL_PORT)
E2E_COMPOSE_PROJECT=mine bash run-e2e.sh  # another stack beside another checkout's (default: mydubb-e2e)
E2E_KEEP_STACK=1 bash run-e2e.sh          # keep the stack running to debug
npm run typecheck                         # type-check the test sources
```

With a kept stack, re-run only the tests (same shell variables):

```bash
E2E_ACCESS_CODE=<code printed in compose env> E2E_BASE_URL=http://127.0.0.1:8001 npx playwright test
docker compose -f docker-compose.e2e.yml down -v   # remove it afterwards
```

Failure artifacts (screenshots, traces) are written to `test-results/`; in CI they are
uploaded together with the HTML report.
