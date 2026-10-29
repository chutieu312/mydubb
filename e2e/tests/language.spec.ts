import { expect, test, type Page } from "@playwright/test";

import { fillJobForm, signIn } from "./helpers";

// "Translate to" against the real backend with mock providers: the mock translation names the
// language it stands in for, and the audio is the fixed chime (no speech in any language).

// The result's translation heading (in mock mode it also holds an "Illustrative mock" chip).
const translationSummary = (page: Page, language: string) =>
  page.locator("summary").filter({ hasText: new RegExp(`^${language} translation`) });
const select = (page: Page) => page.getByLabel("Translate to");
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function submit(page: Page) {
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  return created;
}

test("Vietnamese is the default and a job sent without changing it is Vietnamese", async ({
  page,
}) => {
  await signIn(page);
  await expect(select(page)).toHaveValue("vietnamese");
  await expect(page.getByText("English → Vietnamese")).toBeVisible();
  await fillJobForm(page, { transcript: "Spring Boot uses JSON." });
  const response = await submit(page);
  expect(response.request().postDataJSON().target_language).toBe("vietnamese");
  expect((await response.json()).target_language).toBe("vietnamese");
  await expect(page.getByText("Mock sample ready")).toBeVisible();
  await expect(translationSummary(page, "Vietnamese")).toBeVisible();
  await expect(page.locator(".translation")).toContainText("NOT a real Vietnamese translation");
});

test("a Mandarin job keeps its language while the form changes, without sideways overflow", async ({
  page,
}) => {
  await signIn(page);
  await select(page).selectOption({ label: "Chinese — Mandarin (Simplified)" });
  await expect(page.getByText("English → Mandarin Chinese")).toBeVisible();
  await fillJobForm(page, { transcript: "Spring Boot uses JSON.", voice: "Emma Multilingual" });
  await page.getByLabel("1.25x", { exact: true }).check();

  const response = await submit(page);
  expect(response.request().postDataJSON()).toMatchObject({
    target_language: "mandarin_simplified",
    voice: "EmmaMultilingual",
    speed: 1.25,
  });
  await expect(page.getByText("Mock sample ready")).toBeVisible();
  const summary = translationSummary(page, "Mandarin Chinese");
  await expect(summary).toBeVisible();
  await expect(page.locator(".translation")).toContainText("中文示例");
  await expect(page.locator(".translation")).not.toContainText("Vietnamese");
  await expect(page.getByText(/Language Chinese — Mandarin \(Simplified\)/)).toBeVisible();

  // Choosing another language now changes only the next job, never this one.
  await select(page).selectOption("vietnamese");
  await expect(summary).toBeVisible();
  await expect(translationSummary(page, "Vietnamese")).toHaveCount(0);

  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

for (const width of [320, 390]) {
  test(`Translate to fits and is easy to tap at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    const box = (await select(page).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await select(page).selectOption("mandarin_simplified");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // Reachable from the keyboard, with a visible label.
    await select(page).focus();
    await expect(select(page)).toBeFocused();
  });
}
