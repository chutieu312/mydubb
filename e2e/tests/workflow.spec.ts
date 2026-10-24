import { expect, test } from "@playwright/test";

import { accessCode, fillJobForm, signIn } from "./helpers";

test("rejects a wrong Access Code and keeps the session cookie away from JavaScript", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Development mock mode.")).toBeVisible();

  await page.getByLabel("Access Code").fill("definitely-not-the-code");
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByText("The Access Code is incorrect.")).toBeVisible();

  await signIn(page);
  const visibleToScripts = await page.evaluate(
    () => document.cookie + JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
  );
  expect(visibleToScripts).not.toContain("mydubb_session");
  expect(visibleToScripts).not.toContain(accessCode());
});

test("shows server-side validation errors", async ({ page }) => {
  await signIn(page);

  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByText("Transcript must contain English text.")).toBeVisible();

  await fillJobForm(page, { transcript: "Hello.", first: "00:05:00", last: "00:01:00" });
  const response = page.waitForResponse((r) => r.url().endsWith("/api/jobs"));
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await response).status()).toBe(422);
  await expect(page.getByText(/must be later than First Sentence Start Time/)).toBeVisible();
});

test("completes a mock job: stages, text-only result, playback, download", async ({ page }) => {
  await signIn(page);

  const statuses: string[] = [];
  page.on("response", async (response) => {
    if (/\/api\/jobs\/[^/]+$/.test(new URL(response.url()).pathname)) {
      statuses.push((await response.json()).status);
    }
  });

  const transcript = [
    '<img src=x onerror="window.__xss = 1"> Spring Boot uses Dependency Injection.',
    "10:30 is our meeting time.",
    "16:30 is the aspect ratio.",
  ].join("\n");
  await fillJobForm(page, { transcript, voice: "Emma Multilingual" });
  await expect(page.getByLabel("Audio length preview").locator(".length-value")).toHaveText(
    "00:06:00",
  );

  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  const job = await (await created).json();
  expect((await created).status()).toBe(202);
  expect(job.target_duration_seconds).toBe(360);
  expect(job.speed).toBe(1); // the default: 1x

  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible();
  expect(statuses.some((s) => ["translating", "synthesizing", "processing"].includes(s))).toBe(
    true,
  );
  expect(statuses.at(-1)).toBe("completed");

  // Result text is rendered as text; timestamp-like spoken content is preserved in order.
  const translation = page.locator(".translation");
  await expect(translation).toContainText('<img src=x onerror="window.__xss = 1">');
  await expect(translation).toContainText(
    "(VI mock) 10:30 is our meeting time.\n(VI mock) 16:30 is the aspect ratio.",
  );
  await expect(translation.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();

  // Mock mode stays recognisable: the placeholder translation and the fixture are flagged.
  await expect(page.locator(".chip", { hasText: "Illustrative mock" })).toBeVisible();
  await expect(page.locator(".callout", { hasText: "NOT generated from your transcript" })).toBeVisible();
  await expect(page.getByText("Mock sample ready")).toBeVisible();
  // The server's own notes are in Audio details, closed until opened.
  const note = page.locator(".notes li", { hasText: "NOT generated from your transcript" });
  await expect(note).toBeHidden();
  await page.getByText("Audio details").click();
  await expect(note).toBeVisible();

  // Native audio player loads the MP3.
  const duration = await page
    .locator("audio")
    .evaluate(
      (audio: HTMLAudioElement) =>
        new Promise<number>((resolve) =>
          audio.readyState >= 1
            ? resolve(audio.duration)
            : audio.addEventListener("loadedmetadata", () => resolve(audio.duration)),
        ),
    );
  expect(duration).toBeGreaterThan(0);

  // Download delivers an MP3 attachment.
  const downloadUrl = await page.getByRole("link", { name: "Download MP3" }).getAttribute("href");
  const file = await page.request.get(downloadUrl!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("audio/mpeg");
  expect(file.headers()["content-disposition"]).toMatch(/^attachment; filename=.*\.mp3/);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Download MP3" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mp3$/);

  // Polling stops once the job is terminal.
  const pollsAtCompletion = statuses.length;
  await page.waitForTimeout(3_000);
  expect(statuses.length).toBe(pollsAtCompletion);
});

test("the chosen audio speed is previewed, submitted and kept with the job", async ({ page }) => {
  await signIn(page);
  await fillJobForm(page, { transcript: "Spring Boot uses JSON.", first: "00:00:05", last: "00:00:25" });

  const speeds = page.getByRole("group", { name: "Audio speed" }).getByRole("radio");
  await expect(speeds).toHaveCount(7);
  await expect(page.getByLabel("1x", { exact: true })).toBeChecked();

  const length = page.getByLabel("Audio length preview").locator(".length-value");
  await expect(length).toHaveText("00:00:20");
  await page.getByLabel("0.75x", { exact: true }).check();
  await expect(length).toHaveText("00:00:26.67");
  await page.getByLabel("1.25x", { exact: true }).check();
  await expect(length).toHaveText("00:00:16");

  // Keyboard: arrow keys move the choice within the group.
  await page.getByLabel("1.25x", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("1.5x", { exact: true })).toBeChecked();
  await page.getByLabel("1.25x", { exact: true }).check();

  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  const job = await (await created).json();
  expect(job.speed).toBe(1.25);
  expect(job.baseline_duration_seconds).toBe(20);
  expect(job.output_duration_seconds).toBe(16);

  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible();
  // Changing the form afterwards does not change what the finished job says it used.
  await page.getByLabel("2x", { exact: true }).check();
  await expect(page.getByText(/Speed 1\.25x · Planned audio length 00:00:16/)).toBeVisible();
  // Mock audio is a fixture: the selection is recorded but the file is not claimed to be adjusted.
  await expect(page.getByLabel("Audio speed", { exact: true }).filter({ hasText: "Selected speed 1.25x" })).toBeVisible();
  await expect(page.locator(".callout", { hasText: "This audio was not adjusted" })).toBeVisible();
  const player = page.locator("audio");
  expect(await player.evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(1);
});

test("layout fits the viewport without horizontal scrolling", async ({ page }) => {
  await signIn(page);
  const speedBoxes = page.getByRole("group", { name: "Audio speed" }).locator(".speed-option span");
  const viewport = page.viewportSize()!.width;
  for (let i = 0; i < 7; i++) {
    const box = (await speedBoxes.nth(i).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Key controls fit horizontally (vertical scrolling is expected on phones).
  const viewportWidth = page.viewportSize()!.width;
  for (const control of [
    page.getByLabel("English Transcript"),
    page.getByLabel("Last Sentence Start Time"),
    page.getByRole("button", { name: "Generate audio" }),
  ]) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  }
});
