// Story 2, integration: Sync with the HTML5 video of an ordinary page (Loom share, YouTube watch,
// any page with one main video), in the real extension build, with a result MyDubb generated. The
// pages are synthetic fixtures served by routing at Loom/YouTube-like addresses (e2e/fixtures/
// videopage.*), the server is the fake MyDubb, the MP3 the backend's mock fixture: local evidence
// only, not the real loom.com or youtube.com players, nor mydubb.com.
//
// activeTab cannot be granted in Playwright (the toolbar button cannot be clicked): the test build
// has host access to the three fixture origins instead, and `mydubbE2E.clickAction` runs the
// toolbar button's own steps (open the panel, inject the content script). http://intranet.test has
// no access, as a page would have without the user's click.

import type { BrowserContext, Page, Worker } from "@playwright/test";

import {
  HTTP_ORIGIN,
  connectAccount,
  disconnect,
  expect,
  loomVideoUrl,
  openPanel,
  openWebPage,
  playerSessions,
  sessionGet,
  test,
  videoSiteUrl,
  youtubeUrl,
  type FakeMyDubb,
} from "./harness";

const READY = "Ready. Press play when you want to listen.";
// Timed transcript, timestamps on their own lines (Copy -> Paste): captions 0:19 and 1:20, so the
// start times are 00:00:19 -> 00:01:20 (61 s); at 2x the fake's 30.56 s MP3 fits, R = 61 / 30.56.
const TRANSCRIPT = "0:19\nWelcome back. In this recording we look at the dashboard.\n1:20\nThat is the whole tour.";
const V0 = 19;
const NO_ACCESS = "MyDubb cannot reach this page's video. Click the MyDubb button in Chrome's toolbar on this page, then try again.";

interface VideoFixture {
  state(id?: string): { paused: boolean; currentTime: number; duration: number; muted: boolean; rate: number; waiting: boolean } | null;
  next(id: string, at?: number): void;
  back(id: string, at?: number): void;
  replaceElement(at?: number): void;
  swapSource(at?: number): void;
  setRate(rate: number): void;
}
const video = (page: Page, id = "main") =>
  page.evaluate((i) => (window as unknown as { fixture: VideoFixture }).fixture.state(i)!, id);
const onPage = (page: Page, script: string) => page.evaluate(script);

async function sessionOf(worker: Worker, tabId: number) {
  return (await playerSessions(worker)).find((s) => s.tabId === tabId) ?? null;
}

/** The toolbar button's steps (open the panel, put the content script into the page). */
const clickMyDubb = (worker: Worker, tabId: number) =>
  worker.evaluate((id) => (globalThis as unknown as { mydubbE2E: { clickAction(t: number): Promise<boolean> } }).mydubbE2E.clickAction(id), tabId);

async function openVideoPage(context: BrowserContext, worker: Worker, extensionId: string, mydubb: FakeMyDubb, url: string) {
  const { page, tabId } = await openWebPage(context, worker, url);
  await expect.poll(async () => (await video(page))?.duration ?? 0).toBeGreaterThan(100);
  expect(await clickMyDubb(worker, tabId)).toBe(true);
  const panel = await openPanel(context, extensionId, tabId);
  await connectOnce(panel, mydubb, extensionId);
  return { page, tabId, panel };
}

/** The account connection is shared by the extension's panels: Connect only the first time. */
async function connectOnce(panel: Page, mydubb: FakeMyDubb, extensionId: string) {
  await expect(panel.getByText(/^(Connected as|Not connected)/)).toBeVisible();
  if (await panel.getByRole("button", { name: "Connect to MyDubb" }).isVisible()) await connectAccount(panel, mydubb, extensionId);
}

/** Copy -> Paste of the timed transcript, 2x, Generate; the audio loads paused at its start. */
async function generate(panel: Page, worker: Worker, tabId: number) {
  await panel.getByRole("textbox", { name: "English transcript" }).fill(TRANSCRIPT);
  await expect(panel.getByLabel("First sentence starts")).toHaveValue("00:00:19");
  await expect(panel.getByLabel("Last sentence starts")).toHaveValue("00:01:20");
  await panel.getByRole("radio", { name: "2x", exact: true }).check();
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.duration ?? 0).toBeGreaterThan(25);
}

async function turnOnSync(panel: Page, first = true) {
  await panel.getByRole("button", { name: "Sync with video" }).click();
  if (first) await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Paused");
}

const playButton = (panel: Page) => panel.getByRole("button", { name: /^(Play|Pause) MyDubb audio$/ });

async function drift(page: Page, worker: Worker, tabId: number, rate: number) {
  const v = (await video(page)).currentTime;
  const a = (await sessionOf(worker, tabId))!.currentTime;
  return (v - V0) / rate - a;
}

test("Loom-like page: Generate, Sync moves the video to the job's start, both players drive both, Sync off gives the video back", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  test.setTimeout(90_000);
  const { page, tabId, panel } = await openVideoPage(context, worker, extensionId, mydubb, loomVideoUrl("demo"));
  // The page's video is at 1:40, paused, when the job is made.
  await expect.poll(async () => (await video(page)).currentTime).toBeCloseTo(100, 1);
  await generate(panel, worker, tabId);
  // The job's snapshot names this page (a fingerprint, not the address).
  const record = (await sessionGet(worker, `job:${tabId}`)) as { lessonKey: string; choices: { sync: { start: number; end: number; page: string } } };
  expect(record).toMatchObject({ lessonKey: "page", choices: { sync: { mode: "timed", start: 19, end: 80 } } });
  expect(record.choices.sync.page).toMatch(/^p-[0-9a-f]{14}$/);
  // Loading the audio does not touch the page's video; Sync is offered, OFF.
  expect(await video(page)).toMatchObject({ paused: true, muted: false, rate: 1 });
  expect((await video(page)).currentTime).toBeCloseTo(100, 1);
  await expect(panel.locator("#sync-status")).toHaveText("OFF");
  await expect(panel.locator("#player-floating")).toBeHidden();

  // The first time: the explanation, with the job's span and the measured MP3.
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await expect(panel.locator("#sync-preview")).toContainText(/^Video 0:19 → 1:20 \(61 s\), MP3 30\.56\d? s, video speed 1\.99\dx\./);
  await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Paused");
  // Audio at its start: the video goes to 0:19 (not 1:40), muted, at R.
  const rate = (await sessionOf(worker, tabId))!.sync.rate!;
  expect(rate).toBeCloseTo(61 / (await sessionOf(worker, tabId))!.duration, 6);
  let v = await video(page);
  expect(v).toMatchObject({ paused: true, muted: true });
  expect(v.currentTime).toBeCloseTo(V0, 1);
  expect(v.rate).toBeCloseTo(rate, 6);

  // Play from MyDubb: both run; the audio at 1x.
  await playButton(panel).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing");
  await expect.poll(async () => (await video(page)).paused).toBe(false);
  const drifts: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(1000);
    drifts.push(await drift(page, worker, tabId, rate));
  }
  const s = (await sessionOf(worker, tabId))!;
  console.log(`page sync drift: test max |d| = ${Math.max(...drifts.map(Math.abs)).toFixed(3)} s; coordinator ${s.drift.maxAbsDrift.toFixed(3)} s over ${s.drift.samples} samples, ${s.drift.corrections} corrections`);
  expect(s.rate).toBe(1);
  expect(Math.max(...drifts.map(Math.abs))).toBeLessThan(0.3);

  // The page's own player: pause, play, seek; the audio follows.
  await onPage(page, `document.getElementById("main").pause()`);
  await expect(panel.locator("#sync-status")).toHaveText("ON · Paused");
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(true);
  await page.click("#main"); // the site player's click: play
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing");
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(false);
  await onPage(page, `document.getElementById("main").currentTime = 50`);
  await expect.poll(async () => (await sessionOf(worker, tabId))!.currentTime).toBeCloseTo((50 - V0) / rate, 0);
  await page.waitForTimeout(1500);
  expect(Math.abs(await drift(page, worker, tabId, rate))).toBeLessThan(0.3);

  // MyDubb's Pause and ±5 s move both.
  await playButton(panel).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Paused");
  await expect.poll(async () => (await video(page)).paused).toBe(true);
  const a0 = (await sessionOf(worker, tabId))!.currentTime;
  await panel.getByRole("button", { name: "Back 5 seconds in the MyDubb audio" }).click();
  await expect.poll(async () => (await video(page)).currentTime).toBeCloseTo(V0 + (a0 - 5) * rate, 0);

  // Off: both paused; mute and rate given back. The audio still plays on its own.
  await panel.getByRole("button", { name: "Sync with video", pressed: true }).click();
  await expect(panel.locator("#sync-status")).toHaveText("OFF");
  v = await video(page);
  expect(v).toMatchObject({ paused: true, muted: false, rate: 1 });
  await playButton(panel).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(false);
  await page.waitForTimeout(500);
  expect((await video(page)).paused).toBe(true);
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
});

test("YouTube-like page: another video in the same tab ends Sync; the old audio never drives the new video, nor the first one loaded again", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  test.setTimeout(60_000);
  const { page, tabId, panel } = await openVideoPage(context, worker, extensionId, mydubb, youtubeUrl("AAAA"));
  await generate(panel, worker, tabId);
  await turnOnSync(panel);
  await playButton(panel).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing");

  // The next video (same element, new source, new ?v=): Sync ends, both paused, the reason is said.
  await onPage(page, `window.fixture.next("BBBB", 0)`);
  await expect(panel.locator("#sync-notice")).toHaveText(/Sync turned off: the video player was replaced or the page changed/);
  await expect(panel.locator("#sync-toggle")).toBeHidden();
  await expect(panel.locator("#sync-status")).toHaveText(/another video or address than the one this audio was made on/);
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(true);
  const b = await video(page);
  console.log(`after the switch the new video is muted=${b.muted} rate=${b.rate} (MyDubb gives back only on the same media)`);
  // The audio plays on its own; the new video is neither started, paused nor moved by it.
  await onPage(page, `document.getElementById("main").currentTime = 7`);
  await playButton(panel).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(false);
  await page.waitForTimeout(1000);
  expect(await video(page)).toMatchObject({ paused: true, currentTime: 7 });
  await playButton(panel).click();

  // The first video's address again (the user went back): the player loads it as a new source, so
  // MyDubb cannot confirm it is the video of the click; the audio stays on its own.
  await onPage(page, `window.fixture.back("AAAA", 100)`);
  await expect(panel.locator("#sync-status")).toHaveText(/the page's video is not the one this audio was made with/);
  await expect(panel.locator("#sync-toggle")).toBeHidden();
});

test("the page changes the video's speed while it plays: Sync turns off and says so; the video keeps the page's speed", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  const { page, tabId, panel } = await openVideoPage(context, worker, extensionId, mydubb, videoSiteUrl("rate"));
  await generate(panel, worker, tabId);
  await turnOnSync(panel);
  await playButton(panel).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing");
  await page.waitForTimeout(2500); // past the settling time after play
  await onPage(page, `window.fixture.setRate(1.25)`);
  await expect(panel.locator("#sync-notice")).toContainText("Sync turned off: the video speed changed");
  await expect(panel.locator("#sync-status")).toHaveText("OFF");
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(true);
  expect(await video(page)).toMatchObject({ paused: true, muted: false, rate: 1.25 });
});

test("buffering: a seek into data that has not arrived holds the audio; both resume aligned once it arrives", async ({
  context,
  worker,
  extensionId,
  mydubb,
  media,
}) => {
  test.setTimeout(60_000);
  // Everything after 0:60 of the video arrives only when the test lets it.
  media.holdFrom(60);
  const { page, tabId, panel } = await openVideoPage(context, worker, extensionId, mydubb, videoSiteUrl("buffer", "?media=http&at=30"));
  await generate(panel, worker, tabId);
  await turnOnSync(panel);
  await playButton(panel).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing");
  const rate = (await sessionOf(worker, tabId))!.sync.rate!;
  // Seek bar to 0:25 of the MP3: the video goes to 19 + 25 x R ≈ 1:09, not loaded yet.
  await panel.locator("#player-seek").evaluate((input: HTMLInputElement) => {
    input.value = "25";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
  });
  await expect(panel.locator("#sync-status")).toHaveText("ON · Buffering…");
  await page.waitForTimeout(2000);
  const held = (await sessionOf(worker, tabId))!;
  expect(held.paused).toBe(true);
  expect(held.currentTime).toBeCloseTo(25, 0);
  media.release();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Playing", { timeout: 15_000 });
  await expect.poll(async () => (await video(page)).paused).toBe(false);
  await page.waitForTimeout(1500);
  const d = await drift(page, worker, tabId, rate);
  console.log(`after buffering: |d| = ${Math.abs(d).toFixed(3)} s`);
  expect(Math.abs(d)).toBeLessThan(0.3);
});

test("several videos: a preview is left alone; a second video the page starts with sound makes Sync wait for the user's choice", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  test.setTimeout(60_000);
  // Main video + a muted looping teaser: the main one is the video; the teaser is never touched.
  const preview = await openVideoPage(context, worker, extensionId, mydubb, videoSiteUrl("preview", "?preview=1"));
  await generate(preview.panel, worker, preview.tabId);
  await turnOnSync(preview.panel);
  expect(await video(preview.page)).toMatchObject({ muted: true });
  expect(await video(preview.page, "preview")).toMatchObject({ muted: true, rate: 1, paused: false });
  await preview.panel.getByRole("button", { name: "Sync with video", pressed: true }).click();
  await preview.page.close();

  // Main video + one the page plays by itself, with sound: no single video at the click.
  const { page, tabId, panel } = await openVideoPage(context, worker, extensionId, mydubb, videoSiteUrl("side", "?side=1"));
  await expect.poll(async () => (await video(page, "side")).paused).toBe(false);
  await generate(panel, worker, tabId);
  await expect(panel.locator("#sync-toggle")).toBeHidden();
  await expect(panel.locator("#sync-status")).toHaveText(/no single video was identified on this page when you chose Generate/);
  // The audio plays on its own; neither video is touched.
  await playButton(panel).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(false);
  await playButton(panel).click();
  expect(await video(page, "side")).toMatchObject({ muted: false, rate: 1, paused: false });
  expect(await video(page)).toMatchObject({ muted: false, rate: 1, paused: true });

  // The user starts the main video on the page (a real click): it is the one; Generate again.
  await page.click("#main");
  await expect.poll(async () => (await video(page)).paused).toBe(false);
  await generate(panel, worker, tabId);
  await turnOnSync(panel); // a new result: the explanation comes again
  expect(await video(page)).toMatchObject({ muted: true, paused: true });
  expect((await video(page)).currentTime).toBeCloseTo(V0, 1);
  // The side video was never paused, muted or set to R.
  expect(await video(page, "side")).toMatchObject({ muted: false, rate: 1, paused: false });
});

test("no access, reload and account change: listening goes on, Sync only where MyDubb may reach the page", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(60_000);
  // A page without the user's click (no access): the result plays on its own, and the panel says
  // how to give access.
  const plain = await openWebPage(context, worker, `${HTTP_ORIGIN}/notes`);
  expect(await clickMyDubb(worker, plain.tabId)).toBe(false);
  const plainPanel = await openPanel(context, extensionId, plain.tabId);
  await connectOnce(plainPanel, mydubb, extensionId);
  await generate(plainPanel, worker, plain.tabId);
  await expect(plainPanel.locator("#sync-status")).toHaveText(NO_ACCESS);
  await expect(plainPanel.locator("#sync-toggle")).toBeHidden();
  await playButton(plainPanel).click();
  await expect.poll(async () => (await sessionOf(worker, plain.tabId))!.paused).toBe(false);
  await playButton(plainPanel).click();
  await plain.page.close();
  await plainPanel.close();

  // Reload of the page with Sync on: Sync ends, the audio stays. The reloaded page's video cannot be
  // confirmed to be the one of the click (a new document, a new element): Sync is not offered again
  // for this result; Generate again to sync.
  const { page, tabId, panel } = await openVideoPage(context, worker, extensionId, mydubb, loomVideoUrl("reload"));
  await generate(panel, worker, tabId);
  await turnOnSync(panel);
  await page.reload();
  await expect(panel.locator("#sync-notice")).toHaveText(/Sync turned off/);
  expect(await sessionOf(worker, tabId)).not.toBeNull();
  await expect.poll(async () => (await video(page))?.duration ?? 0).toBeGreaterThan(100);
  await expect(panel.locator("#sync-status")).toHaveText(/the page's video is not the one this audio was made with/, { timeout: 15_000 });
  expect(await video(page)).toMatchObject({ muted: false, rate: 1 });
  await generate(panel, worker, tabId);
  await turnOnSync(panel);
  expect(await video(page)).toMatchObject({ muted: true });

  // The account connection ends with Sync on: the session ends and the video gets its sound back.
  await disconnect(panel);
  await expect.poll(() => sessionOf(worker, tabId)).toBeNull();
  await expect.poll(async () => (await video(page)).muted).toBe(false);
  expect((await video(page)).rate).toBe(1);
});

for (const change of ["replaceElement", "swapSource"] as const) {
  test(`same address, Sync OFF, the page ${change === "replaceElement" ? "replaces the video element" : "loads another source into the same element"}: Sync is not offered and video B is never touched; audio A plays on its own`, async ({
    context,
    worker,
    extensionId,
    mydubb,
  }) => {
    test.setTimeout(60_000);
    const { page, tabId, panel } = await openVideoPage(context, worker, extensionId, mydubb, videoSiteUrl(change));
    await generate(panel, worker, tabId);
    // The video of the click, unchanged: Sync is offered (OFF, never turned on).
    await expect(panel.locator("#sync-status")).toHaveText("OFF");
    await expect(panel.locator("#sync-toggle")).toBeVisible();
    const url = page.url();

    // Video B at the same address, 0:30, paused, with sound, 1x.
    await onPage(page, `window.fixture.${change}(30)`);
    await expect.poll(async () => (await video(page)).currentTime).toBeCloseTo(30, 1);
    expect(page.url()).toBe(url);
    await expect(panel.locator("#sync-toggle")).toBeHidden();
    await expect(panel.locator("#sync-status")).toHaveText(/the page's video is not the one this audio was made with/);
    expect((await sessionOf(worker, tabId))!.sync.status).toBe("unavailable");

    // Trying anyway (the hidden toggle forced visible and clicked): nothing happens to video B.
    await panel.locator("#sync-toggle").evaluate((b: HTMLButtonElement) => (b.hidden = false));
    await panel.locator("#sync-toggle").click();
    await panel.locator("#sync-on").evaluate((b: HTMLButtonElement) => b.click());
    // Audio A plays on its own, for a while.
    await playButton(panel).click();
    await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(false);
    await page.waitForTimeout(2000);
    expect((await sessionOf(worker, tabId))!.sync.status).toBe("unavailable");
    expect(await video(page)).toMatchObject({ paused: true, muted: false, rate: 1 });
    expect((await video(page)).currentTime).toBeCloseTo(30, 1);
    await playButton(panel).click();
    await expect.poll(async () => (await sessionOf(worker, tabId))!.paused).toBe(true);
  });
}
