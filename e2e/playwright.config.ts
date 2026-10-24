import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8001";
// The email + password stack (run-e2e.sh starts it next to the Access Code one).
const cognitoURL = process.env.E2E_COGNITO_BASE_URL;
const isCI = Boolean(process.env.CI);

// Specs named auth.*.spec.ts talk to the email + password stack; all others to the Access Code one.
const authSpecs = /auth\..*\.spec\.ts$/;

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
    { name: "desktop", testIgnore: authSpecs, use: { ...devices["Desktop Chrome"] } },
    // Chromium with a phone viewport and touch; WebKit/iOS Safari is not covered.
    { name: "mobile", testIgnore: authSpecs, use: { ...devices["Pixel 7"] } },
    ...(cognitoURL
      ? [
          {
            name: "auth-desktop",
            testMatch: authSpecs,
            use: { ...devices["Desktop Chrome"], baseURL: cognitoURL },
          },
          {
            name: "auth-mobile",
            testMatch: authSpecs,
            use: { ...devices["Pixel 7"], baseURL: cognitoURL },
          },
        ]
      : []),
  ],
});
