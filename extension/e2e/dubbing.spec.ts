// Story 2 in the real extension build: connect a MyDubb account, generate, follow the job and
// play the MP3 in the panel, against the fake MyDubb server of harness.ts (https://mydubb.test)
// and the synthetic Udemy fixtures. Local evidence only: not the real udemy.com or mydubb.com.

import type { Page } from "@playwright/test";

import { MYDUBB, allowConnect, expect, openLecture, openPanel, sendTranscriptSelection, sessionGet, test, type FakeMyDubb } from "./harness";

async function connectAccount(panel: Page, mydubb: FakeMyDubb, extensionId: string) {
  await allowConnect(panel, mydubb, extensionId);
  await panel.getByRole("button", { name: "Connect MyDubb" }).click();
  await expect(panel.getByText("Connected as Lan (lan@example.com).")).toBeVisible();
}

async function fillTimes(panel: Page) {
  await panel.getByLabel("First Sentence Start Time").fill("000010");
  await panel.getByLabel("Last Sentence Start Time").fill("000610");
}

test("connect, generate with the chosen options and listen in the panel", async ({ context, worker, extensionId, mydubb }) => {
  const { page, tabId } = await openLecture(context, worker, 301);
  const panel = await openPanel(context, extensionId, tabId);
  const expected = await sendTranscriptSelection(page, worker, tabId);
  const textarea = panel.getByRole("textbox", { name: "Transcript selection" });
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
  await expect(panel.getByLabel("First Sentence Start Time")).toHaveValue("00:00:10");
  await panel.getByLabel("Translate to").selectOption("arabic");
  await panel.getByLabel("Voice").selectOption("EmmaMultilingual");
  await panel.getByLabel("Audio speed").selectOption("1.5");
  await expect(panel.locator("#length-summary")).toContainText("00:04:00");
  await panel.getByRole("button", { name: "Generate audio" }).click();

  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
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
  await expect(translation.locator("b")).toHaveCount(0);
  await expect(panel.locator("#job-choices")).toContainText("Emma Multilingual");
  await expect(panel.locator("#job-choices")).toContainText("1.5x");
  const audio = panel.locator("#result-audio");
  await expect(audio).toHaveAttribute("src", /^blob:chrome-extension:/);
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0);
  expect(await audio.evaluate((a: HTMLAudioElement) => ({ paused: a.paused, rate: a.playbackRate, duration: a.duration }))).toMatchObject({
    paused: true,
    rate: 1,
  });
  expect(await audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(0);
  // The audio was fetched with the token, not by the <audio> element itself.
  const [audioGet] = mydubb.gets("/api/jobs/job-1/result/audio");
  expect(audioGet?.headers.authorization).toBe(`Bearer ${auth.token}`);

  // Story 1 controls still drive the Udemy video, separately from the MyDubb player.
  await panel.getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.paused)).toBe(false);
  expect(await audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await audio.evaluate((a: HTMLAudioElement) => a.play());
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
  expect(await audio.evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(1);
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
  panel = await openPanel(context, extensionId, tabId);
  await expect(panel.getByText("Queued…")).toBeVisible();
  await page.reload();
  await expect(panel.getByText("Connected to the lecture tab.")).toBeVisible();
  mydubb.complete("job-1");
  mydubb.advance = true;
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible({ timeout: 20_000 });
  expect(mydubb.posts("/api/jobs")).toHaveLength(1);
  expect(mydubb.requests.some((r) => r.method !== "GET" && r.path.startsWith("/api/jobs/"))).toBe(false);

  // A stopped service worker changes nothing for the panel, which follows jobs itself.
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await panel.getByLabel("Audio speed").selectOption("2");
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.locator("#job-choices")).toContainText("2x");
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible({ timeout: 20_000 });
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
  await expect(panelB.getByText("Connected as Lan (lan@example.com).")).toBeVisible();
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
  await expect(panelA.locator("#result-audio")).not.toHaveAttribute("src", /.+/);
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

  await panelB.getByRole("button", { name: "Disconnect" }).click();
  await expect(panelA.getByRole("button", { name: "Connect MyDubb" })).toBeVisible();
  await expect(panelA.locator("#result-section")).toBeHidden();
  await expect(panelA.locator("#result-audio")).not.toHaveAttribute("src", /.+/);
  await expect(panelA.getByRole("button", { name: "Generate audio" })).toBeDisabled();
  expect(await sessionGet(worker, "auth")).toBeNull();
  await expect.poll(() => mydubb.posts("/api/extension/logout").length).toBe(1);
  // The draft is the user's selection from Udemy, not account data: it stays.
  await expect(panelA.getByRole("textbox", { name: "Transcript selection" })).not.toHaveValue("");

  // Connected again, the server ends the session meanwhile: the panel asks to connect again.
  await connectAccount(panelA, mydubb, extensionId);
  mydubb.revokeAll();
  mydubb.advance = false;
  await panelA.getByRole("button", { name: "Generate audio" }).click();
  await expect(panelA.getByText(/connection ended/)).toBeVisible();
  expect(await sessionGet(worker, "auth")).toBeNull();
  expect(mydubb.requests.every((r) => new URL(MYDUBB + r.path).origin === MYDUBB)).toBe(true);
});
