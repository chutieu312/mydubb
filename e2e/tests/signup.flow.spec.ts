import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { escapes, overflow } from "./authHelpers";

// Public sign-up on the sign-up stack (docker-compose.e2e.yml `app-signup`): the real backend and
// React build, with stand-ins for the user pool and for Google's siteverify. Google's browser script
// is replaced here by a stand-in served at its real address, so the page's real CSP still applies;
// every other request leaving 127.0.0.1 is refused and recorded.

const PASSWORD = "Passw0rd-signup";

function controlUrl(): string {
  const url = process.env.E2E_SIGNUP_CONTROL_URL;
  if (!url) throw new Error("E2E_SIGNUP_CONTROL_URL is not set (use e2e/run-e2e.sh)");
  return url;
}

async function control<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${controlUrl()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

const signupCode = async (email: string) =>
  (await control<{ signup_code: string | null }>(`/codes/${encodeURIComponent(email)}`)).body
    .signup_code;

const newEmail = () => `signup-${randomUUID().slice(0, 8)}@example.com`;

// Google's reCAPTCHA API as the page uses it (explicit render), drawing two buttons instead of the
// iframe: one hands out a token the fake siteverify accepts once, the other a forged one.
const FAKE_GOOGLE_SCRIPT = `
window.grecaptcha = {
  render: function (target, p) {
    var make = function (label, prefix) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", function () {
        p.callback(prefix + Math.random().toString(36).slice(2) + Date.now());
      });
      return b;
    };
    target.dataset.theme = p.theme;
    target.append(make("Fake robot check", "ok-"), make("Fake forged check", "bad-"));
    return 0;
  },
  reset: function () {},
};
window.mydubbRecaptchaReady();
`;

async function guard(page: Page): Promise<string[]> {
  const outside: string[] = [];
  await page.route(/^https:\/\/www\.google\.com\/recaptcha\/api\.js/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: FAKE_GOOGLE_SCRIPT }),
  );
  await page.route(
    (url) => url.hostname !== "127.0.0.1" && !url.href.startsWith("https://www.google.com/recaptcha/api.js"),
    (route) => {
      outside.push(route.request().url());
      return route.abort();
    },
  );
  return outside;
}

async function openCreate(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fake robot check" })).toBeVisible();
}

async function fillCreate(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Fake robot check" }).click();
}

test("create an account, verify the email, sign in and use the Studio as Free", async ({ page }) => {
  const outside = await guard(page);
  const email = newEmail();
  await page.goto("/");
  await expect(page.getByText(/New accounts get the Free plan: 20 Generates and 5 YouTube imports a day/)).toBeVisible();
  await expect(page.getByText("Access is currently by invitation only.")).toHaveCount(0);

  await openCreate(page);
  await fillCreate(page, email);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  // Before verification the account cannot sign in.
  const code = await signupCode(email);
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel("Verification code").fill(code as string);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
  await expect(page.getByText(/Your email is verified/)).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(email);

  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("English Transcript")).toBeVisible();
  const plan = page.getByRole("region", { name: "Your plan" });
  await expect(plan).toContainText("20");
  await expect(plan).toContainText("00:00 UTC");

  expect(outside).toEqual([]);
});

test("an account that has not verified its email cannot sign in", async ({ page }) => {
  await guard(page);
  const email = newEmail();
  await openCreate(page);
  await fillCreate(page, email);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect email or password");
  await expect(page.getByLabel("English Transcript")).toHaveCount(0);
});

test("a forged robot check is refused beside the box and creates nothing", async ({ page }) => {
  await guard(page);
  const email = newEmail();
  await openCreate(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Fake forged check" }).click();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const group = page.getByRole("group", { name: "Robot check" });
  await expect(group).toContainText("The robot check expired or did not pass");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(PASSWORD);
  expect((await control(`/codes/${encodeURIComponent(email)}`)).status).toBe(404);
});

test("an existing email gets the same Verify screen and no code", async ({ page }) => {
  await guard(page);
  const email = newEmail();
  await control("/users", { email, password: "Existing-pass-1", name: null, temporary: false, email_verified: true });
  await openCreate(page);
  await fillCreate(page, email);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText(/If you already have an account, sign in or use Forgot password/)).toBeVisible();
  expect(await signupCode(email)).toBeNull();
});

test("a wrong code is shown beside the code box, Resend sends a new one", async ({ page }) => {
  await guard(page);
  const email = newEmail();
  await openCreate(page);
  await fillCreate(page, email);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const first = await signupCode(email);
  const box = page.getByLabel("Verification code");
  await box.fill(first === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText("That code is not right.")).toBeVisible();
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(box).toBeFocused();

  await page.getByRole("button", { name: "Resend code" }).click();
  // The development banner is a status too: find the confirmation by its text.
  await expect(page.getByText(/a new code is on its way/)).toBeVisible();
  await expect.poll(() => signupCode(email)).not.toBe(first);
  await box.fill((await signupCode(email)) as string);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText(/Your email is verified/)).toBeVisible();
});

test("works with the keyboard, follows dark mode and fits a 320 px screen", async ({ page }) => {
  await guard(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: /dark mode/i }).click();
  await page.getByRole("button", { name: "Create account" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeFocused();
  await expect(page.locator(".recaptcha-box [data-theme]")).toHaveAttribute("data-theme", "dark");

  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.press("Enter"); // an empty form: messages, focus on the first field
  await expect(page.getByText("Enter your email address.")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeFocused();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await escapes(page)).toEqual([]);
});
