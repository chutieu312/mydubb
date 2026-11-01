import { defineConfig } from "@playwright/test";

// Chrome Web Store screenshots (store/shots/store-screenshots.spec.ts): the real extension build
// (dist-test, fake MyDubb server, synthetic lecture page) in Playwright's Chromium. Run with
// `npm run store:shots`. Nothing leaves the machine and no real account, course or service is used.
export default defineConfig({
  testDir: ".",
  testMatch: "store-screenshots.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: "list",
});
