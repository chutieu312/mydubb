// Story 3 in the real extension build: the MyDubb audio plays in the offscreen document and is
// controlled from the side panel and from a floating player on the (fixture) Udemy page. Real MP3
// playback in Playwright's Chromium, against the fake MyDubb server (https://mydubb.test) and the
// synthetic Udemy fixtures. Local evidence only: not the real udemy.com or mydubb.com. Autoplay
// is allowed by the browser flag of harness.ts, so Chrome's autoplay blocking is not exercised here
// (unit-tested in offscreen/hub.test.ts).

import type { BrowserContext, Page, Worker } from "@playwright/test";

import {
  connectAccount,
  disconnect,
  expect,
  fillTimes,
  hasPlayerDocument,
  lectureUrl,
  openLecture,
  openPanel,
  playerSessions,
  sendTranscriptSelection,
  sessionGet,
  tabIdFor,
  test,
  type FakeMyDubb,
} from "./harness";

const READY = "Ready. Press play when you want to listen.";

async function sessionOf(worker: Worker, tabId: number) {
  return (await playerSessions(worker)).find((s) => s.tabId === tabId) ?? null;
}

/** A lecture tab with a generated result whose audio is loaded (paused) in the player. */
async function readyResult(
  context: BrowserContext,
  worker: Worker,
  extensionId: string,
  mydubb: FakeMyDubb,
  lectureId: number,
  speed = "1",
) {
  const { page, tabId } = await openLecture(context, worker, lectureId);
  const panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await expect(panel.getByText(/^(Connected as|Not connected)/)).toBeVisible();
  if (await panel.getByRole("button", { name: "Connect MyDubb" }).isVisible()) await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  await panel.getByRole("radio", { name: `${speed}x`, exact: true }).check();
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.duration ?? 0).toBeGreaterThan(25);
  return { page, tabId, panel };
}

const floating = (page: Page) => page.getByRole("region", { name: "MyDubb audio player" });
const playing = async (worker: Worker) => (await playerSessions(worker)).filter((s) => !s.paused);

test("generate, show the floating player and keep listening on the page with the panel closed", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId, panel } = await readyResult(context, worker, extensionId, mydubb, 501);
  // Nothing on the page until the user asks, and nothing plays by itself.
  await expect(floating(page)).toHaveCount(0);
  expect((await sessionOf(worker, tabId))?.paused).toBe(true);

  await panel.getByRole("button", { name: "Show floating player" }).click();
  const player = floating(page);
  await expect(player).toBeVisible();
  await expect(player).toContainText("MyDubb");
  // The choices the file was made with, and its length.
  await expect(player).toContainText("Vietnamese · Andrew Multilingual · 1x");
  await expect(player).toContainText("0:00 / 0:30");
  expect((await sessionOf(worker, tabId))?.paused).toBe(true);

  await player.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  await expect(panel.getByRole("button", { name: "Pause MyDubb audio" })).toBeVisible();
  expect((await sessionOf(worker, tabId))?.rate).toBe(1);

  // The panel closes; the audio does not stop and the floating player still drives it.
  await panel.close();
  const before = (await sessionOf(worker, tabId))!.currentTime;
  await page.waitForTimeout(1200);
  const after = (await sessionOf(worker, tabId))!;
  expect(after.paused).toBe(false);
  expect(after.currentTime).toBeGreaterThan(before + 0.5);
  await expect(player).toContainText(/0:0[1-9] \/ 0:30/);
  await player.getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(true);

  // The page gets display state only: no token, account, job, audio address or <audio> element.
  const auth = (await sessionGet(worker, "auth")) as { token: string };
  const shown = await player.evaluate((el) => (el.getRootNode() as ShadowRoot).innerHTML);
  for (const secret of [auth.token, "blob:", "job-1", "lan@example.com", "/api/"]) expect(shown).not.toContain(secret);
  expect(await page.content()).not.toContain(auth.token);
  expect(await page.evaluate(() => document.querySelectorAll("audio").length)).toBe(0);
  // The Udemy video was never touched by the MyDubb player.
  expect(await page.evaluate(() => window.fixture.state())).toMatchObject({ paused: true, muted: false, volume: 1, rate: 1 });
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
});

test("the handoff from the panel keeps the position and Play/Pause; one audio only", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId, panel } = await readyResult(context, worker, extensionId, mydubb, 502);
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.currentTime ?? 0).toBeGreaterThan(1.5);
  await panel.getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(true);
  const pausedAt = (await sessionOf(worker, tabId))!.currentTime;

  // Paused stays paused, at the same place.
  await panel.getByRole("button", { name: "Show floating player" }).click();
  const player = floating(page);
  await expect(player.getByRole("button", { name: "Play MyDubb audio" })).toBeVisible();
  expect((await sessionOf(worker, tabId))!.currentTime).toBeCloseTo(pausedAt, 1);

  // Playing stays playing: hide and show it again while it plays; nothing restarts from 0.
  await player.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  await panel.getByRole("button", { name: "Hide floating player" }).click();
  await expect(player).toHaveCount(0);
  await panel.getByRole("button", { name: "Show floating player" }).click();
  await expect(player.getByRole("button", { name: "Pause MyDubb audio" })).toBeVisible();
  const session = (await sessionOf(worker, tabId))!;
  expect(session.paused).toBe(false);
  expect(session.currentTime).toBeGreaterThanOrEqual(pausedAt);
  expect(await playing(worker)).toHaveLength(1);
  expect(session.audioElements).toBe(1);
  expect(await panel.locator("audio").count()).toBe(0);
});

test("collapse, drag by the handle only, stay in the viewport, close and reopen from the panel", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId, panel } = await readyResult(context, worker, extensionId, mydubb, 503);
  await page.setViewportSize({ width: 1000, height: 700 });
  await panel.getByRole("button", { name: "Show floating player" }).click();
  const player = floating(page);
  await player.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);

  // Collapsing hides the controls only; the audio plays on.
  await player.getByRole("button", { name: "Collapse the MyDubb player" }).click();
  await expect(player.getByRole("slider", { name: "Position in the MyDubb audio" })).toBeHidden();
  expect((await sessionOf(worker, tabId))?.paused).toBe(false);
  await player.getByRole("button", { name: "Expand the MyDubb player" }).click();
  await expect(player.getByRole("slider", { name: "Position in the MyDubb audio" })).toBeVisible();

  // Dragging the handle moves it; pressing a button does not.
  const start = (await player.boundingBox())!;
  const handle = player.getByText("MyDubb", { exact: true });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + 10, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 290, grip.y + grip.height / 2 + 200, { steps: 5 });
  await page.mouse.up();
  const moved = (await player.boundingBox())!;
  expect(moved.x).toBeCloseTo(start.x - 300, -1);
  expect(moved.y).toBeCloseTo(start.y + 200, -1);
  await player.getByRole("button", { name: "Forward 5 seconds in the MyDubb audio" }).click();
  expect((await player.boundingBox())!.x).toBeCloseTo(moved.x, 0);
  // The keyboard moves it too.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect((await player.boundingBox())!.x).toBeCloseTo(moved.x - 20, 0);

  // Dragged past the edge, or the window made smaller: it stays fully inside.
  await page.mouse.move(moved.x + 20, moved.y + 12);
  await page.mouse.down();
  await page.mouse.move(5000, 5000, { steps: 3 });
  await page.mouse.up();
  let box = (await player.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(1000);
  expect(box.y + box.height).toBeLessThanOrEqual(700);
  await page.setViewportSize({ width: 480, height: 360 });
  await expect.poll(async () => {
    const b = (await player.boundingBox())!;
    return b.x >= 0 && b.y >= 0 && b.x + b.width <= 480 && b.y + b.height <= 360;
  }).toBe(true);
  box = (await player.boundingBox())!;
  // Small: it does not cover most of the video area.
  expect(box.width * box.height).toBeLessThan(480 * 360 * 0.4);

  // Close pauses and hides; the job, the draft and the session stay, and the panel reopens it.
  await player.getByRole("button", { name: "Close the MyDubb player (pauses the audio)" }).click();
  await expect(player).toHaveCount(0);
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(true);
  expect(await sessionGet(worker, `job:${tabId}`)).not.toBeNull();
  expect(await sessionGet(worker, `draft:${tabId}`)).not.toBeNull();
  await panel.getByRole("button", { name: "Show floating player" }).click();
  await expect(player).toBeVisible();
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
});

test("seeking and ±5 s stay inside the audio; the rate is always 1x", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId, panel } = await readyResult(context, worker, extensionId, mydubb, 504, "1.5");
  await panel.getByRole("button", { name: "Show floating player" }).click();
  const player = floating(page);
  await expect(player).toContainText("1.5x");
  await player.getByRole("button", { name: "Back 5 seconds in the MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.currentTime).toBe(0);
  await player.getByRole("button", { name: "Forward 5 seconds in the MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.currentTime).toBeCloseTo(5, 1);
  const slider = player.getByRole("slider", { name: "Position in the MyDubb audio" });
  await slider.focus();
  await page.keyboard.press("End");
  const duration = (await sessionOf(worker, tabId))!.duration;
  await expect.poll(async () => (await sessionOf(worker, tabId))?.currentTime).toBeCloseTo(duration, 0);
  await player.getByRole("button", { name: "Forward 5 seconds in the MyDubb audio" }).click();
  await page.waitForTimeout(300);
  expect((await sessionOf(worker, tabId))!.currentTime).toBeLessThanOrEqual(duration);
  await panel.getByRole("button", { name: "Back 5 seconds in the MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.currentTime).toBeCloseTo(duration - 5, 0);
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  expect((await sessionOf(worker, tabId))!.rate).toBe(1);
});

test("a lecture change, a reload or closing the tab ends the session", async ({ context, worker, extensionId, mydubb }) => {
  // Lecture change with the panel closed: the content script still watches for the session.
  const a = await readyResult(context, worker, extensionId, mydubb, 505);
  await a.panel.getByRole("button", { name: "Show floating player" }).click();
  await floating(a.page).getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, a.tabId))?.paused).toBe(false);
  await a.panel.close();
  await a.page.evaluate(() => window.fixture.navigate(605));
  await expect.poll(() => sessionOf(worker, a.tabId)).toBeNull();
  await expect(floating(a.page)).toHaveCount(0);

  // Reload: nothing plays again by itself and nothing is generated.
  const b = await readyResult(context, worker, extensionId, mydubb, 506);
  await b.panel.getByRole("button", { name: "Show floating player" }).click();
  await floating(b.page).getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, b.tabId))?.paused).toBe(false);
  await b.page.reload();
  await expect.poll(() => sessionOf(worker, b.tabId)).toBeNull();
  await expect(floating(b.page)).toHaveCount(0);
  // The open panel offers to load the same result again (a download, never a new job).
  await expect(b.panel.getByText(/player was released/)).toBeVisible();
  await expect(b.panel.locator("#link-detail")).toHaveText("Connected to the lecture tab.");
  await b.panel.getByRole("button", { name: "Load audio" }).click();
  await expect(b.panel.getByText(READY)).toBeVisible();
  await expect.poll(async () => (await sessionOf(worker, b.tabId))?.paused).toBe(true);
  expect((await sessionOf(worker, b.tabId))!.currentTime).toBe(0);
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);

  // Closing the tab: its session goes, and with no session left the offscreen document closes.
  await b.panel.close();
  await b.page.close();
  await expect.poll(() => sessionOf(worker, b.tabId)).toBeNull();
  await expect.poll(() => hasPlayerDocument(worker), { timeout: 15_000 }).toBe(false);
});

test("two tabs: playing in B pauses A; each keeps its own position and result", async ({ context, worker, extensionId, mydubb }) => {
  const a = await readyResult(context, worker, extensionId, mydubb, 507);
  const b = await readyResult(context, worker, extensionId, mydubb, 607, "2");
  await a.panel.getByRole("button", { name: "Show floating player" }).click();
  await b.panel.getByRole("button", { name: "Show floating player" }).click();
  await expect(floating(a.page)).toContainText("1x");
  await expect(floating(b.page)).toContainText("2x");

  await floating(a.page).getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, a.tabId))?.currentTime ?? 0).toBeGreaterThan(1);
  await floating(b.page).getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, b.tabId))?.paused).toBe(false);
  const aState = (await sessionOf(worker, a.tabId))!;
  expect(aState.paused).toBe(true);
  expect(await playing(worker)).toHaveLength(1);
  await a.page.waitForTimeout(600);
  expect((await sessionOf(worker, a.tabId))!.currentTime).toBeCloseTo(aState.currentTime, 1);

  // A's controls drive A only.
  await floating(a.page).getByRole("button", { name: "Forward 5 seconds in the MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, a.tabId))?.currentTime).toBeCloseTo(aState.currentTime + 5, 0);
  expect((await sessionOf(worker, b.tabId))!.paused).toBe(false);
  expect((await sessionOf(worker, a.tabId))!.lessonKey).toBe("demo-course/507");
  expect((await sessionOf(worker, b.tabId))!.lessonKey).toBe("demo-course/607");
});

test("disconnecting ends every tab's playback, also where the panel is closed", async ({ context, worker, extensionId, mydubb }) => {
  const a = await readyResult(context, worker, extensionId, mydubb, 508);
  await a.panel.getByRole("button", { name: "Show floating player" }).click();
  await floating(a.page).getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, a.tabId))?.paused).toBe(false);
  await a.panel.close();

  const b = await openLecture(context, worker, 608);
  const panelB = await openPanel(context, extensionId, b.tabId);
  await disconnect(panelB);
  await expect.poll(() => sessionOf(worker, a.tabId)).toBeNull();
  await expect(floating(a.page)).toHaveCount(0);

  // Reopened, A's panel neither shows nor restores the old account's player.
  const panelA = await openPanel(context, extensionId, a.tabId);
  await expect(panelA.getByRole("button", { name: "Connect MyDubb" })).toBeVisible();
  await expect(panelA.locator("#player-section")).toBeHidden();
  await panelA.waitForTimeout(500);
  expect(await playerSessions(worker)).toEqual([]);
});

test("a stopped service worker neither stops nor duplicates the playback", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId, panel } = await readyResult(context, worker, extensionId, mydubb, 509);
  await panel.getByRole("button", { name: "Show floating player" }).click();
  await floating(page).getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  // Controls keep working from both sides; still one session and one <audio>.
  await floating(page).getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect(panel.getByRole("button", { name: "Play MyDubb audio" })).toBeVisible();
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect(floating(page).getByRole("button", { name: "Pause MyDubb audio" })).toBeVisible();
  const sessions = await playerSessions(panel);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ tabId, paused: false, audioElements: 1 });

  // Stopped again with this panel closed: a Disconnect elsewhere wakes the worker, which still
  // ends this tab's session.
  await panel.close();
  const pageCdp = await context.newCDPSession(page);
  await pageCdp.send("ServiceWorker.enable");
  await pageCdp.send("ServiceWorker.stopAllWorkers");
  // (The test's worker handle is gone with the stopped worker: an extension page finds the tab.)
  const probe = await openPanel(context, extensionId, -1);
  const otherPage = await context.newPage();
  await otherPage.goto(lectureUrl(609));
  let otherTab = -1;
  await expect.poll(async () => (otherTab = await tabIdFor(probe as unknown as Worker, "demo-course/609").catch(() => -1))).toBeGreaterThan(-1);
  const otherPanel = await openPanel(context, extensionId, otherTab);
  await disconnect(otherPanel);
  await expect(floating(page)).toHaveCount(0);
  await expect.poll(() => playerSessions(otherPanel)).toEqual([]);
});

test("an expired result is reported; trying again downloads, never generates", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 510);
  const panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  mydubb.audioAnswers = [410, 500];
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(/could not be loaded: This result has expired/)).toBeVisible();
  expect(await sessionOf(worker, tabId)).toBeNull();
  await panel.getByRole("button", { name: "Check again" }).click();
  await expect(panel.getByText(/could not be loaded/)).toBeVisible();
  await panel.getByRole("button", { name: "Check again" }).click();
  await expect(panel.getByText(READY)).toBeVisible();
  expect(mydubb.gets("/api/jobs/job-1/result/audio")).toHaveLength(3);
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
});

test("page scripts cannot drive the player", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId, panel } = await readyResult(context, worker, extensionId, mydubb, 511);
  await panel.getByRole("button", { name: "Show floating player" }).click();
  const play = floating(page).getByRole("button", { name: "Play MyDubb audio" });
  await expect(play).toBeVisible();
  // A synthetic click (what a page script can do) is ignored; so is window.postMessage.
  await play.dispatchEvent("click");
  await page.evaluate(() => window.postMessage({ type: "command", command: "play" }, "*"));
  await page.waitForTimeout(400);
  expect((await sessionOf(worker, tabId))?.paused).toBe(true);
  // The page's own world has no channel to the extension.
  expect(await page.evaluate(() => typeof (window as { chrome?: { runtime?: { connect?: unknown } } }).chrome?.runtime?.connect)).toBe("undefined");
});

test("a paused session outlives Chrome's 30 s silent-audio limit", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(90_000);
  const { page, tabId, panel } = await readyResult(context, worker, extensionId, mydubb, 512);
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.currentTime ?? 0).toBeGreaterThan(1);
  await panel.getByRole("button", { name: "Pause MyDubb audio" }).click();
  const pausedAt = (await sessionOf(worker, tabId))!.currentTime;
  await panel.close();
  await page.waitForTimeout(36_000);
  expect(await hasPlayerDocument(worker)).toBe(true);
  const kept = (await sessionOf(worker, tabId))!;
  expect(kept.paused).toBe(true);
  expect(kept.currentTime).toBeCloseTo(pausedAt, 1);
  const reopened = await openPanel(context, extensionId, tabId);
  await reopened.getByRole("button", { name: "Show floating player" }).click();
  await floating(page).getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  // Reopening the panel did not download again: it attached to the session.
  expect(mydubb.gets("/api/jobs/job-1/result/audio")).toHaveLength(1);
});
