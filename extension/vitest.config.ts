import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __MYDUBB_E2E__: "false" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
