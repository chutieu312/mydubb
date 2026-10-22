import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8001";
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Jobs share one small app instance; keep load predictable.
  workers: 2,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Chromium with a phone viewport and touch; WebKit/iOS Safari is not covered.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
