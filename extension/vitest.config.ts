import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __MYDUBB_E2E__: "false", __MYDUBB_ORIGIN__: JSON.stringify("https://mydubb.test") },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
