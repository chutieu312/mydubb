import { describe, expect, it, vi } from "vitest";

import { allowanceOf, tokenGrantOf } from "./api";
import { ConnectError, authorizeUrl, codeFromRedirect, connect, createPkce, isLive, isStoredAuth } from "./auth";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${ID}.chromiumapp.org/`;
const GRANT = {
  access_token: "t".repeat(43),
  token_type: "Bearer" as const,
  expires_at: "2030-01-01T00:00:00Z",
  kind: "account" as const,
  user: { id: "u1", email: "lan@example.com", display_name: null },
  guest: null,
};
const GUEST_ID = "6f1c1d6e-5a8b-4b8e-9d3a-2a1c3e4f5a6b";
const GUEST_GRANT = { ...GRANT, kind: "guest" as const, user: null, guest: { id: GUEST_ID } };

describe("PKCE", () => {
  it("derives the S256 challenge of RFC 7636 appendix B", async () => {
    const bytes = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
      91, 88, 5, 88, 83, 132, 141, 121,
    ]);
    const pkce = await createPkce((n) => (n === 32 ? bytes : new Uint8Array(n)));
    expect(pkce.verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(pkce.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes a new random verifier and state each time", async () => {
    const [a, b] = [await createPkce(), await createPkce()];
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe("authorization request and answer", () => {
  const pkce = { verifier: "v".repeat(43), challenge: "c".repeat(43), state: "s".repeat(32) };

  it("opens the MyDubb connect page with the extension's own redirect URI", () => {
    const url = new URL(authorizeUrl("https://mydubb.test", ID, pkce));
    expect(`${url.origin}${url.pathname}`).toBe("https://mydubb.test/extension/connect");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: ID,
      redirect_uri: REDIRECT,
      state: pkce.state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });

  it("asks for the browser's guest session with mode=guest (Try as guest)", () => {
    const url = new URL(authorizeUrl("https://mydubb.test", ID, pkce, true));
    expect(url.searchParams.get("mode")).toBe("guest");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(new URL(authorizeUrl("https://mydubb.test", ID, pkce)).searchParams.has("mode")).toBe(false);
  });

  it.each([
    [`${REDIRECT}?code=c&state=other`, "state-mismatch"],
    [`https://evil.example/?code=c&state=${"s".repeat(32)}`, "bad-redirect"],
    [`${REDIRECT}cb?code=c&state=${"s".repeat(32)}`, "bad-redirect"],
    [`${REDIRECT}?error=access_denied&state=${"s".repeat(32)}`, "refused"],
    ["not a url", "bad-redirect"],
  ])("refuses %s", (redirect, reason) => {
    let caught: unknown = null;
    try {
      codeFromRedirect(redirect, ID, pkce.state);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConnectError);
    expect((caught as ConnectError).reason).toBe(reason);
  });
});

describe("connect", () => {
  it("exchanges the code with the verifier it made", async () => {
    let opened = "";
    const exchangeCode = vi.fn(async () => GRANT);
    const stored = await connect({
      origin: "https://mydubb.test",
      extensionId: ID,
      api: { exchangeCode },
      launchWebAuthFlow: async (url) => {
        opened = url;
        return `${REDIRECT}?code=the-code&state=${new URL(url).searchParams.get("state")}`;
      },
      newConnectionId: () => "conn-1",
    });
    const challenge = new URL(opened).searchParams.get("code_challenge");
    const [sent] = exchangeCode.mock.calls[0] as unknown as [{ code: string; code_verifier: string; redirect_uri: string }];
    expect(sent.code).toBe("the-code");
    expect(sent.redirect_uri).toBe(REDIRECT);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sent.code_verifier)));
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(expected);
    expect(stored).toEqual({
      token: GRANT.access_token,
      user: GRANT.user,
      expiresAt: GRANT.expires_at,
      connectionId: "conn-1",
    });
    expect(isStoredAuth(stored)).toBe(true);
  });

  it("reports a closed window without asking MyDubb anything", async () => {
    const exchangeCode = vi.fn();
    await expect(
      connect({
        origin: "https://mydubb.test",
        extensionId: ID,
        api: { exchangeCode },
        launchWebAuthFlow: async () => Promise.reject(new Error("The user did not approve access.")),
        newConnectionId: () => "c",
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  const run = (grant: unknown, guest: boolean) =>
    connect({
      origin: "https://mydubb.test",
      extensionId: ID,
      api: { exchangeCode: vi.fn(async () => tokenGrantOf(grant)!) },
      launchWebAuthFlow: async (url) => `${REDIRECT}?code=c&state=${new URL(url).searchParams.get("state")}`,
      newConnectionId: () => "conn-g",
      guest,
    });

  it("stores a guest connection under the guest session's own id, never an account id", async () => {
    const stored = await run(GUEST_GRANT, true);
    expect(stored).toEqual({
      token: GRANT.access_token,
      guest: true,
      user: { id: `guest:${GUEST_ID}`, email: "", display_name: null },
      expiresAt: GRANT.expires_at,
      connectionId: "conn-g",
    });
    expect(isStoredAuth(stored)).toBe(true);
    // A stored value that mixes the two is not a connection.
    expect(isStoredAuth({ ...stored, guest: undefined })).toBe(false);
    expect(isStoredAuth({ ...stored, user: GRANT.user })).toBe(false);
  });

  it("keeps an account chosen on the page for Try as guest, and refuses a guest nobody asked for", async () => {
    expect((await run(GRANT, true)).user).toEqual(GRANT.user);
    await expect(run(GUEST_GRANT, false)).rejects.toMatchObject({ reason: "refused" });
  });

  it("reads token answers of older servers (no kind) and refuses malformed ones", () => {
    const older = { access_token: GRANT.access_token, token_type: "Bearer", expires_at: GRANT.expires_at, user: GRANT.user };
    expect(tokenGrantOf(older)).toEqual(GRANT);
    expect(tokenGrantOf({ ...GUEST_GRANT, user: GRANT.user })).toBeNull();
    expect(tokenGrantOf({ ...GUEST_GRANT, guest: { id: "x" } })).toBeNull();
    expect(tokenGrantOf({ ...GRANT, kind: "admin" })).toBeNull();
  });

  it("reads today's limits from the session answer", () => {
    const guestQuota = { session_limit: 5, session_used: 2, session_in_progress: 1, session_remaining: 2, ip_remaining: 1 };
    expect(allowanceOf({ kind: "guest", guest: { id: GUEST_ID }, quota: guestQuota })).toEqual({
      kind: "guest",
      used: 2,
      inProgress: 1,
      limit: 5,
      remaining: 1,
    });
    const usage = { plan: "free", exempt: false, resets_at: "2030-01-02T00:00:00Z", generate: { used: 3, limit: 20, remaining: 17 } };
    expect(allowanceOf({ kind: "account", user: GRANT.user, usage })).toMatchObject({ kind: "account", remaining: 17, limit: 20 });
    // An older server sends neither: nothing is shown.
    expect(allowanceOf({ user: GRANT.user, expires_at: "2030-01-01T00:00:00Z" })).toBeNull();
  });

  it("knows when a stored token has expired", () => {
    const auth = { token: "t", user: GRANT.user, expiresAt: "2030-01-01T00:00:00Z", connectionId: "c" };
    expect(isLive(auth, Date.parse("2029-12-31T23:59:59Z"))).toBe(true);
    expect(isLive(auth, Date.parse("2030-01-01T00:00:00Z"))).toBe(false);
  });
});
