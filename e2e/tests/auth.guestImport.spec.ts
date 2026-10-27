import { randomInt } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { escapes, overflow } from "./authHelpers";

// A guest imports YouTube captions (YOUTUBE_IMPORT_PROVIDER=mock on this stack: fixed captions,
// no Supadata call) with an import quota of its own, next to the audio jobs. Each test sends its
// own client address in the stack's CLIENT_IP_HEADER, so tests never share a network quota.

const IP_HEADER = "x-e2e-client-ip";
const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const FIXTURE = [
  "0:00.480",
  "Welcome back. Today we look at gradient descent.",
  "0:02.960",
  "It minimizes the loss function",
  "0:05.100",
  "of a neural network, step by step.",
  "0:05.100",
  "[Music]",
  "0:09.250",
  "Spring Boot's REST API returns JSON, naïve café style.",
].join("\n");

const banner = (page: Page) => page.getByRole("region", { name: "Guest mode" });
const transcript = (page: Page) => page.getByLabel("English Transcript");

async function startGuest(page: Page) {
  await page.setExtraHTTPHeaders({
    [IP_HEADER]: `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Try as guest" }).click();
  await expect(banner(page)).toBeVisible();
  await page.getByRole("radio", { name: "YouTube URL" }).click();
}

async function importLink(page: Page) {
  await page.getByLabel("YouTube video link").fill(LINK);
  await page.getByRole("button", { name: "Import transcript" }).click();
}

test("a guest imports captions, edits them and generates audio; the two counts stay apart", async ({
  page,
}) => {
  await startGuest(page);
  await expect(banner(page)).toContainText("5 audio jobs left");
  await expect(banner(page)).toContainText("5 YouTube imports left");
  await expect(page.locator("#youtube-guest-limits")).toContainText(
    "5 guest imports left, counted apart from your audio jobs",
  );

  const sent: string[] = [];
  page.on("request", (r) => sent.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await importLink(page);
  await expect(transcript(page)).toHaveValue(FIXTURE);
  await expect(page.getByLabel("Last Sentence Start Time")).toHaveValue("00:00:09");
  await expect(banner(page)).toContainText("4 YouTube imports left");
  await expect(banner(page)).toContainText("5 audio jobs left");
  expect(sent.filter((s) => s === "POST /api/transcripts/youtube")).toHaveLength(1);

  // The job uses the edited text (timed: the imported transcript keeps its timestamps).
  const edited = FIXTURE.replace("Welcome back.", "Welcome back, everyone.");
  await transcript(page).fill(edited);
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  const job = await created;
  expect(job.status()).toBe(202);
  expect(job.request().postDataJSON()).toMatchObject({ transcript: edited, timing_mode: "timed" });
  await expect(page.getByRole("heading", { name: "Your audio" })).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toContainText("4 audio jobs left");
  await expect(banner(page)).toContainText("4 YouTube imports left");

  // A reload restores both counts and imports nothing.
  await page.reload();
  await expect(banner(page)).toContainText("4 YouTube imports left");
  expect(sent.filter((s) => s === "POST /api/transcripts/youtube")).toHaveLength(1);
});

test("the sixth import of a guest session is refused; pasting still works", async ({ page }) => {
  test.setTimeout(120_000);
  await startGuest(page);
  for (let index = 0; index < 5; index += 1) {
    if (index > 0) {
      // The form has the previous import: confirm replacing it.
      await importLink(page);
      await page.getByRole("button", { name: "Replace and import" }).click();
    } else {
      await importLink(page);
    }
    const left = 4 - index;
    await expect(banner(page)).toContainText(
      `${left} YouTube ${left === 1 ? "import" : "imports"} left`,
    );
  }
  await expect(banner(page)).toContainText("This guest session has used all 5 of its YouTube imports");

  await importLink(page);
  await page.getByRole("button", { name: "Replace and import" }).click();
  await expect(page.getByRole("alert")).toContainText("used all 5 of its YouTube imports");
  await expect(transcript(page)).toHaveValue(FIXTURE); // unchanged
  await expect(banner(page)).toContainText("5 audio jobs left");

  await page.getByRole("radio", { name: "Paste transcript" }).click();
  await transcript(page).fill("A pasted transcript.");
  await expect(transcript(page)).toHaveValue("A pasted transcript.");
});

test("the guest import fits narrow screens", async ({ page }) => {
  await startGuest(page);
  await importLink(page);
  await expect(transcript(page)).toHaveValue(FIXTURE);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await overflow(page), `${width}px`).toBeLessThanOrEqual(0);
    expect(await escapes(page), `${width}px`).toEqual([]);
  }
});
