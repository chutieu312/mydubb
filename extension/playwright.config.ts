import { defineConfig } from "@playwright/test";

// Loads the unpacked test build (dist-test/) into Playwright's Chromium. Pages on
// https://www.udemy.com are answered by local fixtures through request routing; the real site is
// never contacted. See e2e/extension.spec.ts.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
});
