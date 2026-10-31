import { afterEach, describe, expect, it, vi } from "vitest";

import { installAuthFetch, json } from "../test/authFetch.testkit";
import { extensionApi, parseAuthorization } from "./extensionApi";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${ID}.chromiumapp.org/`;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const query = (overrides: Record<string, string> = {}) =>
  "?" +
  new URLSearchParams({
    client_id: ID,
    redirect_uri: REDIRECT,
    state: "s".repeat(32),
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...overrides,
  }).toString();

afterEach(() => vi.unstubAllGlobals());

describe("parseAuthorization", () => {
  it("accepts the extension's request", () => {
    expect(parseAuthorization(query())).toEqual({
      client_id: ID,
      redirect_uri: REDIRECT,
      state: "s".repeat(32),
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
  });

  it.each([
    { client_id: "not-an-extension" },
    { redirect_uri: "https://evil.example/" },
    { redirect_uri: `https://${"p".repeat(32)}.chromiumapp.org/` },
    { state: "short" },
    { code_challenge: "x" },
    { code_challenge_method: "plain" },
  ] as Record<string, string>[])("refuses %o", (overrides) => {
    expect(parseAuthorization(query(overrides))).toBeNull();
  });
});

describe("authorize", () => {
  it("goes only to the requested redirect URI", async () => {
    const auth = parseAuthorization(query())!;
    installAuthFetch({
      "POST /api/extension/authorize": [
        () => json(200, { redirect_url: `${REDIRECT}?code=c&state=s` }),
        () => json(200, { redirect_url: "https://evil.example/?code=c" }),
      ],
    });
    await expect(extensionApi.authorize(auth)).resolves.toBe(`${REDIRECT}?code=c&state=s`);
    await expect(extensionApi.authorize(auth)).rejects.toMatchObject({
      code: "unexpected_response",
    });
  });
});
