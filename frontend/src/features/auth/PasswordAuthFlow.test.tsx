import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authApi } from "../../api/authApi";
import { setCsrfToken } from "../../api/client";
import {
  USER,
  accepted,
  apiError,
  authenticated,
  codeSent,
  installAuthFetch,
  json,
  newPasswordRequired,
  noContent,
  passwordReset,
  verificationRequired,
} from "../../test/authFetch.testkit";
import { PASSWORD_CHANGED_TEXT, RESET_UNKNOWN_TEXT } from "./errors";
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
  const view = render(<PasswordAuthFlow onAuthenticated={onAuthenticated} {...props} />);
  return { onAuthenticated, unmount: view.unmount, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const field = (name: string) => screen.getByLabelText(name, { selector: "input" });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const heading = (name: string) => screen.findByRole("heading", { name });
const alertText = async () => (await screen.findByRole("alert")).textContent;

async function signIn(user: User, password = "pw-123456") {
  await user.type(field("Email"), "ada@example.com");
  await user.type(field("Password"), password);
  await user.click(button("Sign in"));
}

async function typeNewPassword(user: User, password = STRONG, confirm = STRONG) {
  await user.type(field("New password"), password);
  await user.type(field("Confirm password"), confirm);
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

  it("hides Forgot password when the backend does not offer it", () => {
    setup({}, { passwordReset: false });
    expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
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
  it("signs in, keeps the CSRF token in memory and hands the user to the app", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [authenticated(USER, "csrf-xyz")],
      "POST /api/auth/logout": [noContent],
    });

    await signIn(user);

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/auth/login",
      body: { email: "ada@example.com", password: "pw-123456" },
      credentials: "same-origin",
    });
    await authApi.logout();
    expect(fake.to("/api/auth/logout")[0]?.headers["X-CSRF-Token"]).toBe("csrf-xyz");
  });

  it("accepts an account without a display name", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [authenticated({ ...USER, display_name: null })],
    });
    await signIn(user);
    await waitFor(() =>
      expect(onAuthenticated).toHaveBeenCalledWith({ ...USER, display_name: null }),
    );
  });

  it("shows rejected credentials, clears the password and keeps the email", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [
        () => apiError(401, "invalid_credentials", "Incorrect email or password."),
      ],
    });

    await signIn(user);

    expect(await alertText()).toBe("Incorrect email or password.");
    expect(field("Password")).toHaveProperty("value", "");
    expect(field("Email")).toHaveProperty("value", "ada@example.com");
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("explains a disabled account and a password change during sign in", async () => {
    const { user } = setup({
      "POST /api/auth/login": [
        () => apiError(403, "account_disabled", "This account is disabled."),
        () => apiError(409, "password_changed", "Whatever the server wording is."),
      ],
    });

    await signIn(user);
    expect(await alertText()).toBe("This account is disabled.");

    await user.type(field("Password"), "pw-123456");
    await user.click(button("Sign in"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(PASSWORD_CHANGED_TEXT));
  });

  it("keeps the password after a network failure so the user can retry", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [
        () => {
          throw new TypeError("Failed to fetch");
        },
        authenticated(),
      ],
    });

    await signIn(user);
    expect(await alertText()).toContain("Cannot reach the server");
    expect(field("Password")).toHaveProperty("value", "pw-123456");

    await user.click(button("Sign in"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
  });

  it("shows a generic message for a server error and keeps the password", async () => {
    const { user } = setup({
      "POST /api/auth/login": [() => apiError(500, "internal_error", "Traceback ...")],
    });

    await signIn(user);

    expect(await alertText()).toBe("We could not sign you in. Please try again.");
    expect(field("Password")).toHaveProperty("value", "pw-123456");
  });

  it("shows the service-unavailable message and does not retry by itself", async () => {
    const { user } = setup({
      "POST /api/auth/login": [
        () => apiError(503, "auth_unavailable", "The sign-in service is not available right now."),
      ],
    });

    await signIn(user);

    expect(await alertText()).toBe("The sign-in service is not available right now.");
    expect(field("Password")).toHaveProperty("value", "pw-123456");
    expect(fake.to("/api/auth/login")).toHaveLength(1);
  });

  it("replaces a server message that names implementation details", async () => {
    const { user } = setup({
      "POST /api/auth/login": [
        () => apiError(400, "bad_request", "Cognito rejected the JWT token."),
      ],
    });

    await signIn(user);

    expect(await alertText()).toBe("We could not sign you in. Please try again.");
  });

  it("explains rate limits using the server's wait time, or its own message", async () => {
    const { user } = setup({
      "POST /api/auth/login": [
        () => apiError(429, "too_many_attempts", "Slow down.", { "Retry-After": "600" }),
        () => apiError(429, "auth_rate_limited", "The sign-in service is receiving too many requests. Please try again later."),
      ],
    });

    await signIn(user);
    expect(await alertText()).toBe("Too many attempts. Try again in about 10 minutes.");

    await user.click(button("Sign in"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("receiving too many requests"),
    );
  });

  it("shows a field message for a validation error and keeps the input", async () => {
    const { user } = setup({
      "POST /api/auth/login": [
        () =>
          json(422, {
            error: {
              code: "validation_error",
              message: "Invalid request.",
              fields: [{ field: "email", message: "Enter a valid email address." }],
            },
          }),
      ],
    });

    await signIn(user);

    expect(await alertText()).toBe("Enter a valid email address.");
    expect(field("Password")).toHaveProperty("value", "pw-123456");
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

    finish(authenticated()());
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  });

  it("does not sign in on an answer that does not match the contract", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/login": [
        () => json(200, { status: "authenticated", user: USER }), // no csrf_token
        () => json(202, { status: "authenticated" }), // wrong status
      ],
    });

    await signIn(user);
    expect(await alertText()).toBe("We could not sign you in. Please try again.");

    await user.click(button("Sign in"));
    await waitFor(() => expect(fake.to("/api/auth/login")).toHaveLength(2));
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe("set your password (temporary password)", () => {
  async function reachSetPassword(user: User) {
    await signIn(user, "Temp-pass-1");
    await heading("Set your password");
  }
  const routes = () => ({ "POST /api/auth/login": [newPasswordRequired] });

  it("moves focus to the new screen title and invents no password rules", async () => {
    const { user } = setup(routes());
    await reachSetPassword(user);

    expect(document.activeElement).toBe(await heading("Set your password"));
    expect(screen.queryByRole("list", { name: /password requirements/i })).toBeNull();
  });

  it("does not call the server when the two passwords differ", async () => {
    const { user } = setup(routes());
    await reachSetPassword(user);

    await typeNewPassword(user, "short", "different");
    await user.click(button("Set password"));

    expect(screen.getByText("The two passwords do not match.")).toBeTruthy();
    expect(field("Confirm password").getAttribute("aria-invalid")).toBe("true");
    expect(fake.to("/api/auth/new-password")).toHaveLength(0);
  });

  it("does not block a password on rules of its own: the server decides", async () => {
    const { onAuthenticated, user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [authenticated()],
    });
    await reachSetPassword(user);

    await typeNewPassword(user, "a", "a");
    await user.click(button("Set password"));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(fake.to("/api/auth/new-password")[0]?.body).toEqual({
      challenge_id: "chal-new",
      new_password: "a",
    });
  });

  it("goes on to email verification when the server asks for it", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [verificationRequired],
    });
    await reachSetPassword(user);

    await typeNewPassword(user);
    await user.click(button("Set password"));

    expect(await heading("Verify your email")).toBeTruthy();
  });

  it("shows the server's rejection of the password and clears both fields", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [
        () => apiError(422, "password_rejected", "The new password does not meet the password requirements."),
      ],
    });
    await reachSetPassword(user);

    await typeNewPassword(user);
    await user.click(button("Set password"));

    expect(await alertText()).toBe("The new password does not meet the password requirements.");
    expect(field("New password")).toHaveProperty("value", "");
    expect(field("Confirm password")).toHaveProperty("value", "");
    expect(screen.getByRole("heading", { name: "Set your password" })).toBeTruthy();
  });

  it.each([
    ["challenge_invalid", 400, /expired or was already completed.*may already be saved/s],
    ["challenge_busy", 409, /already being processed.*use it/s],
    ["password_changed", 409, new RegExp(PASSWORD_CHANGED_TEXT)],
    ["account_disabled", 403, /account is disabled/],
    ["account_setup_incomplete", 409, /not ready yet/],
  ])("returns to sign in with a notice on %s", async (code, status, text) => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [() => apiError(status, code, "Server wording.")],
    });
    await reachSetPassword(user);

    await typeNewPassword(user);
    await user.click(button("Set password"));

    expect(await heading("Sign in to MyDubb")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(text);
    expect(field("Password")).toHaveProperty("value", "");
    expect(fake.to("/api/auth/new-password")).toHaveLength(1); // no automatic retry
  });

  it("treats an error code that merely contains 'challenge' as an ordinary failure", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/new-password": [
        () => apiError(400, "challenge_surprise", "Something specific happened."),
      ],
    });
    await reachSetPassword(user);

    await typeNewPassword(user);
    await user.click(button("Set password"));

    expect(await alertText()).toBe("Something specific happened.");
    expect(screen.getByRole("heading", { name: "Set your password" })).toBeTruthy();
  });

  it("goes back to sign in without keeping the temporary password", async () => {
    const { user } = setup(routes());
    await reachSetPassword(user);

    await user.click(button("Back to sign in"));

    expect(await heading("Sign in to MyDubb")).toBeTruthy();
    expect(field("Password")).toHaveProperty("value", "");
    expect(field("Email")).toHaveProperty("value", "ada@example.com");
  });
});

describe("verify your email", () => {
  async function reachVerify(user: User) {
    await signIn(user);
    await heading("Verify your email");
  }
  const routes = () => ({ "POST /api/auth/login": [verificationRequired] });

  it("does not send a code by itself", async () => {
    const { user } = setup(routes());
    await reachVerify(user);
    // Let any effect-driven request run before looking.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fake.to("/api/auth/email-verification/send")).toHaveLength(0);
    expect(button("Send code")).toBeTruthy();
  });

  it("sends a code on request, then offers to resend it", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/send": [codeSent, codeSent],
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
      "POST /api/auth/email-verification/confirm": [authenticated()],
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

  it("checks the code format before sending", async () => {
    const { user } = setup(routes());
    await reachVerify(user);

    await user.type(field("Verification code"), "12ab");
    await user.click(button("Verify email"));

    expect(screen.getByText("Enter the numeric code from the email (digits only).")).toBeTruthy();
    expect(fake.to("/api/auth/email-verification/confirm")).toHaveLength(0);
  });

  it("stays on the screen after a wrong or expired code and allows another try", async () => {
    const { onAuthenticated, user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/confirm": [
        () => apiError(400, "code_invalid", "The code is incorrect or has expired."),
        authenticated(),
      ],
    });
    await reachVerify(user);

    await user.type(field("Verification code"), "000000");
    await user.click(button("Verify email"));

    expect(await alertText()).toBe("The code is incorrect or has expired.");
    expect(screen.getByRole("heading", { name: "Verify your email" })).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();

    await user.type(field("Verification code"), "111111");
    await user.click(button("Verify email"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
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

    expect(await alertText()).toBe("Too many attempts. Try again in 30 seconds.");
    expect(button(/Resend available in \d+s/)).toHaveProperty("disabled", true);
  });

  it("shows the server's message when no more codes can be sent", async () => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/send": [
        () => apiError(429, "too_many_attempts", "Too many codes were requested. Please sign in again later."),
      ],
    });
    await reachVerify(user);

    await user.click(button("Send code"));

    expect(await alertText()).toBe("Too many codes were requested. Please sign in again later.");
  });

  it("never runs Verify and Resend at the same time", async () => {
    let finish: (response: Response) => void = () => {};
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/confirm": [
        () => new Promise<Response>((resolve) => (finish = resolve)),
      ],
    });
    await reachVerify(user);

    await user.type(field("Verification code"), "123456{Enter}");
    await screen.findByRole("button", { name: "Verifying…" });
    // Resend is disabled while a verification is pending, and Enter does not start another one.
    expect(button("Send code")).toHaveProperty("disabled", true);
    await user.click(button("Send code"));
    await user.keyboard("{Enter}");

    expect(fake.to("/api/auth/email-verification/send")).toHaveLength(0);
    expect(fake.to("/api/auth/email-verification/confirm")).toHaveLength(1);
    finish(authenticated()());
  });

  it("ignores an old answer after the flow was closed", async () => {
    let finish: (response: Response) => void = () => {};
    const { onAuthenticated, unmount, user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/confirm": [
        () => new Promise<Response>((resolve) => (finish = resolve)),
      ],
    });
    await reachVerify(user);
    await user.type(field("Verification code"), "123456");
    await user.click(button("Verify email"));
    await screen.findByRole("button", { name: "Verifying…" });

    unmount();
    finish(authenticated(USER, "csrf-stale")());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onAuthenticated).not.toHaveBeenCalled();
    // The stale answer must not have left a CSRF token behind either.
    fake = installAuthFetch({ "POST /api/auth/logout": [noContent] });
    await authApi.logout();
    expect(fake.to("/api/auth/logout")[0]?.headers["X-CSRF-Token"]).toBeUndefined();
  });

  it.each([
    ["challenge_invalid", 400],
    ["challenge_busy", 409],
  ])("returns to sign in when sending a code answers %s", async (code, status) => {
    const { user } = setup({
      ...routes(),
      "POST /api/auth/email-verification/send": [() => apiError(status, code, "x")],
    });
    await reachVerify(user);

    await user.click(button("Send code"));

    expect(await heading("Sign in to MyDubb")).toBeTruthy();
    expect(fake.to("/api/auth/email-verification/send")).toHaveLength(1);
  });
});

describe("forgot and reset password", () => {
  async function requestCode(user: User, address = "ada@example.com") {
    await user.type(field("Email"), address);
    await user.click(button("Forgot password?"));
    await heading("Reset your password");
    expect(field("Email")).toHaveProperty("value", address);
    await user.click(button("Send code"));
    await heading("Choose a new password");
  }
  async function fillReset(user: User, code = "654321") {
    await user.type(field("Verification code"), code);
    await typeNewPassword(user);
    await user.click(button("Reset password"));
  }

  it("requests a code and says the same thing for any address", async () => {
    const texts: string[] = [];
    for (const address of ["known@example.com", "nobody@example.com"]) {
      const { user } = setup({ "POST /api/auth/forgot-password": [accepted] });
      await requestCode(user, address);
      texts.push(screen.getByRole("status").textContent ?? "");
      expect(fake.to("/api/auth/forgot-password")[0]?.body).toEqual({ email: address });
      expect(fake.unexpected).toEqual([]);
      cleanup();
      vi.unstubAllGlobals();
    }

    expect(texts[0]).toBe(
      "If an account exists for known@example.com, we've sent it a verification code.",
    );
    expect(texts[1]?.replace("nobody@", "known@")).toBe(texts[0]);
  });

  it("resets the password with email, code and new password, then asks to sign in", async () => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/forgot-password": [accepted],
      "POST /api/auth/reset-password": [passwordReset],
    });
    await requestCode(user);

    await fillReset(user);

    expect(await heading("Sign in to MyDubb")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("password has been changed");
    expect(fake.to("/api/auth/reset-password")[0]?.body).toEqual({
      email: "ada@example.com",
      code: "654321",
      new_password: STRONG,
    });
    expect(field("Password")).toHaveProperty("value", "");
    expect(onAuthenticated).not.toHaveBeenCalled(); // a reset never signs anyone in
  });

  it("checks the code format and the confirmation before sending", async () => {
    const { user } = setup({ "POST /api/auth/forgot-password": [accepted] });
    await requestCode(user);

    await user.type(field("Verification code"), "12-34");
    await typeNewPassword(user, "one", "two");
    await user.click(button("Reset password"));

    expect(screen.getByText("Enter the numeric code from the email (digits only).")).toBeTruthy();
    expect(screen.getByText("The two passwords do not match.")).toBeTruthy();
    expect(fake.to("/api/auth/reset-password")).toHaveLength(0);
  });

  it("shows a wrong or expired code and clears only the typed passwords", async () => {
    const { user } = setup({
      "POST /api/auth/forgot-password": [accepted],
      "POST /api/auth/reset-password": [
        () => apiError(400, "code_invalid", "The code is incorrect or has expired."),
      ],
    });
    await requestCode(user);

    await fillReset(user, "111111");

    expect(await alertText()).toBe("The code is incorrect or has expired.");
    expect(field("Verification code")).toHaveProperty("value", "111111");
    expect(field("New password")).toHaveProperty("value", "");
    expect(field("Confirm password")).toHaveProperty("value", "");
  });

  it("shows the server's password rejection", async () => {
    const { user } = setup({
      "POST /api/auth/forgot-password": [accepted],
      "POST /api/auth/reset-password": [
        () => apiError(422, "password_rejected", "The new password does not meet the password requirements."),
      ],
    });
    await requestCode(user);

    await fillReset(user);

    expect(await alertText()).toBe("The new password does not meet the password requirements.");
  });

  it("shows a 503 message exactly as text, without retrying or claiming nothing changed", async () => {
    const serverText =
      "We could not confirm the change <b>and</b> you are signed out everywhere. Sign in again in about a minute.";
    const { user } = setup({
      "POST /api/auth/forgot-password": [accepted],
      "POST /api/auth/reset-password": [() => apiError(503, "auth_unavailable", serverText)],
    });
    await requestCode(user);

    await fillReset(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(serverText);
    expect(alert.querySelector("b")).toBeNull(); // plain text, never HTML
    expect(alert.textContent).not.toMatch(/unchanged|not changed|nothing changed/i);
    expect(field("New password")).toHaveProperty("value", "");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.to("/api/auth/reset-password")).toHaveLength(1);
    expect(button("Back to sign in")).toBeTruthy();
  });

  it.each([
    ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
    ["a 500 without a known code", () => apiError(500, "internal_error", "boom")],
    ["a 200 with the wrong body", () => json(200, { status: "ok" })],
    ["a 204", () => noContent()],
  ])("says the outcome is unknown after %s", async (_name, response) => {
    const { onAuthenticated, user } = setup({
      "POST /api/auth/forgot-password": [accepted],
      "POST /api/auth/reset-password": [response],
    });
    await requestCode(user);

    await fillReset(user);

    expect(await alertText()).toBe(RESET_UNKNOWN_TEXT);
    expect(fake.to("/api/auth/reset-password")).toHaveLength(1);
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeTruthy();
  });

  it("explains that a password change happened meanwhile", async () => {
    const { user } = setup({
      "POST /api/auth/forgot-password": [accepted],
      "POST /api/auth/reset-password": [() => apiError(409, "password_changed", "x")],
    });
    await requestCode(user);

    await fillReset(user);

    expect(await alertText()).toBe(PASSWORD_CHANGED_TEXT);
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

    expect(await alertText()).toBe("Too many attempts. Try again in about 2 minutes.");
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
  });

  it("lets the user start again or go back", async () => {
    const { user } = setup({ "POST /api/auth/forgot-password": [accepted] });
    await requestCode(user);

    await user.click(button("Didn't get a code? Start again"));
    expect(await heading("Reset your password")).toBeTruthy();

    await user.click(button("Back to sign in"));
    expect(await heading("Sign in to MyDubb")).toBeTruthy();
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
      "POST /api/auth/email-verification/confirm": [authenticated()],
    });

    await signIn(user, "Temp-pass-1");
    await heading("Set your password");
    await typeNewPassword(user);
    await user.click(button("Set password"));
    await heading("Verify your email");
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
