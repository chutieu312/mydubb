import { expect, test, type Page } from "@playwright/test";

import { fillJobForm, signIn } from "./helpers";

// The six added output languages against the real backend with mock providers. The mock
// translation is English text labelled with the language, so the right-to-left layout of a real
// Arabic translation is checked by answering the result request with one (page.route); everything
// else (meta, job, stored language) is the real backend. Set E2E_SCREENSHOT_DIR to keep
// screenshots of the Arabic result for a visual check.

const ARABIC =
  "يستخدم Spring Boot صيغة JSON عبر /api/v1 لإرجاع 1,024 سجلا بنسبة 50%.\n" +
  "ثم ننشر الخدمة على Kubernetes باستخدام REST API، وهذا كل شيء.\n" +
  "افتح /2026/api ثم https://example.com/search?q=API&lang=en، واحفظ في " +
  String.raw`C:\Users\demo\file.txt.`;
// Whole tokens, each one left-to-right isolate, in text order.
const ISOLATES = [
  "Spring Boot",
  "JSON",
  "/api/v1",
  "Kubernetes",
  "REST API",
  "/2026/api",
  "https://example.com/search?q=API&lang=en",
  String.raw`C:\Users\demo\file.txt`,
];

const select = (page: Page) => page.getByLabel("Translate to");
const translationSummary = (page: Page, language: string) =>
  page.locator("summary").filter({ hasText: new RegExp(`^${language} translation`) });
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function submit(page: Page) {
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  return created;
}

test("the eight languages are offered in order, Vietnamese first and selected", async ({ page }) => {
  await signIn(page);
  await expect(select(page)).toHaveValue("vietnamese");
  const labels = await select(page).locator("option").allTextContents();
  expect(labels).toEqual([
    "Vietnamese",
    "Chinese — Mandarin (Simplified)",
    "Hindi",
    "Spanish (Spain)",
    "Arabic (Modern Standard)",
    "French (France)",
    "Russian",
    "Japanese",
  ]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Turn English into audio in your chosen language",
  );
});

for (const [id, noun, sample] of [
  ["hindi", "Hindi", "हिन्दी उदाहरण"],
  ["japanese", "Japanese", "日本語の例"],
] as const) {
  test(`a ${noun} job is stored and shown in ${noun}, whatever the form shows later`, async ({
    page,
  }) => {
    await signIn(page);
    await select(page).selectOption(id);
    await expect(page.getByText(`English → ${noun}`)).toBeVisible();
    await fillJobForm(page, { transcript: "Spring Boot uses JSON.", voice: "Emma Multilingual" });
    const response = await submit(page);
    expect(response.request().postDataJSON()).toMatchObject({
      target_language: id,
      voice: "EmmaMultilingual",
    });
    expect((await response.json()).target_language).toBe(id);
    const summary = translationSummary(page, noun);
    await expect(summary).toBeVisible();
    await expect(page.locator(".translation")).toContainText(sample);
    await expect(page.locator(".translation")).toContainText(`NOT a real ${noun} translation`);
    await select(page).selectOption("arabic");
    await expect(summary).toBeVisible();
    await expect(translationSummary(page, "Arabic")).toHaveCount(0);
  });
}

for (const width of [320, 390, 1280]) {
  test(`an Arabic result reads right to left in its box only at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/jobs/*/result", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.translation = { ...body.translation, text: ARABIC, is_illustrative: false };
      await route.fulfill({ response, json: body });
    });
    await signIn(page);
    await select(page).selectOption("arabic");
    await fillJobForm(page, { transcript: "Spring Boot uses JSON." });
    const response = await submit(page);
    expect((await response.json()).target_language).toBe("arabic");
    await expect(translationSummary(page, "Arabic")).toBeVisible();
    const box = page.locator(".translation");
    await expect(box).toHaveAttribute("dir", "rtl");
    await expect(box).toHaveAttribute("lang", "ar");
    await expect(box).toHaveText(ARABIC);
    expect(await box.evaluate((e) => getComputedStyle(e).direction)).toBe("rtl");
    // English terms and code are left-to-right isolates ("/api/v1" keeps its leading slash).
    await expect(box.locator('span[dir="ltr"]')).toHaveText(ISOLATES);
    // What the browser draws, not only the text, measured on the whole text whatever the markup:
    // the characters of every expected token go left to right in text order on each line, the
    // punctuation right after a token on the same line is drawn on its left (the Arabic side),
    // and the paragraph starts at the right edge.
    const layout = await box.evaluate((element, tokens) => {
      const nodes: { node: Text; start: number }[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let length = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node: node as Text, start: length });
        length += node.textContent!.length;
      }
      const rectAt = (offset: number) => {
        const { node, start } = nodes.filter((n) => n.start <= offset).at(-1)!;
        const range = document.createRange();
        range.setStart(node, offset - start);
        range.setEnd(node, offset - start + 1);
        return range.getBoundingClientRect();
      };
      const text = element.textContent!;
      const misordered: string[] = [];
      const punctuation: string[] = [];
      for (const token of tokens) {
        const at = text.indexOf(token);
        if (at < 0) {
          misordered.push(`${token} not found`);
          continue;
        }
        const rects = Array.from(token, (_, i) => rectAt(at + i));
        for (let i = 1; i < rects.length; i++) {
          const sameLine = Math.abs(rects[i].top - rects[i - 1].top) < 2;
          if (token[i] !== " " && token[i - 1] !== " " && sameLine && rects[i].left < rects[i - 1].left - 0.5) {
            misordered.push(`${token} at ${i}`);
          }
        }
        const after = at + token.length;
        if (/[.،؟,]/.test(text[after] ?? "")) {
          const mark = rectAt(after);
          const last = rects[rects.length - 1];
          if (Math.abs(mark.top - last.top) < 2 && mark.left > last.left) {
            punctuation.push(`${text[after]} after ${token}`);
          }
        }
      }
      const first = rectAt(0);
      const content = element.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(element).paddingRight);
      return { misordered, punctuation, startGap: content.right - padding - first.right };
    }, ISOLATES);
    expect(layout.misordered).toEqual([]);
    expect(layout.punctuation).toEqual([]);
    expect(layout.startGap).toBeLessThan(4); // the Arabic text starts on the right
    // The page itself stays left to right; nothing overflows sideways.
    expect(await page.evaluate(() => getComputedStyle(document.body).direction)).toBe("ltr");
    const summary = translationSummary(page, "Arabic");
    expect(await summary.evaluate((e) => getComputedStyle(e).direction)).toBe("ltr");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const rect = (await box.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    const dir = process.env.E2E_SCREENSHOT_DIR;
    if (dir) {
      await box.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${dir}/arabic-${test.info().project.name}-${width}.png` });
    }
  });
}

test("an imported transcript, edited, is sent in the chosen language", async ({ page }) => {
  await signIn(page);
  await page.getByRole("radio", { name: "YouTube URL" }).click();
  await page.getByLabel("YouTube video link").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.getByRole("button", { name: "Import transcript" }).click();
  const transcript = page.getByLabel("English Transcript");
  await expect(transcript).toHaveValue(/Welcome back\. Today we look at gradient descent\./);
  const edited = (await transcript.inputValue()).replace("Welcome back.", "Welcome back, all.");
  await transcript.fill(edited);
  await select(page).selectOption("spanish");
  const response = await submit(page);
  expect(response.request().postDataJSON()).toMatchObject({
    transcript: edited,
    timing_mode: "timed",
    target_language: "spanish",
  });
  await expect(translationSummary(page, "Spanish")).toBeVisible();
  await expect(page.locator(".translation")).toContainText("(ES mock ejemplo) Welcome back, all.");
});
