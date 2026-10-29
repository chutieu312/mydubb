import { randomInt } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createUser, signInAs, startJob } from "./authHelpers";

// Guests and invited accounts get the same "Translate to" choice (mock providers). A guest job
// counts once against the guest quota, whatever its language.

// The result's translation heading (in mock mode it also holds an "Illustrative mock" chip).
const translationSummary = (page: Page, language: string) =>
  page.locator("summary").filter({ hasText: new RegExp(`^${language} translation`) });
const IP_HEADER = "x-e2e-client-ip";

test("a guest chooses Mandarin and the job counts as one of the guest jobs", async ({ page }) => {
  await page.setExtraHTTPHeaders({ [IP_HEADER]: `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}` });
  await page.goto("/");
  await page.getByRole("button", { name: "Try as guest" }).click();
  const banner = page.getByRole("region", { name: "Guest mode" });
  await expect(banner).toContainText("5 audio jobs left");

  await page.getByLabel("Translate to").selectOption("mandarin_simplified");
  await startJob(page);
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await created).request().postDataJSON().target_language).toBe("mandarin_simplified");
  await expect(translationSummary(page, "Mandarin Chinese")).toBeVisible({
    timeout: 30_000,
  });
  await expect(banner).toContainText("4 audio jobs left");
});

test("an invited account chooses Mandarin", async ({ page }) => {
  await signInAs(page, await createUser());
  await page.getByLabel("Translate to").selectOption("mandarin_simplified");
  await startJob(page, "Spring Boot uses JSON.", "Emma Multilingual");
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(translationSummary(page, "Mandarin Chinese")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Language Chinese — Mandarin \(Simplified\)/)).toBeVisible();
});
