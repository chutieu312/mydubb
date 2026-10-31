import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-test", "node_modules", "playwright-report", "test-results"] },
  {
    files: ["**/*.{ts,js,mjs}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node, chrome: "readonly" },
    },
    rules: {
      // Page and transcript text must never be interpreted as HTML.
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: "Use textContent; never render page or transcript text as HTML." },
        { property: "outerHTML", message: "Use textContent; never render page or transcript text as HTML." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: "Do not insert HTML." },
      ],
    },
  },
  {
    // Tests and fixture pages build their own static markup.
    files: ["**/*.test.ts", "e2e/**"],
    rules: { "no-restricted-properties": "off" },
  },
);
