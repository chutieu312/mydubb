import { expect, test } from "@playwright/test";

import {
  PASSWORD,
  codesFor,
  createUser,
  disableUser,
  emailedCode,
  fillSignIn,
  signInAs,
  startJob,
  studio,
} from "./authHelpers";

// Email + password sign-in against the real backend with an in-memory user pool stand-in.
// This is NOT a live Amazon Cognito test.

test("the backend announces email + password and the Access Code endpoint is gone", async ({
  page,
}) => {
  const meta = await (await page.request.get("/api/meta")).json();
  expect(meta.auth).toEqual({ mode: "cognito", self_registration: false, password_reset: true });
  // 404 on a bare API, 405 where the built UI answers GET only; never a working Access Code login.
  const accessCode = await page.request.post("/api/session", { data: { access_code: "x" } });
  expect([404, 405]).toContain(accessCode.status());

  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByText("Access is currently by invitation only.")).toBeVisible();
  await expect(page.getByLabel("Access Code")).toHaveCount(0);
  await expect(page.getByText(/sign up|create (an )?account|register/i)).toHaveCount(0);
});

test("signs in, restores the session on reload and runs a dubbing job", async ({ page }) => {
  const user = await createUser({ name: "Ada Lovelace" });
  await signInAs(page, user);

  // The account is shown; credentials and the session are not reachable from JavaScript.
  await expect(page.locator(".header .account")).toContainText("Ada Lovelace");
  expect(await page.evaluate(() => document.cookie)).toBe("");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(
    new RegExp(`${PASSWORD}|csrf|challenge|${user.email}`, "i"),
  );

  // Reload: the session comes back through /api/auth/me.
  await page.reload();
  await expect(studio(page)).toBeVisible();
  await expect(page.locator(".header .account")).toContainText("Ada Lovelace");

  // The workflow works with a signed-in user: voice, speed, playback and download.
  await startJob(page, "Spring Boot uses JSON.", "Emma Multilingual");
  await page.getByLabel("1.5x", { exact: true }).check();
  const created = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await created).headers()["x-csrf-token"]).toBeTruthy();

  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible();
  await expect(page.getByText("Mock sample ready")).toBeVisible();
  await expect(page.locator("audio")).toHaveCount(1);
  const download = page.getByRole("link", { name: "Download MP3" });
  const file = await page.request.get((await download.getAttribute("href"))!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("audio/mpeg");
  expect(file.headers()["content-disposition"]).toContain("attachment");
});

test("an account without a display name is shown by its email", async ({ page }) => {
  const user = await createUser({ name: null });
  await signInAs(page, user);
  await expect(page.locator(".header .account")).toContainText(user.email);
});

test("a wrong password and an unknown account get the same answer", async ({ page }) => {
  const user = await createUser();
  await page.goto("/");

  await fillSignIn(page, { email: user.email, password: "not-the-password" });
  const wrong = await page.getByRole("alert").textContent();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");

  await fillSignIn(page, { email: "nobody-here@example.com", password: "not-the-password" });
  await expect(page.getByRole("alert")).toHaveText(wrong!);
  expect(wrong).toContain("Incorrect email or password");
});

test("an account disabled in the user pool cannot sign in", async ({ page }) => {
  const user = await createUser();
  await disableUser(user.email);
  await page.goto("/");

  await fillSignIn(page, user);

  await expect(page.getByRole("alert")).toContainText("Incorrect email or password");
  await expect(studio(page)).toHaveCount(0);
});

test("temporary password, then email verification, then the Studio", async ({ page }) => {
  const user = await createUser({ temporary: true, emailVerified: false });
  await page.goto("/");
  await fillSignIn(page, user);

  // Set your password.
  await expect(page.getByRole("heading", { name: "Set your password" })).toBeFocused();
  await page.getByLabel("New password").fill("another-pass-1");
  await page.getByLabel("Confirm password").fill("different-pass-1");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();

  // The server decides what a valid password is (the stand-in wants 8+ characters).
  await page.getByLabel("New password").fill("short");
  await page.getByLabel("Confirm password").fill("short");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert")).toContainText("does not meet the password requirements");
  await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible();

  await page.getByLabel("New password").fill("a-new-password-1");
  await page.getByLabel("Confirm password").fill("a-new-password-1");
  await page.getByRole("button", { name: "Set password" }).click();

  // Verify your email: nothing is sent until the user asks.
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeFocused();
  await page.waitForTimeout(500);
  expect((await codesFor(user.email)).verification_code).toBeNull();

  await page.getByLabel("Verification code").fill("000000");
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("alert")).toContainText("incorrect or has expired");
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();

  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.locator(".gate-form").getByRole("status")).toContainText("A code is on its way");
  const first = await emailedCode(user.email, "verification_code");
  await page.getByRole("button", { name: "Resend code" }).click();
  await expect.poll(async () => (await codesFor(user.email)).verification_code).not.toBe(first);
  const second = (await codesFor(user.email)).verification_code!;

  // The first code was replaced by the resend; the new one works.
  await page.getByLabel("Verification code").fill(first);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByRole("alert")).toContainText("incorrect or has expired");
  await page.getByLabel("Verification code").fill(second);
  await page.getByRole("button", { name: "Verify email" }).click();

  await expect(studio(page)).toBeVisible();
  await expect(page.locator(".header .account")).toContainText("Ada");
});

test("an unverified account that already has a password goes straight to verification", async ({
  page,
}) => {
  const user = await createUser({ emailVerified: false });
  await page.goto("/");
  await fillSignIn(page, user);

  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("Verification code").fill(await emailedCode(user.email, "verification_code"));
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(studio(page)).toBeVisible();
});

test("a sign-in step whose browser cookie is gone sends the user back to sign in", async ({
  page,
}) => {
  const user = await createUser({ temporary: true });
  await page.goto("/");
  await fillSignIn(page, user);
  await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible();

  // The pending step is bound to this browser by a cookie JavaScript cannot see.
  await page.context().clearCookies();
  await page.getByLabel("New password").fill("a-new-password-1");
  await page.getByLabel("Confirm password").fill("a-new-password-1");
  await page.getByRole("button", { name: "Set password" }).click();

  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("expired or was already completed");
});
