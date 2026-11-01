// The side panel as one page with three stacked blocks (English transcript, Translate to, Your
// audio), in the real extension build at side-panel widths, light and dark. Against the fake MyDubb
// server and the synthetic Udemy fixtures: local evidence only, not the real udemy.com or mydubb.com.

import type { Page, Worker } from "@playwright/test";

import { connectAccount, expect, fillTimes, openLecture, openPanel, playerSessions, sendTranscriptSelection, test } from "./harness";

const READY = "Ready. Press play when you want to listen.";
const WIDTHS = [320, 390, 430] as const;
const VI_1 = "ACID compliance nghĩa là gì?\nChữ A là viết tắt của Atomicity.\nToàn bộ giao dịch thành công hoặc toàn bộ giao dịch thất bại.";
const VI_2 = "Chữ C là Consistency: dữ liệu luôn hợp lệ trước và sau giao dịch.";

const noSideScroll = (panel: Page) => panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const video = (page: Page) => page.evaluate(() => window.fixture.state()!);
const floating = (page: Page) => page.getByRole("region", { name: "MyDubb audio player" });
const sessionOf = async (worker: Worker, tabId: number) => (await playerSessions(worker)).find((s) => s.tabId === tabId) ?? null;

/** Full-page screenshots at each width, light then dark; no width scrolls sideways. */
async function shoot(panel: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await panel.emulateMedia({ colorScheme: scheme });
    for (const width of WIDTHS) {
      await panel.setViewportSize({ width, height: 900 });
      expect(await noSideScroll(panel), `${name} at ${width} px (${scheme})`).toBe(true);
      await panel.screenshot({ path: test.info().outputPath(`${name}-${width}-${scheme}.png`), fullPage: true });
    }
  }
  await panel.emulateMedia({ colorScheme: "light" });
  await panel.setViewportSize({ width: 390, height: 900 });
}

test("one page: the three blocks in order, no tabs; the translation of the loaded audio before Play", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(90_000);
  const { page, tabId } = await openLecture(context, worker, 801);
  const panel = await openPanel(context, extensionId, tabId);
  await panel.setViewportSize({ width: 390, height: 900 });
  await expect(panel.getByRole("tablist")).toHaveCount(0);
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(["English transcript", "Translate to", /^Your audio/]);
  await expect(panel.getByText(/No audio yet/)).toBeVisible();
  await shoot(panel, "empty");

  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  // The video row ("Video", not "Udemy video") sits between the transcript and the start times.
  const video = panel.getByRole("group", { name: "Video", exact: true });
  await expect(video).toBeVisible();
  await expect(panel.locator("#time-duration")).toHaveText("0:30");
  const order = await panel.evaluate(() =>
    ["transcript", "video-box", "first-start", "target-language", "speed", "generate", "player-section"].every((id, i, ids) => {
      if (i === 0) return true;
      const before = document.getElementById(ids[i - 1]!)!;
      return !!(before.compareDocumentPosition(document.getElementById(id)!) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  );
  expect(order).toBe(true);
  // Keyboard: the speeds are one radio group (arrow keys move the choice).
  await panel.getByRole("radio", { name: "1x", exact: true }).focus();
  await panel.keyboard.press("ArrowRight");
  await expect(panel.getByRole("radio", { name: "1.25x", exact: true })).toBeChecked();
  await panel.getByRole("radio", { name: "1.5x", exact: true }).check();
  await expect(panel.locator("#length-summary strong")).toHaveText("00:04:00");
  await shoot(panel, "form");

  mydubb.translations["job-1"] = VI_1;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible({ timeout: 20_000 });
  // Nothing plays by itself; the translation is shown (not in a closed group) before Play.
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(true);
  const translation = panel.locator("#translation");
  await expect(translation).toBeVisible();
  await expect(translation).toHaveText(VI_1);
  await expect(translation).toHaveAttribute("lang", "vi");
  await expect(panel.locator("#translation-heading")).toHaveText("Translation · Vietnamese");
  const before = await panel.evaluate(
    () => !!(document.getElementById("translation")!.compareDocumentPosition(document.getElementById("player-play")!) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
  expect(before).toBe(true);
  const picked = await panel.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("translation")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(picked).toBe(VI_1);
  await panel.evaluate(() => document.getSelection()!.removeAllRanges());
  await expect(panel.locator("#sync-status")).toHaveText(/^OFF$|^Sync unavailable/);
  await shoot(panel, "audio");
});

test("a new result replaces the playing, synced audio by itself: both paused, the video at the new start, Sync OFF", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(120_000);
  const { page, tabId } = await openLecture(context, worker, 802, "?seconds=120");
  const panel = await openPanel(context, extensionId, tabId);
  await panel.setViewportSize({ width: 390, height: 900 });
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  mydubb.translations["job-1"] = VI_1;
  mydubb.translations["job-2"] = VI_2;
  // 00:00:10 → 00:00:56 at 1.5x: the fake MP3 (30.563 s) fits, so Sync is available.
  await panel.getByLabel("First sentence starts").fill("000010");
  await panel.getByLabel("Last sentence starts").fill("000056");
  await panel.getByRole("radio", { name: "1.5x", exact: true }).check();
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible({ timeout: 20_000 });
  // Loaded: both paused, the video at the first sentence start, the MP3 at its beginning.
  await expect(panel.locator("#video-place")).toHaveText("Video paused at 0:10, where this audio starts.");
  expect(await video(page)).toMatchObject({ paused: true, currentTime: 10 });
  expect(await sessionOf(worker, tabId)).toMatchObject({ paused: true, currentTime: 0 });
  await expect(panel.locator("#sync-status")).toHaveText("OFF");

  // Sync ON and playing.
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Paused");
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing");
  await expect.poll(async () => (await video(page)).muted).toBe(true);

  // Editing the form and scrolling while it plays: playback goes on, nothing is asked of MyDubb.
  const requests = mydubb.requests.length;
  await panel.getByLabel("First sentence starts").fill("000113");
  await panel.getByLabel("Last sentence starts").fill("000159");
  await panel.mouse.wheel(0, 600);
  await panel.mouse.wheel(0, -600);
  const at = (await sessionOf(worker, tabId))!.currentTime;
  await panel.waitForTimeout(800);
  expect((await sessionOf(worker, tabId))!.currentTime).toBeGreaterThan(at);
  expect(mydubb.requests.length).toBe(requests);

  // A second job runs: the first audio keeps playing, synced, with its own translation and facts.
  mydubb.advance = false;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText("Queued…")).toBeVisible();
  await expect(panel.locator("#job-note")).toBeVisible();
  await expect(panel.locator("#translation")).toHaveText(VI_1);
  await expect(panel.locator("#player-info")).toContainText("00:00:10 → 00:00:56");
  await expect(panel.locator("#player-info")).not.toContainText("00:01:13");
  expect((await sessionOf(worker, tabId))!.paused).toBe(false);
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing");
  await panel.getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(true);
  await shoot(panel, "new-job-running");

  // Its result arrives: loaded by itself, both paused, the video at 1:13 with its sound and speed
  // back, the MP3 at its beginning, Sync OFF; nothing plays.
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  mydubb.complete("job-2");
  mydubb.advance = true;
  await expect(panel.locator("#translation")).toHaveText(VI_2, { timeout: 20_000 });
  await expect(panel.locator("#video-place")).toHaveText("Video paused at 1:13, where this audio starts.");
  await expect(panel.locator("#player-info")).toContainText("00:01:13 → 00:01:59");
  await expect(panel.locator("#sync-status")).toHaveText("OFF");
  await expect(panel.locator("#job-note")).toBeHidden();
  await expect(panel.getByRole("button", { name: "Use new audio" })).toHaveCount(0);
  const loaded = (await sessionOf(worker, tabId))!;
  expect(loaded).toMatchObject({ paused: true });
  expect(loaded.currentTime).toBeLessThan(0.1);
  expect(await video(page)).toMatchObject({ paused: true, currentTime: 73, muted: false, rate: 1 });
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);

  // The floating player controls the same audio, with the same facts.
  await panel.getByRole("button", { name: "Show floating player" }).click();
  await expect(floating(page)).toContainText("Vietnamese · Andrew Multilingual · 1.5x · 00:01:13 → 00:01:59");

  // Reopening the panel is not loading again: playback, position and the video are left alone.
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.currentTime ?? 0).toBeGreaterThan(0.5);
  await panel.close();
  const reopened = await openPanel(context, extensionId, tabId);
  await expect(reopened.locator("#translation")).toHaveText(VI_2);
  await expect(reopened.getByRole("button", { name: "Pause MyDubb audio" })).toBeVisible();
  await reopened.waitForTimeout(500);
  expect((await sessionOf(worker, tabId))!.paused).toBe(false);
  expect((await sessionOf(worker, tabId))!.currentTime).toBeGreaterThan(0.5);
  expect((await video(page)).currentTime).toBe(73);
  await expect(reopened.locator("#video-place")).toHaveText("");
  expect(mydubb.gets("/api/jobs/job-2/result/audio")).toHaveLength(1);
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);
});

test("a start the video cannot reach is reported, and the video is not moved", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 803);
  const panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  // The fixture video is 30 s long; this audio starts at 1:00.
  await panel.getByLabel("First sentence starts").fill("000100");
  await panel.getByLabel("Last sentence starts").fill("000140");
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("#video-place")).toHaveText("The video was not moved to 1:00: That time is outside the video.");
  expect(await video(page)).toMatchObject({ currentTime: 0 });
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(true);
});
