import { expect, test, type Locator, type Page } from "@playwright/test";

import { signIn } from "./helpers";

// Typing in the two start time fields in a real browser: real key events, caret and clipboard.
// Unit tests cover the rules; this covers what only a browser does (caret placement, selection
// replacement, Backspace/Delete next to a colon, paste, the phone viewport).

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const caret = (input: Locator) =>
  input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);

async function place(input: Locator, start: number, end = start) {
  await input.focus();
  await input.evaluate((el: HTMLInputElement, [s, e]) => el.setSelectionRange(s, e), [start, end]);
}

async function paste(page: Page, text: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+V");
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("digits get their colons while typing, with no completion and a stable caret", async ({ page }) => {
  const input = page.getByLabel("First Sentence Start Time");
  await input.focus();
  const shown: string[] = [];
  for (const digit of "000001") {
    await page.keyboard.type(digit);
    shown.push(await input.inputValue());
  }
  expect(shown).toEqual(["0", "00", "00:0", "00:00", "00:00:0", "00:00:01"]);
  expect(await caret(input)).toEqual([8, 8]);

  // A seventh digit and a letter are not accepted.
  await page.keyboard.type("7");
  await page.keyboard.type("x");
  await expect(input).toHaveValue("00:00:01");
  await expect(input).toHaveAttribute("inputmode", "numeric");
});

test("Backspace and Delete next to a colon remove a digit instead of sticking", async ({ page }) => {
  const input = page.getByLabel("Last Sentence Start Time");
  await input.fill("00:12:34");

  await place(input, 6); // right after the second colon
  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("00:13:4");
  expect(await caret(input)).toEqual([4, 4]);

  await place(input, 2); // right before the first colon
  await page.keyboard.press("Delete");
  await expect(input).toHaveValue("00:34");
  expect(await caret(input)).toEqual([2, 2]);

  await place(input, 5);
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("");
});

test("editing in the middle and replacing a selection keep the caret where the edit was", async ({ page }) => {
  const input = page.getByLabel("First Sentence Start Time");
  await input.fill("12:56");

  await place(input, 2);
  await page.keyboard.type("34");
  await expect(input).toHaveValue("12:34:56");
  expect(await caret(input)).toEqual([5, 5]);

  await place(input, 3, 5); // the minutes
  await page.keyboard.type("9");
  await expect(input).toHaveValue("12:95:6");
  expect(await caret(input)).toEqual([4, 4]);

  await place(input, 0, 7);
  await page.keyboard.type("010530");
  await expect(input).toHaveValue("01:05:30");
});

test("paste accepts six digits and the colon format, and keeps other text visible", async ({ page }) => {
  const input = page.getByLabel("First Sentence Start Time");
  await input.focus();
  await paste(page, "000001");
  await expect(input).toHaveValue("00:00:01");

  await input.press("ControlOrMeta+A");
  await paste(page, "00:00:01");
  await expect(input).toHaveValue("00:00:01");

  await input.press("ControlOrMeta+A");
  await paste(page, "100:05:30");
  await expect(input).toHaveValue("100:05:30");

  await input.press("ControlOrMeta+A");
  await paste(page, "abc00:00:01");
  await expect(input).toHaveValue("abc00:00:01");
});

test("the typed timestamps are previewed and submitted in the existing format", async ({ page }) => {
  await page.getByLabel("English Transcript").fill("Spring Boot uses JSON.");
  await page.getByLabel("First Sentence Start Time").pressSequentially("000010");
  await page.getByLabel("Last Sentence Start Time").pressSequentially("000610");
  await expect(page.getByLabel("Audio length preview").locator(".length-value")).toHaveText("00:06:00");

  const request = page.waitForRequest(
    (r) => r.url().endsWith("/api/jobs") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await request).postDataJSON()).toMatchObject({
    first_sentence_start: "00:00:10",
    last_sentence_start: "00:06:10",
  });
});

test("an incomplete timestamp is reported by the server and tied to the field", async ({ page }) => {
  await page.getByLabel("English Transcript").fill("Hello.");
  const first = page.getByLabel("First Sentence Start Time");
  await first.pressSequentially("00001");
  await page.getByLabel("Last Sentence Start Time").pressSequentially("000610");
  await expect(first).toHaveValue("00:00:1");

  await page.getByRole("button", { name: "Generate audio" }).click();

  await expect(first).toHaveAttribute("aria-invalid", "true");
  const error = page.locator(".field", { has: first }).locator(".error");
  await expect(error).toContainText("HH:MM:SS");
  await expect(first).toHaveAttribute("aria-describedby", new RegExp(`${await error.getAttribute("id")}$`));
});
