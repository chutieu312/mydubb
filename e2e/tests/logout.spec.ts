import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

const isLogout = (url: URL) => url.pathname === "/api/session";

test("logout ends the server session", async ({ page }) => {
  await signIn(page);

  const response = page.waitForResponse(
    (r) => isLogout(new URL(r.url())) && r.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "Log out" }).click();
  expect((await response).status()).toBe(204);
  await expect(page.getByLabel("Access Code")).toBeVisible();

  // The server session is gone: a reload stays signed out.
  await page.reload();
  await expect(page.getByLabel("Access Code")).toBeVisible();
});

test("failed logout keeps the user signed in and can be retried", async ({ page }) => {
  await signIn(page);

  // First attempt: the network drops the request.
  await page.route(isLogout, (route) =>
    route.request().method() === "DELETE" ? route.abort("failed") : route.fallback(),
  );
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("alert")).toContainText("Logout failed; you are still signed in.");
  await expect(page.getByLabel("English Transcript")).toBeVisible();

  // Second attempt: the server fails.
  await page.unroute(isLogout);
  await page.route(isLogout, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "internal_error", message: "Server error." } }),
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("alert")).toContainText("Logout failed; you are still signed in.");

  // Neither attempt reached the server, so the real session is still valid.
  await page.unroute(isLogout);
  await page.reload();
  await expect(page.getByLabel("English Transcript")).toBeVisible();

  // Retry against the real server succeeds.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByLabel("Access Code")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Access Code")).toBeVisible();
});
