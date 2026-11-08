// Story 1 in the real extension build: transcript, Generate and playback on an ordinary web page
// (no Udemy lecture, no video, no content script), against the fake MyDubb server of harness.ts and
// synthetic fixture pages (a stand-in for a video host, never the real loom.com). Local evidence
// only: the native "Send to MyDubb" context menu cannot be clicked by Playwright, so those tests
// call the real worker handler with the text Chrome would pass; the menu itself is accepted by hand.

import {
  HTTP_ORIGIN,
  allowConnect,
  connectAccount,
  disconnect,
  expect,
  fillTimes,
  openLecture,
  openPanel,
  openWebPage,
  playerSessions,
  selectTranscript,
  sendMenuSelection,
  sessionGet,
  test,
  webUrl,
} from "./harness";

const GENERATE = "Generate audio";

test("paste a transcript on a page without video, Generate and listen", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openWebPage(context, worker, webUrl("abc123"));
  const panel = await openPanel(context, extensionId, tabId);
  const textarea = panel.getByRole("textbox", { name: "English transcript" });

  // No lecture: no video controls, and the panel says so without calling it an error.
  await expect(panel.locator("#link-status")).toContainText("No Udemy lecture is linked to this tab");
  await expect(panel.locator("#video-box")).toBeHidden();
  await expect(panel.locator("#lesson-label")).toHaveText("Not a Udemy lecture");
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
  await expect(panel.locator("#link-status")).toContainText("No Udemy lecture is linked", { timeout: 20_000 });
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
