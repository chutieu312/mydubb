import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers";

// The YouTube caption import against the real backend with YOUTUBE_IMPORT_PROVIDER=mock: fixed
// captions (backend/app/youtube_import/mock.py), no Supadata call. Covers what only the real
// stack shows: the endpoint's session/CSRF handling, the form being filled, and a job created
// from the edited text going through today's plain transcript cleaning.

const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s";
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

const transcript = (page: Page) => page.getByLabel("English Transcript");
const link = (page: Page) => page.getByLabel("YouTube video link");

async function openImport(page: Page) {
  await signIn(page);
  // The radio covers its label box (like the speed choices), so the radio is what gets clicked.
  await page.getByRole("radio", { name: "YouTube URL" }).click();
  await expect(link(page)).toBeVisible();
}

test("imports captions into the form; the edited text is what the job uses", async ({ page }) => {
  await openImport(page);
  const sent: string[] = [];
  page.on("request", (request) => sent.push(`${request.method()} ${new URL(request.url()).pathname}`));

  await link(page).fill(LINK);
  expect(sent).toEqual([]); // nothing is sent until the user asks
  await page.getByRole("button", { name: "Import transcript" }).click();
  await expect(page.getByRole("button", { name: "Importing…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Generate audio" })).toBeDisabled();

  await expect(transcript(page)).toHaveValue(FIXTURE);
  await expect(page.getByLabel("First Sentence Start Time")).toHaveValue("00:00:00");
  await expect(page.getByLabel("Last Sentence Start Time")).toHaveValue("00:00:09");
  await expect(page.getByText("Imported 5 English captions.", { exact: false })).toBeVisible();
  await expect(page.getByText("1 empty caption was left out.")).toBeVisible();
  expect(sent).toEqual(["POST /api/transcripts/youtube"]);

  const edited = FIXTURE.replace("Welcome back.", "Welcome back, everyone.");
  await transcript(page).fill(edited);
  // An imported transcript is read like a pasted timestamped one: timed mode.
  await expect(page.getByLabel("Transcript timing").first()).toContainText(
    "Timestamps detected",
  );
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  const response = await created;
  expect(response.request().postDataJSON()).toMatchObject({
    transcript: edited,
    timing_mode: "timed",
  });
  const job = await response.json();
  expect(job.target_duration_seconds).toBe(9);
  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible();

  // Timed mode reads the edited captions as sentences: every word, in order, no time read aloud.
  const translation = page.locator(".translation");
  await expect(translation).toContainText(
    [
      "(VI mock) Welcome back, everyone.",
      "(VI mock) Today we look at gradient descent.",
      "(VI mock) It minimizes the loss function of a neural network, step by step.",
      "(VI mock) [Music] Spring Boot's REST API returns JSON, naïve café style.",
    ].join("\n"),
  );
  await expect(translation).not.toContainText("0:00.480");
});

test("an imported transcript can still be processed as plain text", async ({ page }) => {
  await openImport(page);
  await link(page).fill(LINK);
  await page.getByRole("button", { name: "Import transcript" }).click();
  await expect(transcript(page)).toHaveValue(FIXTURE);

  await page.getByLabel(/Ignore the timestamps/).check();
  const created = page.waitForRequest(
    (r) => r.url().endsWith("/api/jobs") && r.method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await created).postDataJSON()).not.toHaveProperty("timing_mode");
  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible();

  // The plain cleaning drops the time lines and keeps every caption line in order.
  const translation = page.locator(".translation");
  await expect(translation).toContainText(
    [
      "(VI mock) Welcome back. Today we look at gradient descent.",
      "(VI mock) It minimizes the loss function",
      "(VI mock) of a neural network, step by step.",
      "(VI mock) [Music]",
      "(VI mock) Spring Boot's REST API returns JSON, naïve café style.",
    ].join("\n"),
  );
  await expect(translation).not.toContainText("0:00.480");
});

test("asks before replacing the form, and a failed import changes nothing", async ({ page }) => {
  await openImport(page);
  await transcript(page).fill("My own notes.");
  await link(page).fill("https://youtu.be/noEnglish00");
  await link(page).press("Enter");

  const question = page.getByRole("group", { name: /replaces the transcript/ });
  await expect(question).toBeVisible();
  await expect(question.getByRole("button", { name: "Replace and import" })).toBeFocused();
  await question.getByRole("button", { name: "Replace and import" }).click();

  await expect(page.getByRole("alert")).toContainText("This video has no English captions");
  await expect(page.getByRole("alert")).toContainText("Nothing in the form was changed.");
  await expect(transcript(page)).toHaveValue("My own notes.");
});

test("refuses a look-alike host on the link field", async ({ page }) => {
  await openImport(page);
  await link(page).fill("https://youtube.com.example.org/watch?v=dQw4w9WgXcQ");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/transcripts/youtube"));
  await page.getByRole("button", { name: "Import transcript" }).click();
  expect((await response).status()).toBe(422);
  await expect(link(page)).toHaveAttribute("aria-invalid", "true");
  await expect(transcript(page)).toHaveValue("");
});

for (const width of [320, 390]) {
  test(`the import fits ${width}px without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openImport(page);
    await link(page).fill(LINK);
    await page.getByRole("button", { name: "Import transcript" }).click();
    await expect(transcript(page)).toHaveValue(FIXTURE);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
