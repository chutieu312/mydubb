// The side panel's two tabs, Create audio and Listen, in the real extension build: keyboard use,
// focus, what moves between them and what never does (the draft, the job, the playback), at the
// width of a real side panel. Against the fake MyDubb server and the synthetic Udemy fixtures:
// local evidence only, not the real udemy.com or mydubb.com.

import type { Page, Worker } from "@playwright/test";

import { connectAccount, expect, fillTimes, openLecture, openPanel, playerSessions, sendTranscriptSelection, showTab, test } from "./harness";

const READY = "Ready. Press play when you want to listen.";
// Chrome's side panel opens about this wide; 320 px is its narrowest.
const PANEL = { width: 360, height: 900 };

const selected = (panel: Page, name: string) => expect(panel.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
const noSideScroll = (panel: Page) => panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const sessionOf = async (worker: Worker, tabId: number) => (await playerSessions(worker)).find((s) => s.tabId === tabId) ?? null;

test("keyboard and focus: arrow keys switch tabs, the hidden panel is out of the tab order", async ({ context, worker, extensionId }) => {
  const { tabId } = await openLecture(context, worker, 701);
  const panel = await openPanel(context, extensionId, tabId);
  await panel.setViewportSize(PANEL);
  const create = panel.getByRole("tab", { name: "Create audio" });
  const listen = panel.getByRole("tab", { name: "Listen" });
  await selected(panel, "Create audio");
  await expect(panel.getByRole("tablist")).toBeVisible();
  await expect(panel.getByRole("tabpanel")).toHaveCount(1);

  await create.focus();
  await panel.keyboard.press("ArrowRight");
  await selected(panel, "Listen");
  await expect(listen).toBeFocused();
  // Without a job or audio: a short empty state, not a list of disabled controls.
  await expect(panel.getByText("No audio yet.")).toBeVisible();
  await expect(panel.locator("#player-section")).toBeHidden();
  await expect(panel.locator("#result-section")).toBeHidden();
  // Tab from the selected tab goes into its own panel, never into the hidden one.
  await panel.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Create audio" })).toBeFocused();
  await panel.keyboard.press("Enter");
  await selected(panel, "Create audio");
  await expect(create).toBeFocused();
  await panel.keyboard.press("Tab");
  await expect(panel.getByRole("textbox", { name: "Transcript selection" })).toBeFocused();
  await create.focus();
  await panel.keyboard.press("End");
  await selected(panel, "Listen");
  await panel.keyboard.press("Home");
  await selected(panel, "Create audio");
  await panel.keyboard.press("ArrowLeft");
  await selected(panel, "Listen");
  // The unselected tab is skipped by Tab; only the arrows reach it.
  expect(await create.getAttribute("tabindex")).toBe("-1");
  expect(await listen.getAttribute("tabindex")).toBe("0");
  expect(await noSideScroll(panel)).toBe(true);
});

test("Generate → Listen; edit the form while the job runs; the result waits; playback survives tab switches and reopening", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(60_000);
  const { page, tabId } = await openLecture(context, worker, 702);
  const panel = await openPanel(context, extensionId, tabId);
  await panel.setViewportSize(PANEL);
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  await panel.screenshot({ path: test.info().outputPath("tab-create.png"), fullPage: true });
  expect(await noSideScroll(panel)).toBe(true);

  // Refused: the form stays, with the field to fix focused and its message beside it.
  mydubb.createAnswers = [422];
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await selected(panel, "Create audio");
  await expect(panel.getByLabel("Last Sentence Start Time")).toBeFocused();
  await expect(panel.getByLabel("Last Sentence Start Time")).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByText("Must be after the first sentence start time.")).toBeVisible();
  await expect(panel.getByText("Check the highlighted fields.")).toBeVisible();

  // Accepted: Listen with that job; nothing plays.
  mydubb.advance = false;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await selected(panel, "Listen");
  await expect(panel.getByText("Queued…")).toBeVisible();
  await expect(panel.locator("#job-choices")).toContainText("Andrew Multilingual");

  // Back to the form while it runs: the job completes, the user is not pulled away.
  await showTab(panel, "Create audio");
  // By id: it is checked while Listen is shown too (role queries skip hidden panels).
  const textarea = panel.locator("#transcript");
  await textarea.focus();
  await panel.keyboard.press("End");
  await panel.keyboard.type(" More.");
  mydubb.complete("job-1");
  mydubb.advance = true;
  await expect.poll(async () => (await sessionOf(worker, tabId))?.duration ?? 0, { timeout: 20_000 }).toBeGreaterThan(25);
  await selected(panel, "Create audio");
  await expect(textarea).toBeFocused();
  await expect(textarea).toHaveValue(/ More\.$/);
  // Said with a word on the Listen tab, not only a color.
  await expect(panel.getByRole("tab", { name: "Listen" })).toContainText("New");
  expect((await sessionOf(worker, tabId))!.paused).toBe(true);

  await showTab(panel, "Listen");
  await expect(panel.locator("#listen-badge")).toBeHidden();
  await expect(panel.getByText(READY)).toBeVisible();
  await panel.screenshot({ path: test.info().outputPath("tab-listen.png"), fullPage: true });
  expect(await noSideScroll(panel)).toBe(true);
  // The translation can be selected (and so copied).
  await panel.locator("#result-details summary").click();
  await expect(panel.locator("#translation")).toBeVisible();
  const picked = await panel.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("translation")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(picked).toBe("Bản dịch <b>job-1</b>");
  expect(await panel.locator("#translation").evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
  expect(await noSideScroll(panel)).toBe(true);

  // Playing; switching tabs changes nothing of the playback, and asks nothing of MyDubb.
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await sessionOf(worker, tabId))?.paused).toBe(false);
  const requests = mydubb.requests.length;
  for (const name of ["Create audio", "Listen", "Create audio", "Listen"] as const) await showTab(panel, name);
  const before = (await sessionOf(worker, tabId))!.currentTime;
  await panel.waitForTimeout(800);
  const after = (await sessionOf(worker, tabId))!;
  expect(after.paused).toBe(false);
  expect(after.currentTime).toBeGreaterThan(before);
  expect(mydubb.requests.length).toBe(requests);
  await expect(textarea).toHaveValue(/ More\.$/);

  // Narrowest side panel: neither tab scrolls sideways.
  await panel.setViewportSize({ width: 320, height: 700 });
  expect(await noSideScroll(panel)).toBe(true);
  await showTab(panel, "Create audio");
  expect(await noSideScroll(panel)).toBe(true);

  // Closed and reopened: Listen again, on the same session; no download, no job.
  await panel.close();
  const reopened = await openPanel(context, extensionId, tabId);
  await selected(reopened, "Listen");
  await expect(reopened.getByRole("button", { name: "Pause MyDubb audio" })).toBeVisible();
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);
  expect(mydubb.gets("/api/jobs/job-1/result/audio")).toHaveLength(1);
  expect((await sessionOf(worker, tabId))!.paused).toBe(false);
});
