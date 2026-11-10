import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "../../api/client";
import { signupOf, type SignupOffer } from "../../lib/authMode";
import { loadRecaptcha, type RecaptchaApi } from "../../lib/recaptcha";
import {
  META,
  USER,
  accepted,
  apiError,
  authenticated,
  installAuthFetch,
  json,
} from "../../test/authFetch.testkit";
import { PasswordAuthFlow } from "./PasswordAuthFlow";

// Google's script is never loaded in tests: the widget is a button that hands out tokens.
vi.mock("../../lib/recaptcha", () => ({ loadRecaptcha: vi.fn() }));

const SIGNUP_META = {
  ...META,
  auth: { mode: "cognito", self_registration: true, password_reset: true },
  signup: {
    enabled: true,
    recaptcha_site_key: "site-key-1",
    free_plan: {
      generates_per_day: 20,
      youtube_imports_per_day: 5,
      max_words: 1000,
      max_output_seconds: 600,
    },
  },
};
const OFFER = signupOf(SIGNUP_META) as SignupOffer;
const EMAIL = "new@example.com";
const PASSWORD = "Str0ng-password";

type Params = Parameters<RecaptchaApi["render"]>[1];
let widgets: Params[];
let reset: ReturnType<typeof vi.fn<(widgetId?: number) => void>>;
let fake: ReturnType<typeof installAuthFetch>;

beforeEach(() => {
  widgets = [];
  reset = vi.fn<(widgetId?: number) => void>();
  let n = 0;
  vi.mocked(loadRecaptcha).mockResolvedValue({
    render: (target, params) => {
      widgets.push(params);
      const tick = document.createElement("button");
      tick.type = "button";
      tick.textContent = "Fake robot check";
      tick.addEventListener("click", () => params.callback?.(`token-${(n += 1)}`));
      target.appendChild(tick);
      return widgets.length - 1;
    },
    reset,
  });
});

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  expect(fake?.unexpected ?? []).toEqual([]);
});

function setup(routes: Parameters<typeof installAuthFetch>[0] = {}, signup: SignupOffer | null = OFFER) {
  fake = installAuthFetch(routes);
  const onAuthenticated = vi.fn();
  render(<PasswordAuthFlow onAuthenticated={onAuthenticated} signup={signup} />);
  return { onAuthenticated, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;
const field = (name: string) => screen.getByLabelText(name, { selector: "input" }) as HTMLInputElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const heading = (name: string) => screen.findByRole("heading", { name });
const describedBy = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

/** A response the test releases when it wants (a slow or late answer). */
function deferred() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { handler: () => promise, release };
}

async function openCreate(user: User, email = "") {
  if (email) await user.type(field("Email"), email);
  await user.click(button("Create account"));
  await heading("Create your account");
  await screen.findByRole("button", { name: "Fake robot check" });
}

async function fillCreate(user: User, { email = EMAIL, tick = true } = {}) {
  if (field("Email").value === "") await user.type(field("Email"), email);
  await user.type(field("Password"), PASSWORD);
  if (tick) await user.click(button("Fake robot check"));
}

const verified = () => json(200, { status: "verified" });
const verificationRequired = () => json(200, { status: "verification_required" });

describe("sign in screen", () => {
  it("stays invitation-only when the backend offers no sign-up", () => {
    setup({}, null);
    expect(screen.getByText("Access is currently by invitation only.")).toBeTruthy();
    expect(screen.queryByText(/create (an )?account|sign up|register/i)).toBeNull();
    expect(loadRecaptcha).not.toHaveBeenCalled();
  });

  it("offers Create account with the Free plan the server reports, without loading Google", () => {
    setup();
    expect(button("Create account")).toBeTruthy();
    expect(button("Have a code? Verify your email")).toBeTruthy();
    expect(screen.queryByText("Access is currently by invitation only.")).toBeNull();
    expect(
      screen.getByText(
        "New accounts get the Free plan: 20 Generates and 5 YouTube imports a day (counts start " +
          "again at 00:00 UTC), up to 1,000 words and 10 minutes of audio per job.",
      ),
    ).toBeTruthy();
    // The reCAPTCHA script is only for people who choose Create account.
    expect(loadRecaptcha).not.toHaveBeenCalled();
  });

  it("is not offered when the meta is incomplete", () => {
    expect(signupOf({ ...SIGNUP_META, signup: { ...SIGNUP_META.signup, recaptcha_site_key: "" } })).toBeNull();
    expect(signupOf({ ...SIGNUP_META, auth: { ...SIGNUP_META.auth, self_registration: false } })).toBeNull();
    expect(signupOf({ ...SIGNUP_META, auth: { ...SIGNUP_META.auth, mode: "access_code" } })).toBeNull();
    expect(signupOf({ ...SIGNUP_META, signup: { enabled: true, recaptcha_site_key: "k" } })).toBeNull();
    expect(signupOf(null)).toBeNull();
  });
});

describe("create account -> verify -> sign in", () => {
  it("runs the whole flow and opens a session only through sign-in", async () => {
    const { user, onAuthenticated } = setup({
      "POST /api/auth/signup": [verificationRequired],
      "POST /api/auth/signup/confirm": [verified],
      "POST /api/auth/login": [authenticated(USER)],
    });
    await openCreate(user, EMAIL);
    expect(field("Email").value).toBe(EMAIL); // carried over from Sign in
    expect(widgets[0]).toMatchObject({ sitekey: "site-key-1", theme: "light" });
    await fillCreate(user);
    await user.click(button("Create account"));

    await heading("Verify your email");
    expect(fake.to("/api/auth/signup")[0]?.body).toEqual({
      email: EMAIL,
      password: PASSWORD,
      captcha_token: "token-1",
    });
    expect(screen.getByText(EMAIL)).toBeTruthy();
    expect(onAuthenticated).not.toHaveBeenCalled();

    await user.type(field("Verification code"), "123 456");
    await user.click(button("Verify"));
    await heading("Sign in to MyDubb");
    expect(fake.to("/api/auth/signup/confirm")[0]?.body).toEqual({ email: EMAIL, code: "123456" });
    expect(screen.getByRole("status").textContent).toMatch(/Your email is verified/);
    expect(field("Email").value).toBe(EMAIL);
    expect(onAuthenticated).not.toHaveBeenCalled();

    await user.type(field("Password"), PASSWORD);
    await user.click(button("Sign in"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(USER));
  });

  it("sends one request for a double click", async () => {
    const slow = deferred();
    const { user } = setup({ "POST /api/auth/signup": [slow.handler] });
    await openCreate(user);
    await fillCreate(user);
    await user.dblClick(button("Create account"));
    await user.click(button("Creating account…"));
    expect(fake.to("/api/auth/signup")).toHaveLength(1);
    await act(async () => slow.release(verificationRequired()));
    await heading("Verify your email");
  });
});

describe("create account errors", () => {
  it("shows a message beside each empty field and the robot check, and sends nothing", async () => {
    const { user } = setup();
    await openCreate(user);
    await user.click(button("Create account"));
    expect(describedBy(field("Email"))).toBe("Enter your email address.");
    expect(describedBy(field("Password"))).toBe("Enter a password.");
    expect(screen.getByRole("group", { name: "Robot check" }).textContent).toMatch(
      /Tick the box to show you are not a robot/,
    );
    expect(document.activeElement).toBe(field("Email"));
    expect(fake.to("/api/auth/signup")).toHaveLength(0);
  });

  it("puts a refused robot check beside the box, resets it and keeps the password", async () => {
    const { user } = setup({
      "POST /api/auth/signup": [
        () => apiError(400, "captcha_invalid", "The robot check expired or did not pass."),
        verificationRequired,
      ],
    });
    await openCreate(user);
    await fillCreate(user);
    await user.click(button("Create account"));
    const group = screen.getByRole("group", { name: "Robot check" });
    await waitFor(() => expect(group.textContent).toMatch(/expired or did not pass/));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(field("Password").value).toBe(PASSWORD);
    // A new token is needed: without ticking again nothing is sent.
    await user.click(button("Create account"));
    expect(fake.to("/api/auth/signup")).toHaveLength(1);
    await user.click(button("Fake robot check"));
    await user.click(button("Create account"));
    await heading("Verify your email");
    expect(fake.to("/api/auth/signup")[1]?.body?.captcha_token).toBe("token-2");
  });

  it("puts a rejected password beside the password and clears it", async () => {
    const { user } = setup({
      "POST /api/auth/signup": [
        () =>
          apiError(422, "password_rejected", "The new password does not meet the password requirements."),
      ],
    });
    await openCreate(user);
    await fillCreate(user);
    await user.click(button("Create account"));
    await waitFor(() => expect(describedBy(field("Password"))).toMatch(/password requirements/));
    expect(field("Password").value).toBe("");
    expect(document.activeElement).toBe(field("Password"));
  });

  it.each([
    [503, "captcha_unavailable", "We cannot run the robot check right now"],
    [503, "signup_unavailable", "Creating an account is not available right now"],
    [429, "too_many_attempts", "Too many attempts"],
  ])("shows %s %s under the form and keeps the input", async (status, code, message) => {
    const { user } = setup({ "POST /api/auth/signup": [() => apiError(status, code, message)] });
    await openCreate(user);
    await fillCreate(user);
    await user.click(button("Create account"));
    expect((await screen.findByRole("alert")).textContent).toMatch(new RegExp(message.slice(0, 20)));
    expect(field("Email").value).toBe(EMAIL);
  });

  it("offers the Verify screen when the answer was lost", async () => {
    const { user } = setup({
      "POST /api/auth/signup": [
        () => apiError(503, "signup_outcome_unknown", "We could not confirm whether your account was created."),
      ],
    });
    await openCreate(user);
    await fillCreate(user);
    await user.click(button("Create account"));
    await user.click(await screen.findByRole("button", { name: "I received a code" }));
    await heading("Verify your email");
    expect(screen.getByText(EMAIL)).toBeTruthy();
    expect(fake.to("/api/auth/signup")).toHaveLength(1); // never retried
  });

  it("follows the light/dark theme of the page", async () => {
    document.documentElement.dataset.theme = "dark";
    const { user } = setup();
    await openCreate(user);
    expect(widgets[0]?.theme).toBe("dark");
    act(() => {
      document.documentElement.dataset.theme = "light";
    });
    await waitFor(() => expect(widgets.at(-1)?.theme).toBe("light"));
  });

  it("says so when Google's script cannot load, and can try again", async () => {
    const api = await vi.mocked(loadRecaptcha)();
    vi.mocked(loadRecaptcha).mockRejectedValueOnce(new Error("blocked"));
    const { user } = setup();
    await user.click(button("Create account"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/robot check could not load/);
    vi.mocked(loadRecaptcha).mockResolvedValue(api);
    await user.click(button("Try again"));
    await screen.findByRole("button", { name: "Fake robot check" });
  });
});

describe("verify email", () => {
  async function toVerify(routes: Parameters<typeof installAuthFetch>[0]) {
    const flow = setup({ "POST /api/auth/signup": [verificationRequired], ...routes });
    await openCreate(flow.user);
    await fillCreate(flow.user);
    await flow.user.click(button("Create account"));
    await heading("Verify your email");
    return flow;
  }

  it.each([
    ["code_invalid", "That code is not right."],
    ["code_expired", "This code has expired."],
  ])("shows %s beside the code box", async (code, message) => {
    const { user } = await toVerify({
      "POST /api/auth/signup/confirm": [() => apiError(400, code, message)],
    });
    await user.type(field("Verification code"), "111111");
    await user.click(button("Verify"));
    await waitFor(() => expect(describedBy(field("Verification code"))).toBe(message));
    expect(document.activeElement).toBe(field("Verification code"));
  });

  it("checks the code shape before asking", async () => {
    const { user } = await toVerify({});
    await user.type(field("Verification code"), "abc");
    await user.click(button("Verify"));
    expect(describedBy(field("Verification code"))).toMatch(/digits only/);
    expect(fake.to("/api/auth/signup/confirm")).toHaveLength(0);
  });

  it("resends without saying whether the address has an account, and waits as the server asks", async () => {
    const { user } = await toVerify({
      "POST /api/auth/signup/resend": [
        accepted,
        () => apiError(429, "too_many_attempts", "Too many requests.", { "Retry-After": "30" }),
      ],
    });
    await user.click(button("Resend code"));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /If this address is waiting for verification, a new code is on its way/,
    );
    expect(document.activeElement).toBe(field("Verification code"));
    expect(fake.to("/api/auth/signup/resend")[0]?.body).toEqual({ email: EMAIL });
    await user.click(button("Resend code"));
    expect(await screen.findByRole("button", { name: "Resend available in 30s" })).toBeTruthy();
  });

  it("names signing in as the way on when the verification answer was lost", async () => {
    const { user } = await toVerify({
      "POST /api/auth/signup/confirm": [
        () =>
          apiError(503, "verification_outcome_unknown", "We could not confirm whether your email was verified. Try signing in."),
      ],
    });
    await user.type(field("Verification code"), "123456");
    await user.click(button("Verify"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Try signing in/);
    await user.click(button("Back to sign in"));
    await heading("Sign in to MyDubb");
  });

  it("asks for the email when opened from Sign in without one", async () => {
    const { user } = setup({ "POST /api/auth/signup/confirm": [verified] });
    await user.click(button("Have a code? Verify your email"));
    await heading("Verify your email");
    await user.type(field("Verification code"), "123456");
    await user.click(button("Verify"));
    expect(describedBy(field("Email"))).toMatch(/Enter the email address you used/);
    await user.type(field("Email"), EMAIL);
    await user.click(button("Verify"));
    await heading("Sign in to MyDubb");
    expect(fake.to("/api/auth/signup/confirm")[0]?.body).toEqual({ email: EMAIL, code: "123456" });
  });
});

describe("late answers after going back or changing the email", () => {
  it("a Create account answer after Back to sign in changes nothing", async () => {
    const slow = deferred();
    const { user } = setup({ "POST /api/auth/signup": [slow.handler] });
    await openCreate(user);
    await fillCreate(user, { email: "late@example.com" });
    await user.click(button("Create account"));
    await user.click(button("Back to sign in")); // usable while the request waits
    await heading("Sign in to MyDubb");

    await act(async () => slow.release(verificationRequired()));
    expect(screen.getByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Verify your email" })).toBeNull();
    expect(field("Email").value).toBe("");

    // A new attempt with another address starts from that address.
    await openCreate(user, "second@example.com");
    expect(field("Email").value).toBe("second@example.com");
  });

  it("a Verify answer after Use a different email changes nothing", async () => {
    const slow = deferred();
    const { user } = setup({
      "POST /api/auth/signup": [verificationRequired],
      "POST /api/auth/signup/confirm": [slow.handler],
    });
    await openCreate(user);
    await fillCreate(user);
    await user.click(button("Create account"));
    await heading("Verify your email");
    await user.type(field("Verification code"), "123456");
    await user.click(button("Verify"));
    await user.click(button("Use a different email"));
    await heading("Create your account");
    await user.clear(field("Email"));
    await user.type(field("Email"), "other@example.com");

    await act(async () => slow.release(verified()));
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
    expect(screen.queryByText(/Your email is verified/)).toBeNull();
    expect(field("Email").value).toBe("other@example.com");
  });
});
