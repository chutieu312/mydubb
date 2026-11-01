// Story 2 in the real extension build: connect a MyDubb account, generate, follow the job and
// play the MP3 in the panel, against the fake MyDubb server of harness.ts (https://mydubb.test)
// and the synthetic Udemy fixtures. Local evidence only: not the real udemy.com or mydubb.com.

import {
  MYDUBB,
  connectAccount,
  disconnect,
  expect,
  fillTimes,
  openLecture,
  openPanel,
  playerSessions,
  sendTranscriptSelection,
  sessionGet,
  test,
} from "./harness";

test("connect, generate with the chosen options and listen in the panel", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 301);
  const panel = await openPanel(context, extensionId, tabId);
  const expected = await sendTranscriptSelection(page, worker, tabId);
  const textarea = panel.getByRole("textbox", { name: "English transcript" });
  await expect(textarea).toHaveValue(expected);
  await expect(panel.getByText(/Not connected/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Generate audio" })).toBeDisabled();
  // Nothing went to MyDubb but its public options.
  expect(mydubb.requests.map((r) => r.path)).toEqual(["/api/meta"]);

  await connectAccount(panel, mydubb, extensionId);
  const auth = (await sessionGet(worker, "auth")) as { token: string };
  expect(auth.token).toBeTruthy();
  // The token never reaches the Udemy page.
  expect(await page.content()).not.toContain(auth.token);

  await textarea.fill(`${expected}\nEdited in the panel.`);
  await fillTimes(panel);
  await expect(panel.getByLabel("First sentence starts")).toHaveValue("00:00:10");
  await panel.getByRole("combobox", { name: "Translate to" }).selectOption("arabic");
  await panel.getByLabel("Voice").selectOption("EmmaMultilingual");
  await panel.getByRole("radio", { name: "1.5x", exact: true }).check();
  await expect(panel.locator("#length-summary")).toContainText("00:04:00");
  await panel.getByRole("button", { name: "Generate audio" }).click();

  // Accepted: the job shows under Your audio, on the same page; the form keeps its values and
  // the focus stays on Generate.
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Generate audio" })).toBeFocused();
  await expect(panel.getByRole("radio", { name: "1.5x", exact: true })).toBeChecked();
  const [post] = mydubb.posts("/api/jobs");
  expect(post?.body).toEqual({
    transcript: `${expected}\nEdited in the panel.`,
    first_sentence_start: "00:00:10",
    last_sentence_start: "00:06:10",
    voice: "EmmaMultilingual",
    speed: 1.5,
    target_language: "arabic",
  });
  expect(post?.headers.authorization).toBe(`Bearer ${auth.token}`);
  expect(post?.headers.cookie).toBeUndefined();
  expect(post?.headers.origin).toBe(`chrome-extension://${extensionId}`);
  // Only the transcript and choices are sent: no Udemy URL, title or lecture id.
  expect(JSON.stringify(post?.body)).not.toContain("udemy");
  expect(JSON.stringify(post?.body)).not.toContain("301");

  const translation = panel.locator("#translation");
  await expect(translation).toHaveText("Bản dịch <b>job-1</b>");
  await expect(translation).toBeVisible();
  await expect(translation.locator("b")).toHaveCount(0);
  await expect(panel.locator("#job-choices")).toContainText("Emma Multilingual");
  await expect(panel.locator("#job-choices")).toContainText("1.5x");
  // The panel has no audio element of its own: the tab's session plays in the offscreen document.
  expect(await panel.locator("audio").count()).toBe(0);
  await expect.poll(async () => (await playerSessions(worker))[0]?.duration ?? 0).toBeGreaterThan(0);
  expect(await playerSessions(worker)).toMatchObject([{ tabId, paused: true, rate: 1, blobSrc: true }]);
  // The audio was fetched with the token, not by the <audio> element itself.
  const [audioGet] = mydubb.gets("/api/jobs/job-1/result/audio");
  expect(audioGet?.headers.authorization).toBe(`Bearer ${auth.token}`);

  // Story 1 controls still drive the Udemy video, separately from the MyDubb player.
  await panel.getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.paused)).toBe(false);
  expect((await playerSessions(worker))[0]?.paused).toBe(true);
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);
  expect((await playerSessions(worker))[0]?.rate).toBe(1);
  // And the MyDubb player never touches the video's volume, mute or rate.
  expect(await page.evaluate(() => window.fixture.state())).toMatchObject({ muted: false, volume: 1, rate: 1 });
});

test("closing the panel neither cancels nor resends; reopening and reloading resume the job", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 302);
  let panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  mydubb.advance = false;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText("Queued…")).toBeVisible();
  await panel.close();

  // Closing the panel did not cancel anything (there is no cancel call) and nothing was resent.
  // Reopened, it shows the job it follows.
  panel = await openPanel(context, extensionId, tabId);
  await expect(panel.getByText("Queued…")).toBeVisible();
  await page.reload();
  await expect(panel.locator("#link-detail")).toHaveText("Connected to the lecture tab.");
  mydubb.complete("job-1");
  mydubb.advance = true;
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible({ timeout: 20_000 });
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  expect(mydubb.requests.some((r) => r.method !== "GET" && r.path.startsWith("/api/jobs/"))).toBe(false);

  // A stopped service worker changes nothing for the panel, which follows jobs itself.
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await panel.getByRole("radio", { name: "2x", exact: true }).check();
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.locator("#job-choices")).toContainText("2x");
  // The audio loaded for the first job stays until the user switches to the new result.
  const callout = panel.locator("#result-switch");
  await expect(callout).toBeVisible({ timeout: 20_000 });
  await expect(callout).toContainText("New audio ready");
  await expect(panel.locator("#player-badge")).toHaveText("Earlier result");
  // The translation shown is the loaded audio's, not the waiting result's.
  await expect(panel.locator("#translation")).toHaveText("Bản dịch <b>job-1</b>");
  expect(mydubb.gets("/api/jobs/job-2/result/audio")).toHaveLength(0);
  // Narrow panel: the callout and the loaded-audio block stay inside the viewport.
  await panel.setViewportSize({ width: 320, height: 700 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.screenshot({ path: test.info().outputPath("earlier-and-new.png"), fullPage: true });
  await callout.getByRole("button", { name: "Use new audio" }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  await expect(panel.locator("#player-info")).toContainText("Vietnamese");
  await expect(panel.locator("#player-info")).toContainText("2x");
  await expect(panel.locator("#translation")).toHaveText("Bản dịch <b>job-2</b>");
  await expect(callout).toBeHidden();
  await expect(panel.locator("#result-using")).toBeVisible();
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);
});

test("a request without an answer is never resent and is reported as unknown", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 303);
  let panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  mydubb.createAnswers = ["drop"];
  await panel.getByRole("button", { name: "Generate audio" }).dblclick();
  // Said beside the Generate button (no confirmation came, so the form stays shown).
  await expect(panel.getByText(/not known whether the job was created/)).toBeVisible();
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  panel = await openPanel(context, extensionId, tabId);
  await expect(panel.getByText(/not known whether the job was created/)).toBeVisible();
  await panel.waitForTimeout(500);
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);

  // A refusal is shown as such and creates nothing.
  mydubb.createAnswers = [503];
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(/MyDubb is busy/)).toBeVisible();
});

test("a job of lecture A is never shown under lecture B, nor in another tab", async ({ context, worker, extensionId, mydubb }) => {
  const a = await openLecture(context, worker, 304);
  const b = await openLecture(context, worker, 404);
  const panelA = await openPanel(context, extensionId, a.tabId);
  const panelB = await openPanel(context, extensionId, b.tabId);
  await sendTranscriptSelection(a.page, worker, a.tabId);
  await connectAccount(panelA, mydubb, extensionId);
  // Both panels share the connection, not the job.
  await expect(panelB.locator("#account-status")).toHaveText("Connected as Lan");
  await fillTimes(panelA);
  mydubb.advance = false;
  await panelA.getByRole("button", { name: "Generate audio" }).click();
  await expect(panelA.getByText("Queued…")).toBeVisible();
  await expect(panelB.locator("#result-section")).toBeHidden();

  // Tab A moves to another lecture while the job runs; the job finishes afterwards.
  await a.page.evaluate(() => window.fixture.navigate(305));
  await expect(panelA.getByText(/lecture changed. A job already sent keeps running/)).toBeVisible();
  await expect(panelA.locator("#result-section")).toBeHidden();
  mydubb.complete("job-1");
  mydubb.advance = true;
  await panelA.waitForTimeout(1500);
  expect(mydubb.gets("/api/jobs/job-1/result")).toHaveLength(0);
  expect(await playerSessions(worker)).toEqual([]);
  expect(await sessionGet(worker, `job:${a.tabId}`)).toBeNull();
  await expect(panelB.locator("#result-section")).toBeHidden();
});

test("disconnecting or an ended session clears every panel and its result", async ({ context, worker, extensionId, mydubb }) => {
  const a = await openLecture(context, worker, 306);
  const b = await openLecture(context, worker, 406);
  const panelA = await openPanel(context, extensionId, a.tabId);
  const panelB = await openPanel(context, extensionId, b.tabId);
  await sendTranscriptSelection(a.page, worker, a.tabId);
  await connectAccount(panelA, mydubb, extensionId);
  await fillTimes(panelA);
  await panelA.getByRole("button", { name: "Generate audio" }).click();
  await expect(panelA.getByText("Ready. Press play when you want to listen.")).toBeVisible();

  await disconnect(panelB);
  await expect(panelA.getByRole("button", { name: "Connect MyDubb" })).toBeVisible();
  await expect(panelA.locator("#result-section")).toBeHidden();
  await expect.poll(() => playerSessions(worker)).toEqual([]);
  await expect(panelA.getByRole("button", { name: "Generate audio" })).toBeDisabled();
  expect(await sessionGet(worker, "auth")).toBeNull();
  await expect.poll(() => mydubb.posts("/api/extension/logout").length).toBe(1);
  // The draft is the user's selection from Udemy, not account data: it stays.
  await expect(panelA.locator("#transcript")).not.toHaveValue("");

  // Connected again, the server ends the session meanwhile: the panel asks to connect again.
  await connectAccount(panelA, mydubb, extensionId);
  mydubb.revokeAll();
  mydubb.advance = false;
  await panelA.getByRole("button", { name: "Generate audio" }).click();
  await expect(panelA.getByText(/connection ended/)).toBeVisible();
  expect(await sessionGet(worker, "auth")).toBeNull();
  expect(mydubb.requests.every((r) => new URL(MYDUBB + r.path).origin === MYDUBB)).toBe(true);
});

test("opening the panel with a new timestamped selection is not undone by the stored form", async ({ context, worker, extensionId }) => {
  const { tabId } = await openLecture(context, worker, 307);
  // An older form of this tab and lecture, and a selection with new caption times waiting for the panel.
  await worker.evaluate(
    async ([tab, lesson]) => {
      await chrome.storage.session.set({
        [`form:${tab}`]: {
          lessonKey: lesson,
          firstStart: "00:00:10",
          lastStart: "00:06:10",
          ignoreTimestamps: false,
          targetLanguage: "arabic",
          voice: "EmmaMultilingual",
          speed: 1.5,
          filledFrom: null,
        },
        [`pending:${tab}`]: { id: "sel-1", text: "0:01\nFirst caption.\n0:21\nLast caption.", problem: null, lessonKey: lesson, at: Date.now() },
      });
    },
    [tabId, "demo-course/307"] as const,
  );
  const panel = await openPanel(context, extensionId, tabId);
  await expect(panel.getByRole("textbox", { name: "English transcript" })).toHaveValue("0:01\nFirst caption.\n0:21\nLast caption.");
  await expect(panel.getByLabel("First sentence starts")).toHaveValue("00:00:01");
  await expect(panel.getByLabel("Last sentence starts")).toHaveValue("00:00:21");
  await expect(panel.getByRole("radio", { name: "1.5x", exact: true })).toBeChecked();
  await panel.waitForTimeout(500);
  await expect(panel.getByLabel("First sentence starts")).toHaveValue("00:00:01");
});
