import { defineConfig } from "@playwright/test";

// Story 5 integration check (integration/README.md): the real backend and website on 127.0.0.1,
// an ordinary extension build and Chrome's real sign-in window. Not run by CI.
export default defineConfig({
  testDir: ".",
  testMatch: "*.real.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: "list",
});
