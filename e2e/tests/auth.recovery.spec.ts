import { expect, test } from "@playwright/test";

import { codesFor, createUser, emailedCode, failNext, fillSignIn, studio } from "./authHelpers";

// Forgot and reset password against the real backend with an in-memory user pool stand-in.

async function requestCode(page: import("@playwright/test").Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeFocused();
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
}

async function fillReset(
  page: import("@playwright/test").Page,
  code: string,
  password: string,
  confirm = password,
) {
  await page.getByLabel("Verification code").fill(code);
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Confirm password").fill(confirm);
  await page.getByRole("button", { name: "Reset password" }).click();
}

test("forgot password says the same for a known and an unknown address", async ({ page }) => {
  const user = await createUser();
  await requestCode(page, user.email);
  const known = (await page.locator(".gate-form").getByRole("status").textContent())!.replace(user.email, "ADDRESS");

  await requestCode(page, "nobody-here@example.com");
  const unknown = (await page.locator(".gate-form").getByRole("status").textContent())!.replace(
    "nobody-here@example.com",
    "ADDRESS",
  );

  expect(known).toBe(unknown);
  expect(known).toContain("If an account exists for ADDRESS");
  // Only the real account got a code.
  expect((await codesFor(user.email)).reset_code).not.toBeNull();
});

test("resets the password: not signed in, new password works, old one does not", async ({ page }) => {
  const user = await createUser();
  await requestCode(page, user.email);

  await fillReset(page, await emailedCode(user.email, "reset_code"), "brand-new-pass-1");

  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeFocused();
  await expect(page.locator(".gate-form").getByRole("status")).toContainText("password has been changed");
  await expect(studio(page)).toHaveCount(0); // a reset never signs anyone in

  await fillSignIn(page, user); // the old password
  await expect(page.getByRole("alert")).toContainText("Incorrect email or password");
  await fillSignIn(page, { email: user.email, password: "brand-new-pass-1" });
  await expect(studio(page)).toBeVisible();
});

test("a wrong code and a rejected password keep the user on the form", async ({ page }) => {
  const user = await createUser();
  await requestCode(page, user.email);
  const code = await emailedCode(user.email, "reset_code");

  await fillReset(page, "000000", "brand-new-pass-1");
  await expect(page.getByRole("alert")).toContainText("incorrect or has expired");
  await expect(page.getByLabel("New password")).toHaveValue("");

  await fillReset(page, code, "short");
  await expect(page.getByRole("alert")).toContainText("does not meet the password requirements");
  await expect(page.getByLabel("Verification code")).toHaveValue(code);

  // The same code still works with an acceptable password.
  await fillReset(page, code, "brand-new-pass-1");
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
});

test("checks the code format and the confirmation before asking the server", async ({ page }) => {
  const user = await createUser();
  await requestCode(page, user.email);
  let sent = 0;
  page.on("request", (r) => r.url().endsWith("/api/auth/reset-password") && sent++);

  await fillReset(page, "12-34", "brand-new-pass-1", "something-else-1");

  await expect(page.getByText("Enter the numeric code from the email (digits only).")).toBeVisible();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();
  expect(sent).toBe(0);
});

test("when the outcome is unknown the UI shows the server's message, once, and does not retry", async ({
  page,
}) => {
  const user = await createUser();
  await requestCode(page, user.email);
  const code = await emailedCode(user.email, "reset_code");
  await failNext("ConfirmForgotPassword", user.email, "unavailable");
  let sent = 0;
  page.on("request", (r) => r.url().endsWith("/api/auth/reset-password") && sent++);

  await fillReset(page, code, "brand-new-pass-1");

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  const text = (await alert.textContent())!;
  expect(text).toMatch(/signed out|could not confirm|not available/i);
  expect(text).not.toMatch(/unchanged|not changed|nothing changed|cognito|\baws\b/i);
  await page.waitForTimeout(1500);
  expect(sent).toBe(1);

  // The backend fails closed for about 80 s: a sign-in right now, with either password, is refused
  // with its own message. (The stand-in never applied the new one, so the old one is the valid one.)
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await fillSignIn(page, user);
  await expect(page.getByRole("alert")).toContainText(
    "Your password or account access changed while you were signing in.",
  );
});
