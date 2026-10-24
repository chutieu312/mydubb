import { describe, expect, it } from "vitest";

// Source-level guards for the sign-in code. They protect two promises: credentials never reach
// browser storage or logs, and there is no mock or bypass sign-in path in what ships.
const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const isTestFile = (path: string) => /\.test\.tsx?$|\.testkit\.ts$/.test(path);
const shipped = Object.entries(sources).filter(([path]) => !isTestFile(path));
const authFiles = shipped.filter(([path]) =>
  /features\/auth\/|api\/auth|lib\/passwordPolicy/.test(path),
);

describe("sign-in source guards", () => {
  it("finds the files it is meant to check", () => {
    expect(authFiles.length).toBeGreaterThanOrEqual(10);
    expect(shipped.length).toBeGreaterThan(authFiles.length);
  });

  it("never touches browser storage, cookies, the console or build-time flags", () => {
    const forbidden =
      /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|import\.meta\.env|window\.name|history\.(push|replace)State/;
    for (const [path, source] of authFiles) {
      expect(source, path).not.toMatch(forbidden);
    }
  });

  it("has no mock, fake or bypass sign-in in shipped code", () => {
    for (const [path, source] of shipped) {
      expect(source, path).not.toMatch(/testkit|fakeLogin|mockAuth|mockLogin|bypassAuth|skipAuth/i);
    }
  });

  it("does not offer public sign up", () => {
    for (const [path, source] of authFiles) {
      expect(source, path).not.toMatch(/sign ?up|create (an )?account|register/i);
    }
  });

  it("does not name the identity provider in user-facing code", () => {
    for (const [path, source] of authFiles) {
      // errors.ts holds the pattern that filters these words out of server messages.
      if (path.endsWith("/errors.ts")) continue;
      expect(source.replace(/\/\/.*$/gm, ""), path).not.toMatch(/cognito|\baws\b/i);
    }
  });
});
