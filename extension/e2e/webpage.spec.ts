// Story 1 in the real extension build: transcript, Generate and playback on an ordinary web page
// (no Udemy lecture, no video, no content script), against the fake MyDubb server of harness.ts and
// synthetic fixture pages (a stand-in for a video host, never the real loom.com). Local evidence
// only: the native "Send to MyDubb" context menu cannot be clicked by Playwright, so those tests
// call the real worker handler with the text Chrome would pass; the menu itself is accepted by hand.

import type { BrowserContext, Page, Worker } from "@playwright/test";
import {
  HTTP_ORIGIN,
  allowConnect,
  connectAccount,
  disconnect,
  expect,
  expectNoLectureNotice,
  fillTimes,
  lectureUrl,
  openLecture,
  openPanel,
  openWebPage,
  playerSessions,
  selectTranscript,
  sendMenuSelection,
  sessionGet,
  tabIdFor,
  test,
  webUrl,
} from "./harness";

const GENERATE = "Generate audio";

test("paste a transcript on a page without video, Generate and listen", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openWebPage(context, worker, webUrl("abc123"));
  const panel = await openPanel(context, extensionId, tabId);
  const textarea = panel.getByRole("textbox", { name: "English transcript" });

  // No lecture: the panel starts with the transcript box and says nothing about Udemy or lectures.
  await expect(textarea).toBeVisible();
  await expectNoLectureNotice(panel);
  // The transcript box follows the header directly (no block in between).
  const head = (await panel.locator(".head").boundingBox())!;
  const card = (await panel.locator("#draft-heading").boundingBox())!;
  expect(card.y - (head.y + head.height)).toBeLessThan(40);
  expect(await page.locator("video").count()).toBe(0);
  // The page has no channel into the extension, and the extension sent nothing anywhere.
  expect(await page.evaluate(() => typeof (window as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id)).toBe("undefined");
  expect(mydubb.requests.map((r) => r.path)).toEqual(["/api/meta"]);

  await connectAccount(panel, mydubb, extensionId);
  await textarea.fill("Hello and welcome.\nThis is the second sentence.");
  await fillTimes(panel);
  // Generate is allowed although the tab has no lecture key and no video.
  await expect(panel.getByRole("button", { name: GENERATE })).toBeEnabled();
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();

  const [post] = mydubb.posts("/api/jobs");
  expect(post?.body).toEqual({
    transcript: "Hello and welcome.\nThis is the second sentence.",
    first_sentence_start: "00:00:10",
    last_sentence_start: "00:06:10",
    voice: "AndrewMultilingual",
    speed: 1,
    target_language: "vietnamese",
  });
  // Nothing of the page (address, title) is sent with it.
  expect(JSON.stringify(post?.body)).not.toContain("loom");
  expect(JSON.stringify(post?.body)).not.toContain("abc123");
  expect(await sessionGet(worker, `job:${tabId}`)).toMatchObject({ lessonKey: "page", jobId: "job-1" });

  // Loaded paused at the start, Sync OFF/absent, 1x; the translation and facts come with it.
  await expect(panel.locator("#translation")).toHaveText("Bản dịch <b>job-1</b>");
  await expect(panel.locator("#player-info")).toContainText("Vietnamese · Andrew Multilingual · 1x");
  await expect.poll(async () => (await playerSessions(worker))[0]?.duration ?? 0).toBeGreaterThan(0);
  expect(await playerSessions(worker)).toMatchObject([{ tabId, paused: true, currentTime: 0, rate: 1, blobSrc: true, lessonKey: "page" }]);
  // Only what exists is offered: no Sync, no floating player, no video moves.
  await expect(panel.locator("#sync")).toBeHidden();
  await expect(panel.locator("#player-floating")).toBeHidden();
  await expect(panel.locator("#video-place")).toHaveText("");

  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);
  await expect.poll(async () => (await playerSessions(worker))[0]?.currentTime ?? 0).toBeGreaterThan(0);
  expect((await playerSessions(worker))[0]?.rate).toBe(1);
  await panel.getByRole("button", { name: "Pause MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(true);
  // The audio keeps playing without the panel: closing it does not end the session.
  await panel.close();
  expect((await playerSessions(worker)).map((s) => s.tabId)).toEqual([tabId]);
});

test("copy on the page, paste in the panel: line breaks and timestamps go through the existing timed parser", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openWebPage(context, worker, webUrl("paste1"));
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  // The fallback when the menu text loses its lines: a real Ctrl+C on the page and a real Ctrl+V
  // into the transcript box (no clipboard permission involved).
  const selected = await selectTranscript(page);
  expect(selected).toContain("\n");
  const text = selected.replace(/\r\n/g, "\n");
  await page.bringToFront();
  await page.keyboard.press("Control+C");
  await panel.bringToFront();
  const textarea = panel.getByRole("textbox", { name: "English transcript" });
  await textarea.focus();
  await panel.keyboard.press("Control+V");
  await expect(textarea).toHaveValue(text);
  await expect(panel.locator("#timing-text")).toContainText("Timestamps detected: 2 captions from 0:05 to 0:21");
  await expect(panel.getByLabel("First sentence starts")).toHaveValue("00:00:05");
  await expect(panel.getByLabel("Last sentence starts")).toHaveValue("00:00:21");
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  const [post] = mydubb.posts("/api/jobs");
  expect(post?.body).toMatchObject({ transcript: text, timing_mode: "timed", first_sentence_start: "00:00:05", last_sentence_start: "00:00:21" });
  // The draft is kept for this tab (memory only) and is not tied to any lecture.
  expect(await sessionGet(worker, `draft:${tabId}`)).toMatchObject({ lessonKey: null });
});

test("Send to MyDubb on a normal page: right tab, draft to check, Generate and Play", async ({ context, worker, extensionId, mydubb }) => {
  const a = await openWebPage(context, worker, webUrl("send-a"));
  const b = await openWebPage(context, worker, webUrl("send-b"));
  const panelA = await openPanel(context, extensionId, a.tabId);
  const panelB = await openPanel(context, extensionId, b.tabId);
  await connectAccount(panelA, mydubb, extensionId);

  const selected = await selectTranscript(a.page);
  expect(selected).toContain("\n");
  await sendMenuSelection(worker, a.tabId, selected, a.page.url());
  // Chrome's text lands in the draft of tab A and in no other tab; nothing was sent to MyDubb yet.
  await expect(panelA.getByRole("textbox", { name: "English transcript" })).toHaveValue(selected);
  await expect(panelA.getByText(/Selection received/)).toBeVisible();
  await expectNoLectureNotice(panelA);
  await expectNoLectureNotice(panelB);
  await expect(panelB.getByRole("textbox", { name: "English transcript" })).toHaveValue("");
  expect(mydubb.posts("/api/jobs")).toHaveLength(0);
  // The panel was opened for tab A (the real call needs a user gesture: the badge says it failed here).
  await expect.poll(() => worker.evaluate((tab) => chrome.action.getBadgeText({ tabId: tab }), a.tabId)).toBe("!");
  expect(await sessionGet(worker, `draft:${a.tabId}`)).toMatchObject({ text: selected, lessonKey: null });
  expect(await sessionGet(worker, `draft:${b.tabId}`)).toBeNull();

  await expect(panelA.getByLabel("First sentence starts")).toHaveValue("00:00:05");
  await panelA.getByRole("button", { name: GENERATE }).click();
  await expect(panelA.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  await panelA.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);
  expect((await playerSessions(worker)).map((s) => s.tabId)).toEqual([a.tabId]);
  await expect(panelB.locator("#result-section")).toBeHidden();
  await expect(panelB.locator("#player-section")).toBeHidden();
});

test("an http page works too, and the text Chrome flattened is kept as received, never re-timed", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openWebPage(context, worker, `${HTTP_ORIGIN}/notes`);
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  // Chrome gave the text on one line: the timestamps are plain words now.
  const flattened = "0:05 Welcome back to the dashboard tour. 0:21 That is the whole tour.";
  await sendMenuSelection(worker, tabId, flattened, page.url());
  const textarea = panel.getByRole("textbox", { name: "English transcript" });
  await expect(textarea).toHaveValue(flattened);
  await expect(panel.locator("#timing")).toBeHidden();
  await expect(panel.getByLabel("First sentence starts")).toHaveValue("");
  // The user can fix it: put the line breaks back (or Copy -> Paste) and the timestamps are read again.
  const fixed = "0:05\nWelcome back to the dashboard tour.\n0:21\nThat is the whole tour.";
  await textarea.fill(fixed);
  await expect(panel.getByLabel("First sentence starts")).toHaveValue("00:00:05");
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  expect(mydubb.posts("/api/jobs")[0]?.body).toMatchObject({ transcript: fixed, timing_mode: "timed" });
});

test("an empty or too long selection is reported, and an edited draft is only replaced after confirmation", async ({
  context,
  worker,
  extensionId,
}) => {
  const { page, tabId } = await openWebPage(context, worker, webUrl("limits"));
  const panel = await openPanel(context, extensionId, tabId);
  const textarea = panel.getByRole("textbox", { name: "English transcript" });

  await sendMenuSelection(worker, tabId, "  \n ", page.url());
  await expect(panel.getByText(/The selection was empty/)).toBeVisible();
  await expect(textarea).toHaveValue("");
  await sendMenuSelection(worker, tabId, "x".repeat(100_001), page.url());
  await expect(panel.getByText(/The selection is too long \(over 100,000 characters\)/)).toBeVisible();
  await expect(textarea).toHaveValue("");

  await sendMenuSelection(worker, tabId, "First selection.", page.url());
  await expect(textarea).toHaveValue("First selection.");
  // Unedited: replaced silently. Edited: asks first.
  await sendMenuSelection(worker, tabId, "Second selection.", page.url());
  await expect(textarea).toHaveValue("Second selection.");
  await expect(panel.getByRole("alertdialog")).toBeHidden();
  await textarea.fill("My own edits");
  await sendMenuSelection(worker, tabId, "Third selection.", page.url());
  await expect(panel.getByRole("alertdialog")).toBeVisible();
  await panel.getByRole("button", { name: "Keep my draft" }).click();
  await expect(textarea).toHaveValue("My own edits");
  await sendMenuSelection(worker, tabId, "Fourth selection.", page.url());
  await panel.getByRole("button", { name: "Replace draft" }).click();
  await expect(textarea).toHaveValue("Fourth selection.");
  // Nothing was sent to MyDubb by any of this.
  expect(await sessionGet(worker, `pending:${tabId}`)).toBeNull();
});

test("two tabs, an account change and a late answer never put a result under the wrong owner", async ({ context, worker, extensionId, mydubb }) => {
  const a = await openWebPage(context, worker, webUrl("two-a"));
  const b = await openWebPage(context, worker, webUrl("two-b"));
  const panelA = await openPanel(context, extensionId, a.tabId);
  const panelB = await openPanel(context, extensionId, b.tabId);
  await connectAccount(panelA, mydubb, extensionId);
  await expect(panelB.locator("#account-status")).toHaveText("Connected as Lan");
  await panelA.getByRole("textbox", { name: "English transcript" }).fill("Tab A text.");
  await panelB.getByRole("textbox", { name: "English transcript" }).fill("Tab B text.");
  await fillTimes(panelA);
  await fillTimes(panelB);

  // Each tab keeps its own job and audio.
  await panelA.getByRole("button", { name: GENERATE }).click();
  await expect(panelA.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  await expect(panelB.locator("#result-section")).toBeHidden();
  mydubb.translations["job-2"] = "Bản dịch của tab B";
  await panelB.getByRole("button", { name: GENERATE }).click();
  await expect(panelB.locator("#translation")).toHaveText("Bản dịch của tab B");
  await expect(panelA.locator("#translation")).toHaveText("Bản dịch <b>job-1</b>");
  await expect.poll(async () => (await playerSessions(worker)).map((s) => s.tabId).sort()).toEqual([a.tabId, b.tabId].sort());
  expect(mydubb.posts("/api/jobs").map((r) => (r.body as { transcript: string }).transcript)).toEqual(["Tab A text.", "Tab B text."]);

  // One audio at a time: playing B pauses A.
  await panelA.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker)).find((s) => s.tabId === a.tabId)?.paused).toBe(false);
  await panelB.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker)).find((s) => s.tabId === b.tabId)?.paused).toBe(false);
  expect((await playerSessions(worker)).find((s) => s.tabId === a.tabId)?.paused).toBe(true);

  // A job still running in A when the account changes is dropped: its late answer shows nowhere.
  mydubb.advance = false;
  await panelA.getByRole("button", { name: GENERATE }).click();
  await expect(panelA.getByText("Queued…")).toBeVisible();
  await disconnect(panelB);
  await expect(panelA.getByRole("button", { name: "Connect MyDubb" })).toBeVisible();
  await expect(panelA.locator("#result-section")).toBeHidden();
  await expect.poll(() => playerSessions(worker)).toEqual([]);
  // Another account connects; the first account's job finishing now belongs to nobody here.
  mydubb.user = { id: "u2", email: "minh@example.com", display_name: "Minh" };
  await allowConnect(panelA, mydubb, extensionId);
  await panelA.getByRole("button", { name: "Connect MyDubb" }).click();
  await expect(panelA.locator("#account-status")).toHaveText("Connected as Minh");
  mydubb.complete("job-3");
  mydubb.advance = true;
  await panelA.waitForTimeout(1500);
  expect(mydubb.gets("/api/jobs/job-3/result")).toHaveLength(0);
  await expect(panelA.locator("#result-section")).toBeHidden();
  expect(await playerSessions(worker)).toEqual([]);
  expect(await sessionGet(worker, `job:${a.tabId}`)).toBeNull();

  // Closing a tab ends its audio.
  await panelB.getByRole("textbox", { name: "English transcript" }).fill("Tab B again.");
  await fillTimes(panelB);
  await expect(panelB.getByRole("button", { name: GENERATE })).toBeEnabled();
  await panelB.getByRole("button", { name: GENERATE }).click();
  await expect(panelB.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  await expect.poll(async () => (await playerSessions(worker)).map((s) => s.tabId)).toEqual([b.tabId]);
  await b.page.close();
  await expect.poll(() => playerSessions(worker)).toEqual([]);
  await expect(panelB.getByText(/linked tab was closed/)).toBeVisible();
});

test("the earlier audio stays while a new one generates, and a refused or failed Generate keeps it", async ({ context, worker, extensionId, mydubb }) => {
  const { tabId } = await openWebPage(context, worker, webUrl("keep"));
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await panel.getByRole("textbox", { name: "English transcript" }).fill("Keep me.");
  await fillTimes(panel);
  mydubb.translations["job-1"] = "Âm thanh đầu tiên";
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.locator("#translation")).toHaveText("Âm thanh đầu tiên");
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);

  // The second job is still queued: the first audio keeps playing, with its own translation.
  mydubb.advance = false;
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Queued…")).toBeVisible();
  expect((await playerSessions(worker))[0]?.paused).toBe(false);
  await expect(panel.locator("#translation")).toHaveText("Âm thanh đầu tiên");
  // When the second one is ready, it replaces the first: paused at its start, with its translation.
  mydubb.translations["job-2"] = "Âm thanh thứ hai";
  mydubb.complete("job-2");
  mydubb.advance = true;
  await expect(panel.locator("#translation")).toHaveText("Âm thanh thứ hai", { timeout: 20_000 });
  await expect.poll(async () => (await playerSessions(worker))[0]).toMatchObject({ paused: true, currentTime: 0 });

  // A download that fails keeps what is loaded; Load audio tries again without a new job.
  mydubb.audioAnswers = [500];
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText(/The audio could not be loaded/)).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("#translation")).toHaveText("Âm thanh thứ hai");
  expect(mydubb.posts("/api/jobs")).toHaveLength(3);
  await panel.getByRole("button", { name: "Load audio" }).click();
  await expect(panel.locator("#translation")).toHaveText("Bản dịch <b>job-3</b>", { timeout: 20_000 });
  expect(mydubb.posts("/api/jobs")).toHaveLength(3);

  // A refused Generate creates nothing and changes nothing.
  mydubb.createAnswers = [422];
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.locator("#last-start")).toHaveAttribute("aria-invalid", "true");
  await expect(panel.locator("#translation")).toHaveText("Bản dịch <b>job-3</b>");
  expect((await playerSessions(worker)).map((s) => s.tabId)).toEqual([tabId]);
});

test("a tab that becomes a Udemy lecture drops the page's result; a lecture that becomes a page can generate there", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  const { page, tabId } = await openWebPage(context, worker, webUrl("switch"));
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await panel.getByRole("textbox", { name: "English transcript" }).fill("Page text.");
  await fillTimes(panel);
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  await expect.poll(async () => (await playerSessions(worker)).length).toBe(1);

  // The same tab goes to a Udemy lecture: its content script reports it, and the page's result goes.
  await page.goto("https://www.udemy.com/course/demo-course/learn/lecture/601");
  await expect(panel.locator("#lesson-label")).toHaveText("Lecture 601", { timeout: 15_000 });
  await expect(panel.locator("#result-section")).toBeHidden();
  await expect(panel.getByText(/lecture changed/)).toBeVisible();
  await expect.poll(() => playerSessions(worker)).toEqual([]);
  expect(await sessionGet(worker, `job:${tabId}`)).toBeNull();
  await expect(panel.locator("#video-box")).toBeVisible();

  // Back to a plain page in the same tab: the video controls go away and Generate still works.
  await page.goto(webUrl("switch-back"));
  await expect(panel.locator("#lesson-box")).toBeHidden({ timeout: 20_000 });
  await expect(panel.locator("#video-box")).toBeHidden();
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  expect(await sessionGet(worker, `job:${tabId}`)).toMatchObject({ lessonKey: "page" });
});

test("Udemy lecture: Send to MyDubb, Generate, audio and Sync still use the lecture and its video", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 602, "?seconds=60");
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  // The Udemy path: the content script's selection, with its own line breaks, not Chrome's flattened text.
  const expected = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("transcript")!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    return document.getSelection()!.toString();
  });
  await sendMenuSelection(worker, tabId, "chrome flattened text", page.url());
  await expect(panel.getByRole("textbox", { name: "English transcript" })).toHaveValue(expected);
  expect(await sessionGet(worker, `draft:${tabId}`)).toMatchObject({ lessonKey: "demo-course/602" });
  await expect(panel.locator("#video-box")).toBeVisible();
  await panel.getByLabel("First sentence starts").fill("000010");
  await panel.getByLabel("Last sentence starts").fill("000056");
  await panel.getByRole("radio", { name: "1.5x", exact: true }).check();
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  expect(await sessionGet(worker, `job:${tabId}`)).toMatchObject({ lessonKey: "demo-course/602" });
  expect(await playerSessions(worker)).toMatchObject([{ tabId, lessonKey: "demo-course/602", rate: 1 }]);
  // The lecture's extras are there: floating player and Sync (started from the panel).
  await expect(panel.locator("#sync")).toBeVisible();
  await expect(panel.locator("#player-floating")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sync with video" })).toBeEnabled();
  await expect(panel.locator("#sync-status")).toHaveText("OFF");
  await expect(panel.locator("#video-place")).toHaveText("Video paused at 0:10, where this audio starts.");
  expect(await page.evaluate(() => window.fixture.state())).toMatchObject({ paused: true, currentTime: 10, muted: false, rate: 1 });
  // Sync is turned on from the panel exactly as before; the audio's speed stays 1 (already fitted).
  await panel.getByRole("button", { name: "Sync with video" }).click();
  await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Paused");
  expect((await playerSessions(worker))[0]?.rate).toBe(1);
});

/**
 * Holds the lecture fixture's blocking script until `release()`. The lecture page has been
 * committed and the tab is "loading", but the page cannot finish, so the Udemy content script (which
 * runs when the document is idle) has not attached and nothing can report the lecture. Events are
 * ordered by the gate, not by sleeping: `asked` resolves once the browser requested the script.
 */
function holdLectureScript(context: BrowserContext) {
  let release!: () => void;
  let requested!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const asked = new Promise<void>((resolve) => (requested = resolve));
  const ready = context.route(
    (url) => url.pathname === "/__fixture/fixture.js",
    async (route) => {
      requested();
      await gate;
      await route.fallback();
    },
  );
  return { release, asked, ready };
}

/** A Udemy lecture tab whose page has been committed but whose content script cannot attach yet. */
async function openHeldLecture(context: BrowserContext, worker: Worker, id: number) {
  const held = holdLectureScript(context);
  await held.ready;
  const ids = () => worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id!));
  const before = new Set(await ids());
  const page = await context.newPage();
  const fresh = (await ids()).filter((x) => !before.has(x));
  expect(fresh).toHaveLength(1);
  const loaded = page.goto(lectureUrl(id, "?seconds=60"));
  await held.asked;
  return { page, tabId: fresh[0]!, held, loaded };
}

test("Udemy, video not found yet: Paste and Generate send one POST; the video found while the job runs changes nothing", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  mydubb.advance = false; // the job stays queued until the test completes it
  const { page, tabId, held, loaded } = await openHeldLecture(context, worker, 603);
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await panel.getByRole("textbox", { name: "English transcript" }).fill("Pasted before the video. Second line.");
  await panel.getByLabel("First sentence starts").fill("000010");
  await panel.getByLabel("Last sentence starts").fill("000056");
  const generate = panel.getByRole("button", { name: GENERATE });
  // No lecture, no video, no state: Generate is available all the same.
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect.poll(() => mydubb.posts("/api/jobs").length).toBe(1);
  const [jobId] = [...mydubb.jobs.keys()];
  await expect.poll(async () => (await sessionGet(worker, `job:${tabId}`)) as unknown).toMatchObject({ state: "created", jobId, lessonKey: "page" });

  // The video's information arrives now, after the POST and while the job still runs.
  held.release();
  await loaded;
  await expect(panel.locator("#lesson-label")).toHaveText("Lecture 603");
  await expect(panel.locator("#video-box")).toBeVisible();
  const video = await page.evaluate(() => window.fixture.state());
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  expect(await sessionGet(worker, `job:${tabId}`)).toMatchObject({ state: "created", jobId, lessonKey: "page" });
  await expect(panel.locator("#result-section")).toBeVisible();
  await expect(panel.getByText(/lecture changed/)).toHaveCount(0);

  // The job is still followed: it completes, its own translation appears and its audio plays.
  mydubb.complete(jobId!);
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("#translation")).toHaveText(`Bản dịch <b>${jobId}</b>`);
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  expect(await playerSessions(worker)).toMatchObject([{ tabId, lessonKey: "page", paused: true, currentTime: 0, rate: 1 }]);
  await panel.locator("#player-play").click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);
  // Not tied to the video that was found later: no Sync, and the video was not moved or touched.
  await expect(panel.locator("#sync")).toBeHidden();
  await expect(panel.locator("#player-floating")).toBeHidden();
  expect(await page.evaluate(() => window.fixture.state())).toEqual(video);
});

test("Udemy, video found after the audio is loaded and playing: the result stays, no Sync, no seek", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId, held, loaded } = await openHeldLecture(context, worker, 605);
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await panel.getByRole("textbox", { name: "English transcript" }).fill("Heard before the video.");
  await fillTimes(panel);
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  await panel.locator("#player-play").click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);
  const [playing] = await playerSessions(worker);

  held.release();
  await loaded;
  await expect(panel.locator("#lesson-label")).toHaveText("Lecture 605");
  const video = await page.evaluate(() => window.fixture.state());
  const sessions = await playerSessions(worker);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ tabId, lessonKey: "page", paused: false, rate: 1 });
  expect(sessions[0]!.currentTime).toBeGreaterThanOrEqual(playing!.currentTime);
  expect(sessions[0]!.sync.status).not.toBe("on");
  await expect(panel.locator("#translation")).toHaveText("Bản dịch <b>job-1</b>");
  await expect(panel.locator("#sync")).toBeHidden();
  expect(await sessionGet(worker, `job:${tabId}`)).toMatchObject({ lessonKey: "page", jobId: "job-1" });
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  expect(video).toMatchObject({ paused: true, currentTime: 0 }); // the lecture video was never seeked or played
});

test("a tab that navigates to a lecture after Generate on a page: the page's result stays until the lecture shows, then goes", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  const { page, tabId } = await openWebPage(context, worker, webUrl("heading-to-udemy"));
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  const generate = panel.getByRole("button", { name: GENERATE });
  await panel.getByRole("textbox", { name: "English transcript" }).fill("Page text.");
  await fillTimes(panel);
  await generate.click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();

  // The same tab commits a lecture page whose content script cannot attach yet.
  const held = holdLectureScript(context);
  await held.ready;
  const loaded = page.goto(lectureUrl(604, "?seconds=60"));
  await held.asked;
  await expect(generate).toBeEnabled();
  expect((await playerSessions(worker)).map((x) => x.lessonKey)).toEqual(["page"]);

  held.release();
  await loaded;
  await expect(panel.locator("#lesson-label")).toHaveText("Lecture 604");
  // A real change of page: it was made before the tab navigated, so it is not carried over.
  await expect.poll(() => playerSessions(worker)).toEqual([]);
  await expect(panel.locator("#result-section")).toBeHidden();
  expect(await sessionGet(worker, `job:${tabId}`)).toBeNull();
  await generate.click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);
  expect(await sessionGet(worker, `job:${tabId}`)).toMatchObject({ lessonKey: "demo-course/604" });
});

// ---- The panel is closed and opened again after the early result was confirmed for a lecture ------

/** Early Generate on a Udemy tab whose video is not known yet, then the tab reports the lecture. */
async function earlyGenerate(
  context: BrowserContext,
  worker: Worker,
  extensionId: string,
  mydubb: Parameters<typeof connectAccount>[1],
  id: number,
) {
  const { page, tabId, held, loaded } = await openHeldLecture(context, worker, id);
  const panel = await openPanel(context, extensionId, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await panel.getByRole("textbox", { name: "English transcript" }).fill("Generated before the video.");
  await fillTimes(panel);
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect.poll(() => mydubb.posts("/api/jobs").length).toBe(1);
  return { page, tabId, panel, held, loaded };
}

async function reopenedPanel(context: BrowserContext, extensionId: string, tabId: number, first: Page) {
  await first.close();
  const panel = await openPanel(context, extensionId, tabId);
  await expect(panel.locator("#account-status")).toHaveText("Connected as Lan");
  return panel;
}

test("reopened panel, job still running: it follows the job, then shows the translation and plays the audio", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  mydubb.advance = false;
  const { page, tabId, panel, held, loaded } = await earlyGenerate(context, worker, extensionId, mydubb, 607);
  const [jobId] = [...mydubb.jobs.keys()];
  held.release();
  await loaded;
  await expect(panel.locator("#lesson-label")).toHaveText("Lecture 607");
  await expect.poll(async () => await sessionGet(worker, `adopted:${tabId}`)).toMatchObject({ lessonKey: "demo-course/607" });
  const video = await page.evaluate(() => window.fixture.state());

  // Closed and opened again on the same tab, lecture and account, with the job still running.
  const again = await reopenedPanel(context, extensionId, tabId, panel);
  await expect(again.locator("#lesson-label")).toHaveText("Lecture 607");
  await expect(again.locator("#result-section")).toBeVisible();
  expect(await sessionGet(worker, `job:${tabId}`)).toMatchObject({ jobId, state: "created", lessonKey: "page" });
  mydubb.complete(jobId!);
  await expect(again.getByText("Ready. Press play when you want to listen.")).toBeVisible({ timeout: 20_000 });
  await expect(again.locator("#translation")).toHaveText(`Bản dịch <b>${jobId}</b>`);
  await again.locator("#player-play").click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);
  expect(await playerSessions(worker)).toMatchObject([{ tabId, lessonKey: "page", rate: 1 }]);
  // One POST in all; not tied to the video: no Sync, nothing moved.
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  await expect(again.locator("#sync")).toBeHidden();
  expect(await page.evaluate(() => window.fixture.state())).toEqual(video);
});

test("reopened panel, audio already loaded and playing: the same result is shown and the audio is not touched", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  const { page, tabId, panel, held, loaded } = await earlyGenerate(context, worker, extensionId, mydubb, 608);
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  held.release();
  await loaded;
  await expect(panel.locator("#lesson-label")).toHaveText("Lecture 608");
  await panel.locator("#player-play").click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);
  const video = await page.evaluate(() => window.fixture.state());

  const again = await reopenedPanel(context, extensionId, tabId, panel);
  await expect(again.locator("#lesson-label")).toHaveText("Lecture 608");
  await expect(again.locator("#translation")).toHaveText("Bản dịch <b>job-1</b>");
  await expect(again.locator("#result-section")).toBeVisible();
  await expect(again.locator("#player")).toBeVisible();
  const sessions = await playerSessions(worker);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ tabId, lessonKey: "page", paused: false, rate: 1 });
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  await expect(again.locator("#sync")).toBeHidden();
  expect(await page.evaluate(() => window.fixture.state())).toEqual(video);
});

test("reopened panel after the tab went to another lecture: nothing is restored, nothing is sent", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  const { page, tabId, panel, held, loaded } = await earlyGenerate(context, worker, extensionId, mydubb, 609);
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  held.release();
  await loaded;
  await expect(panel.locator("#lesson-label")).toHaveText("Lecture 609");
  await panel.close();

  // While the panel is closed the tab goes to a different lecture.
  await page.goto(lectureUrl(610, "?seconds=60"));
  await expect.poll(() => tabIdFor(worker, "demo-course/610").catch(() => -1)).toBe(tabId);
  const again = await openPanel(context, extensionId, tabId);
  await expect(again.locator("#lesson-label")).toHaveText("Lecture 610");
  await expect(again.locator("#result-section")).toBeHidden();
  await expect.poll(() => playerSessions(worker)).toEqual([]);
  for (const key of ["job", "loaded", "adopted"]) await expect.poll(() => sessionGet(worker, `${key}:${tabId}`)).toBeNull();
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
});
