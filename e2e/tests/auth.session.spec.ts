import { expect, test } from "@playwright/test";

import { createUser, fillSignIn, signInAs, startJob, studio } from "./authHelpers";

// Session, sign out, expiry and two accounts, against the real backend with an in-memory user
// pool stand-in.

const isLogout = (url: URL) => url.pathname === "/api/auth/logout";

test("sign out ends the server session and the next sign in starts empty", async ({ page }) => {
  const user = await createUser();
  await signInAs(page, user);
  await studio(page).fill("Not kept after sign out");

  const response = page.waitForResponse(
    (r) => isLogout(new URL(r.url())) && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  expect((await response).status()).toBe(204);
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();

  // The server session is gone: a reload stays signed out.
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();

  await fillSignIn(page, user);
  await expect(studio(page)).toBeVisible();
  await expect(studio(page)).toHaveValue("");
});

test("a failed sign out keeps the user signed in and can be retried", async ({ page }) => {
  const user = await createUser();
  await signInAs(page, user);
  const signOut = () => page.getByRole("button", { name: /^Sign(ing)? out/ });

  // Attempt 1: the network drops the request.
  await page.route(isLogout, (route) => route.abort("failed"));
  await signOut().click();
  await expect(page.getByRole("alert")).toContainText("Sign out failed; you are still signed in.");
  await expect(studio(page)).toBeVisible();

  // Attempt 2: the server fails.
  await page.unroute(isLogout);
  await page.route(isLogout, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "http_error", message: "Unavailable." } }),
    }),
  );
  await signOut().click();
  await expect(page.getByRole("alert")).toContainText("Sign out failed; you are still signed in.");

  // Neither attempt reached the server, so the real session is still valid.
  await page.unroute(isLogout);
  await page.reload();
  await expect(studio(page)).toBeVisible();

  // The retry against the real server succeeds (and sends the CSRF token it was given).
  const response = page.waitForResponse((r) => isLogout(new URL(r.url())));
  await signOut().click();
  expect((await response).status()).toBe(204);
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("an expired session returns to sign in; the same user gets the draft back, another does not", async ({
  page,
}) => {
  const ada = await createUser({ name: "Ada" });
  const bao = await createUser({ name: "Bao" });
  await signInAs(page, ada);
  await startJob(page, "My unsent draft");

  // The session disappears on the server's side (here: the cookie is gone).
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("session has expired");

  await fillSignIn(page, ada);
  await expect(studio(page)).toHaveValue("My unsent draft");
  await expect(page.getByLabel("Last Sentence Start Time")).toHaveValue("00:00:25");

  // Expire again, then a different user signs in: nothing of Ada's is shown.
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
  await fillSignIn(page, bao);
  await expect(page.locator(".header .account")).toContainText("Bao");
  await expect(studio(page)).toHaveValue("");
});

test("two accounts never see each other's jobs", async ({ browser, baseURL }) => {
  const ada = await createUser({ name: "Ada" });
  const bao = await createUser({ name: "Bao" });
  const adaContext = await browser.newContext({ baseURL });
  const baoContext = await browser.newContext({ baseURL });
  const adaPage = await adaContext.newPage();
  const baoPage = await baoContext.newPage();

  await signInAs(adaPage, ada);
  await startJob(adaPage, "Ada's private transcript");
  const created = adaPage.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await adaPage.getByRole("button", { name: "Generate audio" }).click();
  const job = (await (await created).json()) as { id: string };
  await expect(adaPage.locator(".stage.done", { hasText: "Completed" })).toBeVisible();

  await signInAs(baoPage, bao);
  for (const path of [`/api/jobs/${job.id}`, `/api/jobs/${job.id}/result`, `/api/jobs/${job.id}/result/audio`]) {
    expect((await baoPage.request.get(path)).status(), path).toBe(404);
  }
  await expect(baoPage.getByText("Ada's private transcript")).toHaveCount(0);
  await expect(baoPage.locator(".stage")).toHaveCount(0);

  // Ada still has her job, from a new page of hers.
  expect((await adaPage.request.get(`/api/jobs/${job.id}`)).status()).toBe(200);
  await adaContext.close();
  await baoContext.close();
});
