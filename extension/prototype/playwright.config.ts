import { defineConfig } from "@playwright/test";

// The Sync prototype's browser tests (development only): the prototype build in Playwright's
// Chromium against the local fixture server. `npm run test:prototype`. Not part of CI.
export default defineConfig({
  testDir: "e2e",
  // live.spec.ts has no test unless PROTO_LIVE_URLS is set.
  testMatch: /(prototype|autoplay-check|live)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: "list",
});
