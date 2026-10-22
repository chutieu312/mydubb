import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const META = {
  provider_mode: "mock",
  mock_mode: true,
  providers: { translation: "mock", speech: "mock", audio: "mock" },
  voices: [{ id: "HoaiMy", provider_voice: "vi-VN-HoaiMyNeural", description: "Female" }],
  timestamp_format: "HH:MM:SS",
  result_ttl_seconds: 3600,
};
const SESSION = { authenticated: true, csrf_token: "csrf-1", expires_at: "2030-01-01T00:00:00Z" };

type LogoutHandler = () => Promise<Response>;

let logoutHandlers: LogoutHandler[];
let logoutRequests: RequestInit[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message } });

beforeEach(() => {
  logoutHandlers = [];
  logoutRequests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url === "/api/meta") return json(200, META);
      if (url === "/api/session" && method === "GET") return json(200, SESSION);
      if (url === "/api/session" && method === "DELETE") {
        logoutRequests.push(init);
        const handler = logoutHandlers.shift();
        if (!handler) throw new Error("Unexpected logout request");
        return handler();
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderSignedIn() {
  render(<App />);
  await screen.findByLabelText("English Transcript");
}

const logoutButton = () => screen.getByRole("button", { name: /log(ging)? out/i });
const csrfHeader = (init: RequestInit) => (init.headers as Record<string, string>)["X-CSRF-Token"];

async function expectStillSignedIn() {
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Logout failed; you are still signed in."),
  );
  expect(screen.getByLabelText("English Transcript")).toBeTruthy();
  expect(screen.queryByLabelText("Access Code")).toBeNull();
  expect(logoutButton()).toHaveProperty("disabled", false);
}

describe("logout", () => {
  it("signs out after a confirmed successful logout", async () => {
    logoutHandlers.push(async () => new Response(null, { status: 204 }));
    await renderSignedIn();

    await userEvent.click(logoutButton());

    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
    expect(csrfHeader(logoutRequests[0]!)).toBe("csrf-1");
  });

  it("treats an already expired or unauthenticated session as signed out", async () => {
    logoutHandlers.push(async () =>
      apiError(401, "not_authenticated", "A valid session is required."),
    );
    await renderSignedIn();

    await userEvent.click(logoutButton());

    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
  });

  it("stays signed in and reports a network failure", async () => {
    logoutHandlers.push(async () => {
      throw new TypeError("Failed to fetch");
    });
    await renderSignedIn();

    await userEvent.click(logoutButton());

    await expectStillSignedIn();
  });

  it("stays signed in and reports a server failure", async () => {
    logoutHandlers.push(async () =>
      apiError(500, "internal_error", "An unexpected error occurred."),
    );
    await renderSignedIn();

    await userEvent.click(logoutButton());

    await expectStillSignedIn();
  });

  it("stays signed in and reports a CSRF rejection", async () => {
    logoutHandlers.push(async () => apiError(403, "csrf_failed", "CSRF validation failed."));
    await renderSignedIn();

    await userEvent.click(logoutButton());

    await expectStillSignedIn();
  });

  it("succeeds on retry after a failed attempt, reusing the CSRF token", async () => {
    logoutHandlers.push(
      async () => apiError(503, "http_error", "Service unavailable."),
      async () => new Response(null, { status: 204 }),
    );
    await renderSignedIn();

    await userEvent.click(logoutButton());
    await expectStillSignedIn();
    await userEvent.click(logoutButton());

    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
    expect(logoutRequests.map(csrfHeader)).toEqual(["csrf-1", "csrf-1"]);
  });

  it("sends only one request while a logout is pending", async () => {
    let finish: (response: Response) => void = () => {};
    logoutHandlers.push(() => new Promise<Response>((resolve) => (finish = resolve)));
    await renderSignedIn();

    const button = logoutButton();
    await userEvent.click(button);
    await userEvent.click(button);

    expect(logoutRequests).toHaveLength(1);
    expect(button).toHaveProperty("disabled", true);
    expect(button.textContent).toBe("Logging out…");

    finish(new Response(null, { status: 204 }));
    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
  });
});
