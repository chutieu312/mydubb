import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import { CHROME_STORE_URL } from "./features/extension/ChromeExtensionEntry";
import { META, installAuthFetch, json, meResponse, notAuthenticated } from "./test/authFetch.testkit";

// Story 5 on the website: "MyDubb for Chrome" under Try as guest, and /signup opening Create
// account (where the extension's "Create a MyDubb account" goes).

vi.mock("./lib/recaptcha", () => ({
  loadRecaptcha: vi.fn(() => new Promise(() => undefined)),
}));

const SIGNUP = {
  enabled: true,
  recaptcha_site_key: "site-key-1",
  free_plan: { generates_per_day: 20, youtube_imports_per_day: 5, max_words: 1000, max_output_seconds: 600 },
};
const guestAccess = (extension: boolean) => ({
  enabled: true,
  jobs_per_session: 5,
  jobs_per_ip: 20,
  ip_window_seconds: 86400,
  max_words: 1000,
  max_output_seconds: 600,
  session_ttl_seconds: 86400,
  extension,
});
const metaWith = (overrides: Record<string, unknown>) => () => json(200, { ...META, ...overrides });
const signupMeta = metaWith({
  auth: { mode: "cognito", self_registration: true, password_reset: true },
  signup: SIGNUP,
  guest_access: guestAccess(false),
});
const guestSession = () =>
  json(200, {
    status: "guest",
    guest: { id: "g-1" },
    csrf_token: "guest-csrf",
    expires_at: "2030-01-01T00:00:00Z",
    quota: {
      session_limit: 5,
      session_used: 1,
      session_in_progress: 0,
      session_remaining: 4,
      ip_limit: 20,
      ip_used: 1,
      ip_in_progress: 0,
      ip_remaining: 19,
      ip_window_seconds: 86400,
      ip_retry_after_seconds: null,
      max_words: 1000,
      max_output_seconds: 600,
    },
    imports: null,
  });

let fake: ReturnType<typeof installAuthFetch>;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  expect(fake?.unexpected ?? []).toEqual([]);
});

function setup(routes: Parameters<typeof installAuthFetch>[0], path = "/") {
  window.history.replaceState(null, "", path);
  fake = installAuthFetch(routes);
  return render(<App />);
}

describe("MyDubb for Chrome on the sign-in page", () => {
  it("links to the Store item and describes the published version (account only)", async () => {
    setup({
      "GET /api/meta": [metaWith({ guest_access: guestAccess(false) })],
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [notAuthenticated],
    });
    const block = await screen.findByRole("region", { name: "MyDubb for Chrome" });
    const link = within(block).getByRole("link", { name: "Install Chrome extension" });
    expect(link.getAttribute("href")).toBe(
      "https://chromewebstore.google.com/detail/nndofiifflpbhefoehcbfpnaoiohicop",
    );
    expect(link.getAttribute("href")).toBe(CHROME_STORE_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(block.textContent).toMatch(/Udemy lecture/);
    expect(block.textContent).not.toMatch(/guest/i);
    // Under Try as guest.
    const tryGuest = screen.getByRole("button", { name: "Try as guest" });
    expect(tryGuest.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("mentions trying it as a guest only once the server offers guests in the extension", async () => {
    setup({
      "GET /api/meta": [metaWith({ guest_access: guestAccess(true) })],
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [notAuthenticated],
    });
    const block = await screen.findByRole("region", { name: "MyDubb for Chrome" });
    expect(block.textContent).toMatch(/or try it as a guest/);
  });
});

describe("/signup", () => {
  it("opens Create account for a visitor", async () => {
    setup(
      {
        "GET /api/meta": [signupMeta],
        "GET /api/auth/me": [notAuthenticated],
        "GET /api/guest/session": [notAuthenticated],
      },
      "/signup",
    );
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeTruthy();
  });

  it("opens Create account for a guest too, keeping the guest session", async () => {
    setup(
      {
        "GET /api/meta": [signupMeta],
        "GET /api/auth/me": [notAuthenticated],
        "GET /api/guest/session": [guestSession],
      },
      "/signup",
    );
    expect(await screen.findByRole("heading", { name: "Create your account" })).toBeTruthy();
    expect(screen.queryByText("Your dubbing studio")).toBeNull();
    expect(fake.to("/api/guest/session").every((r) => r.method === "GET")).toBe(true);
  });

  it("is the Studio for a signed-in account, and the address goes back to /", async () => {
    setup(
      {
        "GET /api/meta": [signupMeta],
        "GET /api/auth/me": [meResponse()],
      },
      "/signup",
    );
    expect(await screen.findByText("Your dubbing studio")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("is the ordinary sign-in while sign-up is off", async () => {
    setup(
      {
        "GET /api/meta": [metaWith({})],
        "GET /api/auth/me": [notAuthenticated],
      },
      "/signup",
    );
    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(screen.getByText("Access is currently by invitation only.")).toBeTruthy();
  });
});
