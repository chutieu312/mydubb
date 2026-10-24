import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authApi } from "../../api/authApi";
import { setCsrfToken } from "../../api/client";
import {
  USER,
  apiError,
  authenticated,
  installAuthFetch,
  json,
  newPasswordRequired,
  noContent,
  verificationRequired,
} from "../../test/authFetch.testkit";
import { PasswordAuthFlow } from "./PasswordAuthFlow";

const STRONG = "Str0ngPassword";

let fake: ReturnType<typeof installAuthFetch>;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  // Every test must have used only the requests it declared.
  expect(fake?.unexpected ?? []).toEqual([]);
});

function setup(
  routes: Parameters<typeof installAuthFetch>[0] = {},
  props: Partial<Parameters<typeof PasswordAuthFlow>[0]> = {},
) {
  fake = installAuthFetch(routes);
  const onAuthenticated = vi.fn();
  render(<PasswordAuthFlow onAuthenticated={onAuthenticated} {...props} />);
  return { onAuthenticated, user: userEvent.setup() };
}

const field = (name: string) => screen.getByLabelText(name, { selector: "input" });
const button = (name: string | RegExp) => screen.getByRole("button", { name });

async function signIn(user: ReturnType<typeof userEvent.setup>, password = "pw-123456") {
  await user.type(field("Email"), "ada@example.com");
  await user.type(field("Password"), password);
  await user.click(button("Sign in"));
}

describe("sign in screen", () => {
  it("offers email, password, sign in and forgot password, and no sign up", () => {
    setup();

    expect(field("Email")).toBeTruthy();
    expect(field("Password")).toHaveProperty("type", "password");
    expect(button("Sign in")).toBeTruthy();
    expect(button("Forgot password?")).toBeTruthy();
    expect(screen.getByText("Access is currently by invitation only.")).toBeTruthy();
    expect(screen.queryByText(/sign up|create (an )?account|register/i)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not leak implementation names into the visible page", () => {
    setup();
    expect(document.body.textContent).not.toMatch(/cognito|\baws\b|\bjwt\b|\btoken\b/i);
  });

  it("shows and hides the password without losing it", async () => {
    const { user } = setup();
    await user.type(field("Password"), "secret-value");

    await user.click(button("Show password"));
    expect(field("Password")).toHaveProperty("type", "text");
    expect(button("Hide password").getAttribute("aria-pressed")).toBe("true");
    expect(field("Password")).toHaveProperty("value", "secret-value");

    await user.click(button("Hide password"));
    expect(field("Password")).toHaveProperty("type", "password");
  });

  it("keeps Sign in disabled until both fields are filled", async () => {
    const { user } = setup();
    expect(button("Sign in")).toHaveProperty("disabled", true);
    await user.type(field("Email"), "ada@example.com");
    expect(button("Sign in")).toHaveProperty("disabled", true);
    await user.type(field("Password"), "x");
    expect(button("Sign in")).toHaveProperty("disabled", false);
  });

  it("shows the notice it was given, e.g. after a session expired", () => {
    setup({}, { notice: "Your session has expired. Please sign in again." });
    expect(screen.getByRole("alert").textContent).toContain("session has expired");
  });

  it("does not move focus on the first screen of a page load", () => {
    setup();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("login", () => {
  it("signs in and hands the user to the app", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [() => authenticated()],
    });

    await signIn(user);

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/auth/login",
      body: { email: "ada@example.com", password: "pw-123456" },
      credentials: "same-origin",
    });
  });

  it("keeps the CSRF token in memory when the backend sends one", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [() => authenticated({ csrf_token: "csrf-xyz" })],
      "POST /api/auth/logout": [noContent],
    });

    await signIn(user);
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    await authApi.logout();

    expect(fake.to("/api/auth/logout")[0]?.headers["X-CSRF-Token"]).toBe("csrf-xyz");
  });

  it("shows rejected credentials, clears the password and keeps the email", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [() => apiError(401, "invalid_credentials", "Incorrect email or password.")],
    });

    await signIn(user);

    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect email or password.");
    expect(field("Password")).toHaveProperty("value", "");
    expect(field("Email")).toHaveProperty("value", "ada@example.com");
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(button("Sign in")).toHaveProperty("disabled", true); // password is empty again
  });

  it("keeps the password after a network failure so the user can retry", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [
        () => {
          throw new TypeError("Failed to fetch");
        },
        () => authenticated(),
      ],
    });

    await signIn(user);
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot reach the server");
    expect(field("Password")).toHaveProperty("value", "pw-123456");

    await user.click(button("Sign in"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
  });

  it("shows a generic message for a server error and keeps the password", async () => {
    const { user } = setup({
      "POST /api/auth/login": [() => apiError(500, "internal_error", "Traceback ...")],
    });

    await signIn(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("We could not sign you in. Please try again.");
    expect(field("Password")).toHaveProperty("value", "pw-123456");
  });

  it("replaces a server message that names implementation details", async () => {
    const { user } = setup({
      "POST /api/auth/login": [
        () => apiError(400, "bad_request", "Cognito rejected the JWT token."),
      ],
    });

    await signIn(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "We could not sign you in. Please try again.",
    );
  });

  it("explains a rate limit using the server's wait time", async () => {
    const { user } = setup({
      "POST /api/auth/login": [
        () => apiError(429, "too_many_attempts", "Slow down.", { "Retry-After": "600" }),
      ],
    });

    await signIn(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Try again in about 10 minutes.",
    );
  });

  it("sends one request while a sign in is pending", async () => {
    let finish: (response: Response) => void = () => {};
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [() => new Promise<Response>((resolve) => (finish = resolve))],
    });
    await user.type(field("Email"), "ada@example.com");
    await user.type(field("Password"), "pw-123456{Enter}");

    await user.click(button("Signing in…"));
    await user.keyboard("{Enter}");

    expect(fake.to("/api/auth/login")).toHaveLength(1);
    expect(button("Signing in…")).toHaveProperty("disabled", true);

    finish(authenticated());
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  });

  it("fails safely when the response does not match the contract", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [() => json(200, { status: "something_new" })],
    });

    await signIn(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "We could not sign you in. Please try again.",
    );
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe("set your password (temporary password)", () => {
  async function reachSetPassword(user: ReturnType<typeof userEvent.setup>) {
    await signIn(user, "Temp-pass-1");
    await screen.findByRole("heading", { name: "Set your password" });
  }
  const routes = () => ({ "POST /api/auth/login": [newPasswordRequired] });

  it("moves focus to the new screen title", async () => {
    const { user } = setup(routes());
    await reachSetPassword(user);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Set your password" }));
  });

  it("explains the password requirements", async () => {
    const { user } = setup(routes());
    await reachSetPassword(user);

    const rules = screen.getByRole("list", { name: "Password requirements" });
    expect(rules.textContent).toContain("At least 8 characters");
    expect(field("New password").getAttribute("aria-describedby")).toBe(rules.id);
  });

  it("does not call the server when the passwords differ or break the rules", async () => {
    const { user } = setup(routes());
    await reachSetPassword(user);

    await user.type(field("New password"), "short");
    await user.type(field("Confirm password"), "different");
    await user.click(button("Set password"));

    expect(screen.getByText("This password does not meet the requirements listed below.")).toBeTruthy();
    expect(screen.getByText("The two passwords do not match.")).toBeTruthy();
    expect(field("New password").getAttribute("aria-invalid")).toBe("true");
    expect(field("Confirm password").getAttribute("aria-invalid")).toBe("true");
    expect(fake.to("/api/auth/new-password")).toHaveLength(0);
  });

  it("sets the password with the challenge id and signs in", async () => {
    const { onAuthenticated, user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [() => authenticated()],
    });
    await reachSetPassword(user);

    await user.type(field("New password"), STRONG);
    await user.type(field("Confirm password"), STRONG);
    await user.click(button("Set password"));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
    expect(fake.to("/api/auth/new-password")[0]?.body).toEqual({
      challenge_id: "chal-new",
      new_password: STRONG,
    });
  });

  it("shows the server's policy message and clears both fields", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [
        () => apiError(400, "password_rejected", "That password is too common."),
      ],
    });
    await reachSetPassword(user);

    await user.type(field("New password"), STRONG);
    await user.type(field("Confirm password"), STRONG);
    await user.click(button("Set password"));

    expect((await screen.findByRole("alert")).textContent).toBe("That password is too common.");
    expect(field("New password")).toHaveProperty("value", "");
    expect(field("Confirm password")).toHaveProperty("value", "");
  });

  it("returns to sign in with a notice when the attempt expired", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [() => apiError(401, "challenge_expired", "Expired.")],
    });
    await reachSetPassword(user);

    await user.type(field("New password"), STRONG);
    await user.type(field("Confirm password"), STRONG);
    await user.click(button("Set password"));

    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("sign-in attempt expired");
    expect(field("Password")).toHaveProperty("value", "");
  });

  it("goes back to sign in without keeping the temporary password", async () => {
    const { user } = setup(routes());
    await reachSetPassword(user);

    await user.click(button("Back to sign in"));

    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(field("Password")).toHaveProperty("value", "");
    expect(field("Email")).toHaveProperty("value", "ada@example.com");
  });
});

describe("verify your email", () => {
  async function reachVerify(user: ReturnType<typeof userEvent.setup>) {
    await signIn(user);
    await screen.findByRole("heading", { name: "Verify your email" });
  }
  const routes = () => ({ "POST /api/auth/login": [verificationRequired] });

  it("sends a code, then offers to resend it", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/send": [noContent, noContent],
    });
    await reachVerify(user);

    await user.click(button("Send code"));
    expect((await screen.findByRole("status")).textContent).toContain("code is on its way");
    expect(fake.to("/api/auth/email-verification/send")[0]?.body).toEqual({
      challenge_id: "chal-verify",
    });

    await user.click(button("Resend code"));
    await waitFor(() => expect(fake.to("/api/auth/email-verification/send")).toHaveLength(2));
  });

  it("verifies the code (spaces removed) and signs in", async () => {
    const { onAuthenticated, user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/confirm": [() => authenticated()],
    });
    await reachVerify(user);

    await user.type(field("Verification code"), "123 456");
    await user.click(button("Verify email"));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
    expect(fake.to("/api/auth/email-verification/confirm")[0]?.body).toEqual({
      challenge_id: "chal-verify",
      code: "123456",
    });
  });

  it("shows a wrong code and stays on the screen", async () => {
    const { onAuthenticated, user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/confirm": [
        () => apiError(400, "invalid_code", "That code is not correct."),
      ],
    });
    await reachVerify(user);

    await user.type(field("Verification code"), "000000");
    await user.click(button("Verify email"));

    expect((await screen.findByRole("alert")).textContent).toBe("That code is not correct.");
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Verify your email" })).toBeTruthy();
  });

  it("disables resending while the server says to wait", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/send": [
        () => apiError(429, "too_many_attempts", "Slow down.", { "Retry-After": "30" }),
      ],
    });
    await reachVerify(user);

    await user.click(button("Send code"));

    expect((await screen.findAllByRole("alert"))[0]?.textContent).toBe(
      "Too many attempts. Try again in 30 seconds.",
    );
    expect(button(/Resend available in \d+s/)).toHaveProperty("disabled", true);
  });

  it("sends one resend request while one is pending", async () => {
    let finish: (response: Response) => void = () => {};
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/send": [
        () => new Promise<Response>((resolve) => (finish = resolve)),
      ],
    });
    await reachVerify(user);

    await user.click(button("Send code"));
    await user.click(button("Sending…"));

    expect(fake.to("/api/auth/email-verification/send")).toHaveLength(1);
    finish(noContent());
    await screen.findByRole("status");
  });

  it("returns to sign in when the attempt expired", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/send": [() => apiError(401, "challenge_expired", "x")],
    });
    await reachVerify(user);

    await user.click(button("Send code"));

    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
  });
});

describe("forgot and reset password", () => {
  async function reachReset(user: ReturnType<typeof userEvent.setup>, address = "ada@example.com") {
    await user.type(field("Email"), address);
    await user.click(button("Forgot password?"));
    await screen.findByRole("heading", { name: "Reset your password" });
    expect(field("Email")).toHaveProperty("value", address);
    await user.click(button("Send code"));
    await screen.findByRole("heading", { name: "Choose a new password" });
  }

  it("requests a code and says the same thing for any address", async () => {
    const texts: string[] = [];
    for (const address of ["known@example.com", "nobody@example.com"]) {
      const { user } = setup({ "POST /api/auth/forgot-password": [noContent] });
      await reachReset(user, address);
      texts.push(screen.getByRole("status").textContent ?? "");
      expect(fake.to("/api/auth/forgot-password")[0]?.body).toEqual({ email: address });
      expect(fake.unexpected).toEqual([]);
      cleanup();
      vi.unstubAllGlobals();
    }

    expect(texts[0]).toBe("If an account exists for known@example.com, we've sent it a verification code.");
    expect(texts[1]?.replace("nobody@", "known@")).toBe(texts[0]);
  });

  it("resets the password with email, code and new password, then asks to sign in", async () => {
    const { user } = setup({
      "POST /api/auth/forgot-password": [noContent],
      "POST /api/auth/reset-password": [noContent],
    });
    await reachReset(user);

    await user.type(field("Verification code"), "654321");
    await user.type(field("New password"), STRONG);
    await user.type(field("Confirm password"), STRONG);
    await user.click(button("Reset password"));

    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("password has been changed");
    expect(fake.to("/api/auth/reset-password")[0]?.body).toEqual({
      email: "ada@example.com",
      code: "654321",
      new_password: STRONG,
    });
    expect(field("Password")).toHaveProperty("value", "");
  });

  it("checks the new password before sending", async () => {
    const { user } = setup({ "POST /api/auth/forgot-password": [noContent] });
    await reachReset(user);

    await user.type(field("Verification code"), "654321");
    await user.type(field("New password"), "weak");
    await user.type(field("Confirm password"), "weak");
    await user.click(button("Reset password"));

    expect(screen.getByText("This password does not meet the requirements listed below.")).toBeTruthy();
    expect(fake.to("/api/auth/reset-password")).toHaveLength(0);
  });

  it("shows a wrong or expired code and clears the typed passwords", async () => {
    const { user } = setup({
      "POST /api/auth/forgot-password": [noContent],
      "POST /api/auth/reset-password": [
        () => apiError(400, "invalid_code", "That code is not correct or has expired."),
      ],
    });
    await reachReset(user);

    await user.type(field("Verification code"), "111111");
    await user.type(field("New password"), STRONG);
    await user.type(field("Confirm password"), STRONG);
    await user.click(button("Reset password"));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "That code is not correct or has expired.",
    );
    expect(field("New password")).toHaveProperty("value", "");
    expect(field("Confirm password")).toHaveProperty("value", "");
  });

  it("reports a rate limit when requesting the code and stays on the form", async () => {
    const { user } = setup({
      "POST /api/auth/forgot-password": [
        () => apiError(429, "too_many_attempts", "Slow down.", { "Retry-After": "120" }),
      ],
    });
    await user.type(field("Email"), "ada@example.com");
    await user.click(button("Forgot password?"));
    await user.click(await screen.findByRole("button", { name: "Send code" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Try again in about 2 minutes.",
    );
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
  });

  it("lets the user start again or go back", async () => {
    const { user } = setup({ "POST /api/auth/forgot-password": [noContent] });
    await reachReset(user);

    await user.click(button("Didn't get a code? Start again"));
    expect(await screen.findByRole("heading", { name: "Reset your password" })).toBeTruthy();

    await user.click(button("Back to sign in"));
    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
  });
});

describe("secrets", () => {
  it("never writes passwords, codes or challenge ids to browser storage or the console", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [newPasswordRequired],
      "POST /api/auth/new-password": [verificationRequired],
      "POST /api/auth/email-verification/confirm": [() => authenticated()],
    });

    await signIn(user, "Temp-pass-1");
    await screen.findByRole("heading", { name: "Set your password" });
    await user.type(field("New password"), STRONG);
    await user.type(field("Confirm password"), STRONG);
    await user.click(button("Set password"));
    await screen.findByRole("heading", { name: "Verify your email" });
    await user.type(field("Verification code"), "123456");
    await user.click(button("Verify email"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(location.href).not.toMatch(/chal-|pw-|Temp-pass|123456/);
  });
});
