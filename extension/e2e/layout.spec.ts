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
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);
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

test("audio playing, then a new result: the earlier audio and its translation stay until Use new audio", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(90_000);
  const { page, tabId } = await openLecture(context, worker, 802);
  const panel = await openPanel(context, extensionId, tabId);
  await panel.setViewportSize({ width: 390, height: 900 });
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  mydubb.translations["job-1"] = VI_1;
  mydubb.translations["job-2"] = VI_2;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible({ timeout: 20_000 });
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  await expect(panel.locator("#player-state")).toHaveText("Playing");

  // Editing the form and scrolling while it plays: playback goes on, nothing is asked of MyDubb.
  const requests = mydubb.requests.length;
  await panel.getByLabel("Last sentence starts").fill("000700");
  await panel.getByRole("radio", { name: "2x", exact: true }).check();
  await panel.mouse.wheel(0, 600);
  await panel.mouse.wheel(0, -600);
  const at = (await sessionOf(worker, tabId))!.currentTime;
  await panel.waitForTimeout(800);
  const playing = (await sessionOf(worker, tabId))!;
  expect(playing.paused).toBe(false);
  expect(playing.currentTime).toBeGreaterThan(at);
  expect(mydubb.requests.length).toBe(requests);

  // A second job finishes while the first audio plays: it waits beside it, nothing is replaced.
  await panel.getByRole("button", { name: "Generate audio" }).click();
  const callout = panel.locator("#result-switch");
  await expect(callout).toBeVisible({ timeout: 20_000 });
  await expect(callout.locator("#result-switch-title")).toHaveText("New audio ready");
  await expect(callout).toContainText("2x");
  await expect(panel.locator("#player-badge")).toHaveText("Earlier result");
  await expect(panel.locator("#player-info")).toContainText("1x");
  await expect(panel.locator("#translation")).toHaveText(VI_1);
  expect((await sessionOf(worker, tabId))!.paused).toBe(false);
  expect(mydubb.gets("/api/jobs/job-2/result/audio")).toHaveLength(0);
  await panel.getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(true);
  await shoot(panel, "earlier-and-new");

  // Use new audio: audio, translation, details and source move together; nothing plays.
  await callout.getByRole("button", { name: "Use new audio" }).click();
  await expect(callout).toBeHidden({ timeout: 20_000 });
  await expect(panel.locator("#translation")).toHaveText(VI_2);
  await expect(panel.locator("#player-info")).toContainText("2x");
  await expect(panel.locator("#player-info")).toContainText("00:00:10 → 00:07:00");
  await expect(panel.locator("#player-badge")).toBeHidden();
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);

  // Reopened: the same session and its translation; no download, no job.
  await panel.close();
  const reopened = await openPanel(context, extensionId, tabId);
  await expect(reopened.locator("#translation")).toHaveText(VI_2);
  expect(mydubb.gets("/api/jobs/job-2/result/audio")).toHaveLength(1);
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);
});
