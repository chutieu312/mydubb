import { expect, test, type Locator, type Page } from "@playwright/test";

import { borderContrast, textContrast } from "./contrast";
import { fillJobForm, signIn } from "./helpers";

// Appearance: light by default, a saved light/dark choice, readable contrast in both themes,
// and no horizontal overflow on narrow screens.

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);

test("starts in light mode even when the OS asks for dark, and remembers the choice", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ colorScheme: "dark", baseURL });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByLabel("Access Code")).toBeVisible();
  expect(await theme(page)).toBe("light");

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  expect(await theme(page)).toBe("dark");
  await page.reload();
  await expect(page.getByLabel("Access Code")).toBeVisible();
  expect(await theme(page)).toBe("dark");

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await page.reload();
  expect(await theme(page)).toBe("light");
  await context.close();
});

test("the theme toggle works from the keyboard and changes nothing else", async ({ page }) => {
  await signIn(page);
  await fillJobForm(page, { transcript: "Spring Boot uses JSON.", first: "00:00:05", last: "00:00:25" });
  await page.getByLabel("1.5x", { exact: true }).check();

  await page.getByRole("button", { name: "Switch to dark mode" }).focus();
  await page.keyboard.press("Enter");
  expect(await theme(page)).toBe("dark");

  await expect(page.getByLabel("English Transcript")).toHaveValue("Spring Boot uses JSON.");
  await expect(page.getByLabel("First Sentence Start Time")).toHaveValue("00:00:05");
  await expect(page.getByLabel("1.5x", { exact: true })).toBeChecked();
  await expect(page.getByLabel(/Andrew Multilingual/)).toBeChecked();
});

test("keyboard users can reach every control and see where they are", async ({ page }) => {
  await signIn(page);
  await page.getByLabel("English Transcript").focus();
  const order: string[] = [];
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return el.getAttribute("aria-label") || el.id || el.textContent || el.tagName;
      }),
    );
  }
  // Timestamps, the "How timing works" disclosure, the checked voice, the checked speed, the
  // Generate button: each gets focus, in reading order.
  expect(order[0]).toBe("first-start");
  expect(order[1]).toBe("last-start");
  expect(order.some((entry) => entry.includes("How timing works"))).toBe(true);
  expect(order.some((entry) => entry.includes("Generate audio"))).toBe(true);

  await page.getByRole("button", { name: "Generate audio" }).focus();
  const outline = await page
    .getByRole("button", { name: "Generate audio" })
    .evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});

test("text and controls are readable in both themes, before and after a job", async ({ page }) => {
  await signIn(page);

  // A validation error is on screen so its colour is measured too.
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByText("Transcript must contain English text.")).toBeVisible();
  for (const mode of ["light", "dark"]) {
    if ((await theme(page)) !== mode) await page.locator(".header .pill").click();
    const ratio = await textContrast(page.locator(".error").first());
    expect(ratio, `${mode}: error text contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  }
  if ((await theme(page)) !== "light") await page.locator(".header .pill").click();
  await fillJobForm(page, { transcript: "Spring Boot uses JSON.", first: "00:00:05", last: "00:00:25" });
  await page.getByLabel("1.5x", { exact: true }).check();

  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await created).status()).toBe(202);
  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible();
  await expect(page.getByText("Mock sample ready")).toBeVisible();

  const textTargets: [string, Locator][] = [
    ["heading", page.locator(".hero h1")],
    ["muted text", page.locator(".hero p.muted")],
    ["eyebrow", page.locator(".eyebrow")],
    ["panel title", page.locator(".panel-title")],
    ["input text", page.getByLabel("First Sentence Start Time")],
    ["selected speed", page.locator(".speed-option input:checked + span")],
    ["unselected speed", page.locator(".speed-option input:not(:checked) + span").first()],
    ["selected voice", page.locator(".voice-option:has(input:checked)")],
    ["length preview", page.locator(".length-box")],
    ["primary button", page.getByRole("button", { name: "Generate audio" })],
    ["download button", page.getByRole("link", { name: "Download MP3" })],
    ["theme toggle", page.locator(".header .pill")],
    ["done stage", page.locator(".stage.done").first()],
    ["success line", page.locator(".success")],
    ["warning callout", page.locator(".callout.warning").first()],
    ["chip", page.locator(".chip").first()],
    ["fact label", page.locator(".facts dt").first()],
    ["translation text", page.locator(".translation")],
    ["footer text", page.locator(".footer .muted").first()],
  ];
  const controlTargets: [string, Locator][] = [
    ["transcript border", page.getByLabel("English Transcript")],
    ["timestamp border", page.getByLabel("First Sentence Start Time")],
    ["unselected speed border", page.locator(".speed-option input:not(:checked) + span").first()],
    ["voice border", page.locator(".voice-option").first()],
  ];

  for (const mode of ["light", "dark"]) {
    if ((await theme(page)) !== mode) await page.locator(".header .pill").click();
    expect(await theme(page)).toBe(mode);
    // The finished job is still there after switching theme.
    await expect(page.getByText("Mock sample ready")).toBeVisible();

    for (const [name, target] of textTargets) {
      const ratio = await textContrast(target);
      expect(ratio, `${mode}: ${name} text contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [name, target] of controlTargets) {
      const ratio = await borderContrast(target);
      expect(ratio, `${mode}: ${name} contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  }
});

for (const width of [320, 390, 412]) {
  test(`nothing overflows sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await page.goto("/");
    await expect(page.getByLabel("Access Code")).toBeVisible();
    expect(await overflow(), "Access Code screen").toBeLessThanOrEqual(0);

    await signIn(page);
    expect(await overflow(), "empty form").toBeLessThanOrEqual(0);

    await fillJobForm(page, { transcript: "Spring Boot uses JSON.", first: "00:00:05", last: "00:00:25" });
    await page.getByLabel("0.75x", { exact: true }).check();
    expect(await overflow(), "filled form with a speed warning").toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "Generate audio" }).click();
    await expect(page.getByText("Mock sample ready")).toBeVisible();
    await page.getByText("Audio details").click();
    expect(await overflow(), "result with Audio details open").toBeLessThanOrEqual(0);

    // Tap targets stay comfortable.
    for (const control of [
      page.getByRole("button", { name: "Generate audio" }),
      page.getByRole("link", { name: "Download MP3" }),
      page.locator(".header .pill"),
      page.getByLabel("1x", { exact: true }).locator("xpath=following-sibling::span"),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  });
}
