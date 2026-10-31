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
  meta,
  metaWith,
  notAuthenticated,
  authenticated,
} from "../../test/authFetch.testkit";
import { ExtensionConnect } from "./ExtensionConnect";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${ID}.chromiumapp.org/`;
const SEARCH =
  "?" +
  new URLSearchParams({
    client_id: ID,
    redirect_uri: REDIRECT,
    state: "s".repeat(32),
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
  }).toString();

let fake: ReturnType<typeof installAuthFetch>;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  expect(fake?.unexpected ?? []).toEqual([]);
});

function setup(routes: Parameters<typeof installAuthFetch>[0], search = SEARCH) {
  fake = installAuthFetch(routes);
  const navigate = vi.fn();
  render(<ExtensionConnect search={search} navigate={navigate} />);
  return { navigate, user: userEvent.setup() };
}

describe("ExtensionConnect", () => {
  it("asks the signed-in user, then goes to the extension with the code", async () => {
    const { navigate, user } = setup({
      "GET /api/meta": [meta],
      "GET /api/auth/me": [meResponse()],
      "POST /api/extension/authorize": [
        () =>
          json(200, {
            redirect_url: `${REDIRECT}?code=c1&state=${"s".repeat(32)}`,
          }),
      ],
    });
    expect(await screen.findByText(/Signed in as/)).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Connect extension" }));
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`${REDIRECT}?code=c1&state=${"s".repeat(32)}`),
    );
    const [sent] = fake.to("/api/extension/authorize");
    expect(sent?.headers["X-CSRF-Token"]).toBe("csrf-1");
    expect(sent?.body).toMatchObject({
      client_id: ID,
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
    });
  });

  it("signs in on the website first; no guest entry", async () => {
    const { user } = setup({
      "GET /api/meta": [() => json(200, { ...META, guest_access: { enabled: true } })],
      "GET /api/auth/me": [notAuthenticated],
      "POST /api/auth/login": [authenticated()],
    });
    expect(await screen.findByText("Sign in to connect the MyDubb Chrome extension.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /guest/i })).toBeNull();
    await user.type(screen.getByLabelText("Email", { selector: "input" }), "ada@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Connect extension" })).toBeTruthy();
  });

  it("shows the server's refusal and stays on the page", async () => {
    const { navigate, user } = setup({
      "GET /api/meta": [meta],
      "GET /api/auth/me": [meResponse()],
      "POST /api/extension/authorize": [
        () =>
          apiError(400, "extension_unknown", "This extension is not allowed to connect to MyDubb."),
      ],
    });
    await user.click(await screen.findByRole("button", { name: "Connect extension" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This extension is not allowed to connect to MyDubb.",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses a malformed request without calling the server", () => {
    setup({}, "?client_id=x");
    expect(screen.getByRole("alert").textContent).toMatch(
      /opened from the MyDubb Chrome extension/,
    );
  });

  it("needs the invitation sign-in mode", async () => {
    setup({ "GET /api/meta": [metaWith({ mode: "access_code" })] });
    expect((await screen.findByRole("alert")).textContent).toMatch(/invitation account/);
  });
});
