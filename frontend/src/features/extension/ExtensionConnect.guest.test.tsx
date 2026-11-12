import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "../../api/client";
import {
  META,
  apiError,
  installAuthFetch,
  json,
  meResponse,
  noContent,
  notAuthenticated,
} from "../../test/authFetch.testkit";
import { ExtensionConnect } from "./ExtensionConnect";

// The panel's "Try as guest" (docs/EXTENSION_AUTH.md, "Guests"): /extension/connect?mode=guest.

const ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${ID}.chromiumapp.org/`;
const STATE = "s".repeat(32);
const params = {
  client_id: ID,
  redirect_uri: REDIRECT,
  state: STATE,
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
};
const GUEST_SEARCH = "?" + new URLSearchParams({ ...params, mode: "guest" }).toString();
const TARGET = `${REDIRECT}?code=g1&state=${STATE}`;

const guestMeta = (extension: boolean) => () =>
  json(200, {
    ...META,
    guest_access: {
      enabled: true,
      jobs_per_session: 5,
      jobs_per_ip: 20,
      ip_window_seconds: 86400,
      max_words: 1000,
      max_output_seconds: 600,
      session_ttl_seconds: 86400,
      extension,
    },
  });

const guestBody = (used = 0) => ({
  status: "guest",
  guest: { id: "g-1" },
  csrf_token: "guest-csrf",
  expires_at: "2030-01-01T00:00:00Z",
  quota: {
    session_limit: 5,
    session_used: used,
    session_in_progress: 0,
    session_remaining: 5 - used,
    ip_limit: 20,
    ip_used: used,
    ip_in_progress: 0,
    ip_remaining: 20 - used,
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
  expect(fake?.unexpected ?? []).toEqual([]);
});

function setup(routes: Parameters<typeof installAuthFetch>[0], search = GUEST_SEARCH) {
  fake = installAuthFetch(routes);
  const navigate = vi.fn();
  render(<ExtensionConnect search={search} navigate={navigate} />);
  return { navigate, user: userEvent.setup() };
}

describe("ExtensionConnect, Try as guest", () => {
  it("continues the browser's guest session without starting one", async () => {
    const { navigate, user } = setup({
      "GET /api/meta": [guestMeta(true)],
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [() => json(200, guestBody(2))],
      "POST /api/extension/guest/authorize": [() => json(200, { redirect_url: TARGET })],
    });
    expect(await screen.findByText("3 of 5 audio jobs left")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue in the extension" }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(TARGET));
    const [sent] = fake.to("/api/extension/guest/authorize");
    expect(sent?.headers["X-CSRF-Token"]).toBe("guest-csrf");
    expect(sent?.body).toEqual(params);
    expect(fake.to("/api/guest/session").every((r) => r.method === "GET")).toBe(true);
  });

  it("starts a guest session only once the user confirms, then connects", async () => {
    const { navigate, user } = setup({
      "GET /api/meta": [guestMeta(true)],
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [notAuthenticated],
      "POST /api/guest/session": [() => json(201, guestBody())],
      "POST /api/extension/guest/authorize": [() => json(200, { redirect_url: TARGET })],
    });
    expect(await screen.findByRole("heading", { name: "Try MyDubb as a guest" })).toBeTruthy();
    expect(screen.getByText(/up to 5 audio jobs of up to 1,000 words and 10 minutes/)).toBeTruthy();
    expect(fake.to("/api/guest/session").filter((r) => r.method === "POST")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Start guest session" }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(TARGET));
    expect(fake.to("/api/extension/guest/authorize")[0]?.headers["X-CSRF-Token"]).toBe(
      "guest-csrf",
    );
  });

  it("shows the server's refusal to start a guest session and connects nothing", async () => {
    const { navigate, user } = setup({
      "GET /api/meta": [guestMeta(true)],
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [notAuthenticated],
      "POST /api/guest/session": [
        () => apiError(429, "guest_sessions_exhausted", "Too many guest sessions were started."),
      ],
    });
    await user.click(await screen.findByRole("button", { name: "Start guest session" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many guest sessions were started.",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start guest session" })).toBeTruthy();
  });

  it("offers to start again when the guest session ended before approving", async () => {
    const { navigate, user } = setup({
      "GET /api/meta": [guestMeta(true)],
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [() => json(200, guestBody())],
      "POST /api/extension/guest/authorize": [notAuthenticated],
    });
    await user.click(await screen.findByRole("button", { name: "Continue in the extension" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/guest session has ended/);
    expect(screen.getByRole("button", { name: "Start guest session" })).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a signed-in browser is told it is an account, and can sign out to continue as a guest", async () => {
    const { navigate, user } = setup({
      "GET /api/meta": [guestMeta(true)],
      "GET /api/auth/me": [meResponse()],
      "POST /api/auth/logout": [noContent],
      "GET /api/guest/session": [notAuthenticated],
    });
    expect(await screen.findByText(/You chose Try as guest in the extension/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sign out and continue as a guest" }));
    expect(await screen.findByRole("button", { name: "Start guest session" })).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("is refused while the server does not offer guests in the extension", async () => {
    setup({ "GET /api/meta": [guestMeta(false)] });
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /not available right now/,
    );
  });

  it("Connect (no mode) still never offers a guest", async () => {
    setup(
      {
        "GET /api/meta": [guestMeta(true)],
        "GET /api/auth/me": [notAuthenticated],
      },
      "?" + new URLSearchParams(params).toString(),
    );
    expect(await screen.findByText("Sign in to connect the MyDubb Chrome extension.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /guest/i })).toBeNull();
  });
});
