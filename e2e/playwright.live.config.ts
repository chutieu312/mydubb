import { defineConfig, devices } from "@playwright/test";

import { parseLoopbackUrl } from "./live/core.mjs";
import { LIVE_OUTPUT_DIR } from "./live/teardown.mjs";

// Live browser acceptance against a running local backend with a real Cognito DEV pool (see
// live/README.md). Opt-in: `npx playwright test -c playwright.live.config.ts`. The normal config
// and CI never pick up live/.
//
// Both URLs are checked here, before any browser starts or any credential is read: plain http on
// a loopback address only.
const uiUrl = parseLoopbackUrl(process.env.LIVE_UI_URL ?? "http://127.0.0.1:5199", "LIVE_UI_URL");
parseLoopbackUrl(process.env.LIVE_BACKEND ?? "http://127.0.0.1:58090", "LIVE_BACKEND");

// Artifacts would record what is typed into the sign-in form or shown in the header:
// - trace, video and automatic screenshots are off;
// - PLAYWRIGHT_NO_COPY_PROMPT stops Playwright 1.64 from adding the page's aria snapshot to
//   error-context.md (set here, so the workers inherit it);
// - the output folder is this run's own and is deleted by the global teardown, also after a
//   failure (not if the process is killed).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./live",
  testMatch: /live\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: LIVE_OUTPUT_DIR,
  globalTeardown: "./live/teardown.mjs",
  use: {
    baseURL: uiUrl.origin,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "live-chromium", use: { ...devices["Desktop Chrome"] } }],
});
