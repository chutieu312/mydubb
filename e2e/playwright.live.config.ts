import { defineConfig, devices } from "@playwright/test";

// Live browser acceptance against a running backend with a real Cognito DEV pool (see
// live/README.md). Opt-in: `npx playwright test -c playwright.live.config.ts`. The normal
// config and CI never pick up live/. Trace, video and automatic screenshots are OFF because they
// would record what is typed into the sign-in form (the report would carry credentials).
export default defineConfig({
  testDir: "./live",
  testMatch: /live\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/live",
  use: {
    baseURL: process.env.LIVE_UI_URL ?? "http://127.0.0.1:5199",
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "live-chromium", use: { ...devices["Desktop Chrome"] } }],
});
