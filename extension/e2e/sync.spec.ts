// Story 4 in the real extension build: Sync with video. The MyDubb MP3 (a real 30 s MP3) plays in
// the offscreen document and the fixture lecture's <video> (a real silent WAV, decoded and played
// by Chromium) follows it at V = V0 + A x R. Against the fake MyDubb server and the synthetic Udemy
// fixtures: local evidence only, not the real udemy.com (whose player, buffering and watch progress
// are not reproduced here) or mydubb.com. Autoplay is allowed by the harness's browser flag.

import type { BrowserContext, Page, Worker } from "@playwright/test";

import {
  connectAccount,
  expect,
  openLecture,
  openPanel,
  playerSessions,
  sendTranscriptSelection,
  test,
  type FakeMyDubb,
} from "./harness";

const READY = "Ready. Press play when you want to listen.";

async function sessionOf(worker: Worker, tabId: number) {
  return (await playerSessions(worker)).find((s) => s.tabId === tabId) ?? null;
}

const video = (page: Page) => page.evaluate(() => window.fixture.state()!);
const floating = (page: Page) => page.getByRole("region", { name: "MyDubb audio player" });

/**
 * A lecture tab (60 s video) with a result loaded: plain mode 00:00:10 -> 00:00:56 (46 s) at 1.5x.
 * The fake's MP3 is 30.563 s (117 MPEG-2 frames, ten times), within tolerance of 46 / 1.5, so
 * R = 46 / 30.563 ≈ 1.505.
 */
async function plainResult(context: BrowserContext, worker: Worker, extensionId: string, mydubb: FakeMyDubb, lectureId: number) {
  const { page, tabId } = await openLecture(context, worker, lectureId, "?seconds=60");
  const panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await expect(panel.getByText(/^(Connected as|Not connected)/)).toBeVisible();
  if (await panel.getByRole("button", { name: "Connect MyDubb" }).isVisible()) await connectAccount(panel, mydubb, extensionId);
  await panel.getByLabel("First Sentence Start Time").fill("000010");
  await panel.getByLabel("Last Sentence Start Time").fill("000056");
  await panel.getByLabel("Audio speed").selectOption("1.5");
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.duration ?? 0).toBeGreaterThan(25);
  return { page, tabId, panel };
}

async function turnOnSync(panel: Page) {
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.getByText("Sync with video: ON · Paused")).toBeVisible();
}

/** Drift in MP3 seconds measured by the test itself: video and audio read back to back. */
async function measuredDrift(page: Page, worker: Worker, tabId: number, start: number, rate: number) {
  const v = (await video(page)).currentTime;
  const a = (await sessionOf(worker, tabId))!.currentTime;
  return (v - start) / rate - a;
}

test("plain job: turn Sync on, play both from the panel, measure drift, ±5 s, pause, turn off restores the video", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(90_000);
  const { page, tabId, panel } = await plainResult(context, worker, extensionId, mydubb, 601);
  // Off by default; nothing moved.
  await expect(panel.getByText("Sync with video: OFF")).toBeVisible();
  expect(await video(page)).toMatchObject({ paused: true, muted: false, rate: 1, currentTime: 0 });

  // The first time: what will happen, then a confirmation.
  await panel.getByRole("button", { name: "Sync with video" }).click();
  const preview = panel.locator("#sync-preview");
  await expect(preview).toContainText(/Video 0:10 → 0:56 \(46 s\), MP3 30\.56\d? s, video speed 1\.50\dx\./);
  await expect(preview).toContainText("The video is muted: the MyDubb audio replaces the spoken part. The timing is an estimate");
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByText("Sync with video: OFF")).toBeVisible();
  expect((await video(page)).muted).toBe(false);
  await turnOnSync(panel);

  // On: both paused, video muted, at R, at V0; nothing plays by itself.
  const session = (await sessionOf(worker, tabId))!;
  const rate = session.sync.rate!;
  expect(rate).toBeCloseTo(46 / session.duration, 6);
  expect(session.paused).toBe(true);
  expect(session.rate).toBe(1);
  let v = await video(page);
  expect(v).toMatchObject({ paused: true, muted: true, volume: 1 });
  expect(v.rate).toBeCloseTo(rate, 6);
  expect(v.currentTime).toBeCloseTo(10, 2);
  await page.waitForTimeout(500);
  expect((await video(page)).paused).toBe(true);

  // Play from the panel: both run; the audio stays at 1x.
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect(panel.getByText("Sync with video: ON · Playing")).toBeVisible();
  await expect.poll(async () => (await video(page)).paused).toBe(false);
  // Drift over 24 s of real playback (most of the MP3), measured by the test and by the coordinator.
  const drifts: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(1000);
    drifts.push(await measuredDrift(page, worker, tabId, 10, rate));
  }
  const s = (await sessionOf(worker, tabId))!;
  const maxMeasured = Math.max(...drifts.map(Math.abs));
  console.log(`plain sync drift: test max |d| = ${maxMeasured.toFixed(3)} s over ${drifts.length} samples; coordinator max |d| = ${s.drift.maxAbsDrift.toFixed(3)} s over ${s.drift.samples} samples, ${s.drift.corrections} corrections`);
  expect(s.rate).toBe(1);
  expect(s.drift.samples).toBeGreaterThanOrEqual(18);
  expect(s.drift.maxAbsDrift).toBeLessThan(0.3);
  expect(s.drift.corrections).toBe(0);
  expect(maxMeasured).toBeLessThan(0.3);

  // Pause from the panel pauses both.
  await panel.getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect(panel.getByText("Sync with video: ON · Paused")).toBeVisible();
  await expect.poll(async () => (await video(page)).paused).toBe(true);
  const a0 = (await sessionOf(worker, tabId))!.currentTime;
  // +5 s of MP3 moves the video by 5 x R.
  await panel.getByRole("button", { name: "Forward 5 seconds in the MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))!.currentTime).toBeCloseTo(a0 + 5, 1);
  await expect.poll(async () => (await video(page)).currentTime).toBeCloseTo(10 + (a0 + 5) * rate, 1);
  await panel.getByRole("button", { name: "Back 5 seconds in the MyDubb audio" }).click();
  await expect.poll(async () => (await video(page)).currentTime).toBeCloseTo(10 + a0 * rate, 1);
  expect((await video(page)).paused).toBe(true);
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);

  // Off: both paused, mute and rate given back; the audio keeps its position.
  await panel.getByRole("button", { name: "Turn off sync" }).click();
  await expect(panel.getByText("Sync with video: OFF")).toBeVisible();
  v = await video(page);
  expect(v).toMatchObject({ paused: true, muted: false, rate: 1, volume: 1 });
  // Turning it on again needs no explanation any more.
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await expect(panel.getByText("Sync with video: ON · Paused")).toBeVisible();
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
});

test("controls on the Udemy video: play, pause and seek inside the span move the audio; outside turns Sync off", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(60_000);
  const { page, tabId, panel } = await plainResult(context, worker, extensionId, mydubb, 602);
  await turnOnSync(panel);
  const rate = (await sessionOf(worker, tabId))!.sync.rate!;

  // Seek on the video while paused: the audio follows ((V - V0) / R), the video is not moved back.
  await page.evaluate(() => (window.fixture.videos()[0]!.currentTime = 40));
  await expect.poll(async () => (await sessionOf(worker, tabId))!.currentTime).toBeCloseTo(30 / rate, 1);
  await page.waitForTimeout(400);
  expect((await video(page)).currentTime).toBeCloseTo(40, 1);

  // Play on the video: the audio joins; pause on the video: the audio stops.
  await page.evaluate(() => window.fixture.videos()[0]!.play());
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(false);
  await expect(panel.getByText("Sync with video: ON · Playing")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(Math.abs(await measuredDrift(page, worker, tabId, 10, rate))).toBeLessThan(0.3);
  // Seek on the video while playing: the audio jumps with it, and keeps playing.
  await page.evaluate(() => (window.fixture.videos()[0]!.currentTime = 20));
  await expect.poll(async () => (await sessionOf(worker, tabId))!.currentTime).toBeLessThan(10 / rate + 1);
  await page.waitForTimeout(1500);
  expect((await sessionOf(worker, tabId))!.paused).toBe(false);
  expect(Math.abs(await measuredDrift(page, worker, tabId, 10, rate))).toBeLessThan(0.3);
  // One user seek gave one audio move, no seek war: the video went where the user put it.
  const s = (await sessionOf(worker, tabId))!;
  expect(s.drift.corrections).toBe(0);
  await page.evaluate(() => window.fixture.videos()[0]!.pause());
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(true);
  await expect(panel.getByText("Sync with video: ON · Paused")).toBeVisible();

  // Outside V0..V1: both paused, Sync off with a notice, the video stays where the user put it.
  await page.evaluate(() => (window.fixture.videos()[0]!.currentTime = 5));
  await expect(panel.getByText("Sync with video: OFF")).toBeVisible();
  await expect(panel.locator("#sync-notice")).toContainText("the video was moved outside 0:10–0:56");
  const v = await video(page);
  expect(v).toMatchObject({ paused: true, muted: false, rate: 1 });
  expect(v.currentTime).toBeCloseTo(5, 1);
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);
});

test("timed job with changed start times: V0/V1 from the captions, R differs from the speed", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 603, "?seconds=60");
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  // Captions 0:10.250 -> 0:40.250 (30 s of source); the fields fill as 00:00:10 -> 00:00:40.
  await panel.getByRole("textbox", { name: "Transcript selection" }).fill("0:10.250\nHello there.\n0:25.000\nThe middle part.\n0:40.250\nThe last line.");
  await expect(panel.getByLabel("Last Sentence Start Time")).toHaveValue("00:00:40");
  // The user changes the span to 46 s and picks 1.5x: the MP3 is about 46 / 1.5 s, and the video
  // covers its 30 s of captions in it, so R = 30 / 30.563 ≈ 0.98 (not 1.5).
  await panel.getByLabel("Last Sentence Start Time").fill("000056");
  await panel.getByLabel("Audio speed").selectOption("1.5");
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible();
  expect(mydubb.posts("/api/jobs")[0]!.body).toMatchObject({ timing_mode: "timed", speed: 1.5, last_sentence_start: "00:00:56" });
  // Edited after Generate: the job's own span is used, never the form.
  await panel.getByLabel("First Sentence Start Time").fill("000001");
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await expect(panel.locator("#sync-preview")).toContainText(/Video 0:10\.250 → 0:40\.250 \(30 s\), MP3 30\.56\d? s, video speed 0\.98\dx\./);
  await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.getByText("Sync with video: ON · Paused")).toBeVisible();
  const session = (await sessionOf(worker, tabId))!;
  expect(session.sync).toMatchObject({ start: 10.25, end: 40.25 });
  expect(session.sync.rate).toBeCloseTo(30 / session.duration, 6);
  const v = await video(page);
  expect(v.currentTime).toBeCloseTo(10.25, 2);
  expect(v.rate).toBeCloseTo(session.sync.rate!, 6);
});

test("a result whose MP3 does not fit its start times cannot be synced; it still plays on its own", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 604, "?seconds=60");
  const panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  // 360 s at 1x, but the fake's MP3 is 30 s (like mock audio, not fitted).
  await panel.getByLabel("First Sentence Start Time").fill("000010");
  await panel.getByLabel("Last Sentence Start Time").fill("000610");
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible();
  await expect(panel.locator("#sync-status")).toHaveText(/^Sync unavailable: the MP3 length does not match/);
  await expect(panel.getByRole("button", { name: "Sync with video" })).toBeDisabled();
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(false);
  expect(await video(page)).toMatchObject({ paused: true, muted: false, rate: 1 });
});

test("floating player: Sync from the page with the panel closed, a Udemy rate change ends it, unmute is respected, end of span", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(60_000);
  const { page, tabId, panel } = await plainResult(context, worker, extensionId, mydubb, 605);
  await panel.getByRole("button", { name: "Show floating player" }).click();
  await panel.close();
  const player = floating(page);
  await expect(player).toContainText("Sync: OFF");
  await player.getByRole("button", { name: "Sync with video" }).click();
  await expect(player).toContainText(/Video 0:10 → 0:56/);
  await player.getByRole("button", { name: "Turn on sync" }).click();
  await expect(player).toContainText("Sync: ON · Paused");
  await player.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect(player).toContainText("Sync: ON · Playing");
  await expect.poll(async () => (await video(page)).paused).toBe(false);

  // The user unmutes the video: kept (never muted again), Sync goes on.
  await page.evaluate(() => (window.fixture.videos()[0]!.muted = false));
  await expect(player).toContainText("You unmuted the video");
  await page.waitForTimeout(1200);
  expect((await video(page)).muted).toBe(false);
  expect((await sessionOf(worker, tabId))!.paused).toBe(false);

  // The user picks another speed in the site's player (a real click): both pause, Sync ends, the
  // rate is not forced back.
  await page.getByRole("button", { name: "Speed 2x" }).click();
  await expect(player).toContainText("Sync: OFF");
  await expect(player).toContainText("the video speed changed from 1.50");
  expect(await video(page)).toMatchObject({ paused: true, rate: 2, muted: false });
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);
  await page.evaluate(() => (window.fixture.videos()[0]!.playbackRate = 1));

  // End of the span: both pause; Play starts both again from V0 / 0.
  await player.getByRole("button", { name: "Sync with video" }).click();
  await expect(player).toContainText("Sync: ON · Paused");
  const seek = player.getByRole("slider", { name: "Position in the MyDubb audio" });
  const duration = (await sessionOf(worker, tabId))!.duration;
  await seek.evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
  }, duration - 1.5);
  // The page cannot click the player (trusted events only): Playwright's own input does.
  await seek.focus();
  await seek.press("ArrowRight");
  await expect.poll(async () => (await sessionOf(worker, tabId))!.currentTime).toBeGreaterThan(duration - 2);
  await player.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect(player).toContainText("End of the synced part", { timeout: 6000 });
  expect((await video(page)).paused).toBe(true);
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);
  expect((await video(page)).currentTime).toBeLessThan(56.6);
  await player.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect(player).toContainText("Sync: ON · Playing");
  await expect.poll(async () => (await video(page)).currentTime).toBeLessThan(13);
  expect((await sessionOf(worker, tabId))!.currentTime).toBeLessThan(2);

  // Close (×) with Sync on pauses both; the video never runs on alone.
  await player.getByRole("button", { name: "Close the MyDubb player (pauses the audio)" }).click();
  await expect.poll(async () => (await video(page)).paused).toBe(true);
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);
});

test("two tabs: playing B pauses A's audio and A's synced video; only own tab's video is driven", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(60_000);
  const a = await plainResult(context, worker, extensionId, mydubb, 606);
  await turnOnSync(a.panel);
  await a.panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await video(a.page)).paused).toBe(false);
  const b = await plainResult(context, worker, extensionId, mydubb, 607);
  await b.panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, b.tabId))!.paused).toBe(false);
  await expect.poll(async () => (await sessionOf(worker, a.tabId))!.paused).toBe(true);
  await expect.poll(async () => (await video(a.page)).paused).toBe(true);
  await expect(a.panel.getByText("Paused: MyDubb audio started in another tab.")).toBeVisible();
  // B is not synced: its video was never touched.
  expect(await video(b.page)).toMatchObject({ paused: true, muted: false, rate: 1, currentTime: 0 });
});

test("video replaced, lecture change, reload and disconnect end Sync and give the old video back", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(90_000);
  const { page, tabId, panel } = await plainResult(context, worker, extensionId, mydubb, 608);
  await turnOnSync(panel);
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await video(page)).paused).toBe(false);
  // The player element is replaced: the audio pauses, Sync ends, the new video is not driven.
  const oldVideo = await page.evaluateHandle(() => window.fixture.videos()[0]!);
  await page.evaluate(() => window.fixture.replaceVideo(60));
  await expect(panel.locator("#sync-notice")).toContainText("the Udemy video player was replaced");
  await expect(panel.getByText("Sync with video: OFF")).toBeVisible();
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);
  expect(await oldVideo.evaluate((v) => ({ paused: v.paused, muted: v.muted, rate: v.playbackRate }))).toEqual({ paused: true, muted: false, rate: 1 });
  await expect.poll(async () => (await video(page)).duration).toBeGreaterThan(50);
  expect(await video(page)).toMatchObject({ paused: true, muted: false, rate: 1, currentTime: 0 });

  // On again with the new video, then a stopped service worker changes nothing.
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await expect(panel.getByText("Sync with video: ON · Paused")).toBeVisible();
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await video(page)).paused).toBe(false);
  await panel.getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect.poll(async () => (await video(page)).paused).toBe(true);

  // Disconnect: the session ends and the video gets its sound and rate back.
  await panel.getByRole("button", { name: "Disconnect" }).click();
  await expect.poll(async () => (await video(page)).muted).toBe(false);
  expect(await video(page)).toMatchObject({ paused: true, rate: 1 });
  expect(await sessionOf(worker, tabId)).toBeNull();

  // Reload with a fresh result: Sync starts OFF; reloading ends the session (nothing plays on).
  const second = await plainResult(context, worker, extensionId, mydubb, 609);
  await turnOnSync(second.panel);
  await second.page.reload();
  await expect.poll(async () => sessionOf(worker, second.tabId)).toBeNull();
  await expect.poll(() => second.page.evaluate(() => document.querySelector("video")?.readyState ?? 0).catch(() => 0)).toBeGreaterThan(0);
  expect(await video(second.page)).toMatchObject({ paused: true, muted: false, rate: 1 });
  await second.panel.getByRole("button", { name: "Load audio" }).click();
  await expect(second.panel.getByText("Sync with video: OFF")).toBeVisible();

  // SPA lecture change with Sync on (a new session: explained again first): the session ends; the
  // next lecture's video is untouched.
  await turnOnSync(second.panel);
  await second.page.evaluate(() => window.fixture.navigate(610));
  await expect.poll(async () => sessionOf(worker, second.tabId)).toBeNull();
  expect(await video(second.page)).toMatchObject({ paused: true, muted: false, rate: 1 });
});

test("Play directly on the Udemy video of tab B pauses tab A (synced or not); one audio, own positions", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(90_000);
  const a = await plainResult(context, worker, extensionId, mydubb, 611);
  const b = await plainResult(context, worker, extensionId, mydubb, 612);
  await turnOnSync(a.panel);
  await turnOnSync(b.panel);
  const playingTabs = async () => (await playerSessions(worker)).filter((s) => !s.paused).map((s) => s.tabId);

  // A plays (synced); then the user presses Play on B's own video, not on a MyDubb button.
  await a.panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await video(a.page)).paused).toBe(false);
  await a.page.waitForTimeout(1500);
  await b.page.evaluate(() => (window.fixture.videos()[0]!.currentTime = 25));
  await b.page.evaluate(() => window.fixture.videos()[0]!.play());
  await expect.poll(playingTabs).toEqual([b.tabId]);
  await expect.poll(async () => (await video(a.page)).paused).toBe(true);
  await expect(a.panel.getByText("Paused: MyDubb audio started in another tab.")).toBeVisible();
  const aAt = (await sessionOf(worker, a.tabId))!.currentTime;
  const aVideoAt = (await video(a.page)).currentTime;
  expect(aAt).toBeGreaterThan(1);
  // B's audio started where B's video is: (V - V0) / R.
  const rate = (await sessionOf(worker, b.tabId))!.sync.rate!;
  expect(Math.abs(await measuredDrift(b.page, worker, b.tabId, 10, rate))).toBeLessThan(0.3);
  await b.page.waitForTimeout(1000);
  expect(await playingTabs()).toEqual([b.tabId]);
  // A kept its own place.
  expect((await sessionOf(worker, a.tabId))!.currentTime).toBeCloseTo(aAt, 1);
  expect((await video(a.page)).currentTime).toBeCloseTo(aVideoAt, 1);

  // A with Sync off, playing on its own; Play on B's video again: A pauses.
  await a.panel.getByRole("button", { name: "Turn off sync" }).click();
  await expect(a.panel.getByText("Sync with video: OFF")).toBeVisible();
  await a.panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(playingTabs).toEqual([a.tabId]);
  await expect.poll(async () => (await video(b.page)).paused).toBe(true);
  await b.page.evaluate(() => window.fixture.videos()[0]!.play());
  await expect.poll(playingTabs).toEqual([b.tabId]);
  await b.page.waitForTimeout(1000);
  expect(await playingTabs()).toEqual([b.tabId]);
  expect((await video(a.page)).paused).toBe(true);
});

test("the video starts at 1x and the site puts its own speed back when playback starts: Sync sets R again, both play", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(60_000);
  const { page, tabId, panel } = await plainResult(context, worker, extensionId, mydubb, 609);
  expect((await video(page)).rate).toBe(1);
  // Like a player that re-applies its stored speed (1x) on "play" (fixture; not the real Udemy player).
  await page.evaluate(() => window.fixture.siteResetsRate("play", 1));
  await turnOnSync(panel);
  const rate = (await sessionOf(worker, tabId))!.sync.rate!;
  expect(rate).toBeCloseTo(1.505, 2);
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await page.waitForTimeout(3000);
  const notice = await panel.locator("#sync-notice").textContent();
  console.log(`site reset on play: ${await page.evaluate(() => window.fixture.siteResets())} reset(s); panel notice: "${notice}"`);
  await expect(panel.getByText("Sync with video: ON · Playing")).toBeVisible();
  const v = await video(page);
  expect(v.paused).toBe(false);
  expect(v.rate).toBeCloseTo(rate, 6);
  expect((await sessionOf(worker, tabId))!.paused).toBe(false);
  expect(await page.evaluate(() => window.fixture.siteResets())).toBeGreaterThanOrEqual(1);
  expect(Math.abs(await measuredDrift(page, worker, tabId, 10, rate))).toBeLessThan(0.3);
  // The diagnostics trace shows what happened: the page's 1x right after the play, R set again.
  const trace = (await sessionOf(worker, tabId))!.trace;
  const restored = trace.find((e) => e.step === "event:rate-restored")!;
  expect(restored.videoRate).toBe(1);
  expect(restored.expectedRate).toBeCloseTo(rate, 9);
  expect(trace.findIndex((e) => e.step === "op:play")).toBeLessThan(trace.indexOf(restored));
  expect(trace.some((e) => e.step.startsWith("off:"))).toBe(false);
});

test("a page that keeps setting its own speed: R is set again a bounded number of times, then both pause and the reason is shown", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(60_000);
  const { page, tabId, panel } = await plainResult(context, worker, extensionId, mydubb, 610);
  // A tug of war: the "site" puts 1x back on every rate change, so on the one Sync makes when it
  // is turned on (fixture; not the real Udemy player).
  await page.evaluate(() => window.fixture.siteResetsRate("ratechange", 1));
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.getByText("Sync with video: OFF")).toBeVisible();
  await expect(panel.locator("#sync-notice")).toHaveText(/^Sync turned off: the video speed did not stay at 1\.50\dx, the speed Sync needs/);
  await page.waitForTimeout(1000);
  // Bounded: three restores (and the site's answers), then MyDubb stops; the page keeps its speed, the sound is given back.
  expect(await page.evaluate(() => window.fixture.siteResets())).toBe(4);
  expect(await video(page)).toMatchObject({ paused: true, muted: false, rate: 1 });
  const s = (await sessionOf(worker, tabId))!;
  expect(s.paused).toBe(true);
  expect(s.trace.filter((e) => e.step === "event:rate-restored")).toHaveLength(3);
  expect(s.trace.at(-1)?.step).toBe("off:rate-not-held");
});
