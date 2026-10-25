import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

// A timestamped (YouTube-style) transcript in a real browser, against the mock stack: the start
// times are filled from the captions, the user can change them, the job is sent as timed and the
// result says that caption timing is estimated. Audio placement itself is covered by the backend
// tests with FFmpeg (the mock stack returns a fixture).

const YOUTUBE = [
  "0:00",
  "Generally, if if somebody's trying to",
  "0:01",
  "make a company work, they should expect",
  "0:03",
  "to grind super hard. Uh except that",
  "0:05",
  "there's like some meaningful chance of",
  "0:06",
  "failure. I could not make a spaceship by",
  "0:08",
  "myself, but but uh with a collection of",
  "0:11",
  "humans, uh we can make spaceships. It's",
].join("\n");

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("a timestamped transcript fills the start times and runs as a timed job", async ({ page }) => {
  await page.getByLabel("English Transcript").fill(YOUTUBE);

  const first = page.getByLabel("First Sentence Start Time");
  const last = page.getByLabel("Last Sentence Start Time");
  await expect(first).toHaveValue("00:00:00");
  await expect(last).toHaveValue("00:00:11");
  const panel = page.getByLabel("Transcript timing");
  await expect(panel).toContainText("Timestamps detected: 7 captions from 0:00 to 0:11");
  await expect(panel).toContainText("some sentences may be grouped together");

  // An edit stays, and is explained; nothing overflows sideways on a phone.
  await last.fill("00:00:22");
  await expect(panel).toContainText("caption timing is scaled to 00:00:22");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Use the transcript times" }).click();
  await expect(last).toHaveValue("00:00:11");

  const request = page.waitForRequest(
    (r) => r.url().endsWith("/api/jobs") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await request).postDataJSON()).toMatchObject({
    timing_mode: "timed",
    first_sentence_start: "00:00:00",
    last_sentence_start: "00:00:11",
  });

  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Transcript timing").last()).toContainText(
    "Caption timing is estimated",
  );
});

test("timestamps that go backwards are explained, and plain text stays possible", async ({
  page,
}) => {
  await page.getByLabel("English Transcript").fill("0:00\nOne.\n0:05\nTwo.\n0:03\nThree.");
  await expect(page.getByText(/The timestamps cannot be used/)).toBeVisible();
  await expect(page.getByLabel("First Sentence Start Time")).toHaveValue("");

  await page.getByLabel(/Ignore the timestamps/).check();
  await expect(page.getByText(/The timestamps cannot be used/)).toBeHidden();
});
