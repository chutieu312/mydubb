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

Not covered: WebKit / iOS Safari, Firefox, real devices, Azure, exact-duration audio.

## Isolation and destructive scope

`run-e2e.sh` starts a separate Compose project, **`mydubb-e2e`**
([docker-compose.e2e.yml](docker-compose.e2e.yml)):

- its own PostgreSQL with data on **tmpfs** (no volume, no published port);
- the app image built from the repository `Dockerfile`, published on `127.0.0.1:8001`;
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
E2E_PORT=8101 bash run-e2e.sh             # if port 8001 is taken
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
