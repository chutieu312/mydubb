// Browser tests of the real extension build in Chromium against synthetic fixture pages.
// They prove the local behaviour only; they are not evidence that it works on udemy.com.

import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "dist-test");
const fixtureHtml = readFileSync(join(here, "fixtures", "lecture.html"), "utf8");
const fixtureJs = readFileSync(join(here, "fixtures", "fixture.js"), "utf8");
const ORIGIN = "https://www.udemy.com";
const lectureUrl = (id: number, query = "") => `${ORIGIN}/course/demo-course/learn/lecture/${id}${query}`;

type Fixtures = { context: BrowserContext; worker: Worker; extensionId: string };

const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        // Fixture audio plays without a page gesture; the play() rejection path is unit-tested.
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    // Nothing leaves the machine: Udemy URLs get fixtures, everything else is refused.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      // The extension's own pages and scripts.
      if (url.protocol === "chrome-extension:") return route.continue();
      if (url.origin === ORIGIN && url.pathname === "/__fixture/fixture.js") {
        return route.fulfill({ contentType: "text/javascript", body: fixtureJs });
      }
      const lecture = /^\/course\/demo-course\/learn\/lecture\/(\d+)$/.exec(url.pathname);
      if (url.origin === ORIGIN && lecture) {
        return route.fulfill({ contentType: "text/html", body: fixtureHtml.replace("__LECTURE__", lecture[1]!) });
      }
      // A Udemy page that is not a lecture (course overview).
      if (url.origin === ORIGIN && /^\/course\/demo-course\/?$/.test(url.pathname)) {
        return route.fulfill({ contentType: "text/html", body: fixtureHtml.replace("Lecture __LECTURE__", "Course overview") });
      }
      if (url.origin === "https://example.test") {
        return route.fulfill({ contentType: "text/html", body: "<title>Other site</title><video></video>" });
      }
      return route.abort();
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
});

/** The tab id whose content script reports this lecture (tabs.query cannot see URLs without the "tabs" permission). */
async function tabIdFor(worker: Worker, lessonKey: string): Promise<number> {
  const id = await worker.evaluate(async (key) => {
    for (const tab of await chrome.tabs.query({})) {
      try {
        const reply = await chrome.tabs.sendMessage(tab.id!, { type: "mydubb:get-selection" }, { frameId: 0 });
        if (reply?.lesson?.key === key) return tab.id!;
      } catch {
        // not a tab with the content script
      }
    }
    return null;
  }, lessonKey);
  if (id === null) throw new Error(`no tab for ${lessonKey}`);
  return id;
}

async function openLecture(context: BrowserContext, worker: Worker, id: number, query = "") {
  const page = await context.newPage();
  await page.goto(lectureUrl(id, query));
  await expect.poll(() => page.evaluate(() => document.querySelector("video")?.readyState ?? 0)).toBeGreaterThan(0);
  let tabId = -1;
  await expect.poll(async () => (tabId = await tabIdFor(worker, `demo-course/${id}`).catch(() => -1))).toBeGreaterThan(-1);
  return { page, tabId };
}

async function openPanel(context: BrowserContext, extensionId: string, tabId: number): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
  return panel;
}

/** Selects the fixture transcript in the page, then runs the real "Send to MyDubb" handler. */
async function sendTranscriptSelection(page: Page, worker: Worker, tabId: number) {
  const expected = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("transcript")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  await worker.evaluate(
    ([tab, url]) =>
      (globalThis as unknown as { mydubbE2E: { sendSelection(t: number, s: string, u: string): Promise<unknown> } }).mydubbE2E.sendSelection(
        tab,
        "chrome collapsed text",
        url,
      ),
    [tabId, page.url()] as const,
  );
  return expected;
}

const sessionGet = (worker: Worker, key: string) =>
  worker.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, key);

test("selection reaches the panel unchanged; edited drafts are only replaced after confirmation", async ({ context, worker, extensionId }) => {
  const { page, tabId } = await openLecture(context, worker, 101);
  const panel = await openPanel(context, extensionId, tabId);
  await expect(panel.getByText("Lecture 101 | Demo Course | Udemy (lecture 101)")).toBeVisible();

  const expected = await sendTranscriptSelection(page, worker, tabId);
  expect(expected).toContain("\n");
  expect(expected).toContain("<b>");
  const textarea = panel.getByRole("textbox", { name: "Transcript selection" });
  await expect(textarea).toHaveValue(expected);
  await expect(panel.getByText(/Selection received/)).toBeVisible();
  // Called without a user gesture, sidePanel.open() fails: the toolbar button is flagged instead,
  // and the selection was still delivered.
  await expect.poll(() => worker.evaluate((tab) => chrome.action.getBadgeText({ tabId: tab }), tabId)).toBe("!");

  // An unedited draft is replaced silently.
  await sendTranscriptSelection(page, worker, tabId);
  await expect(panel.getByRole("alertdialog")).toBeHidden();

  // Edited: cancel keeps the edits, confirm replaces them.
  await textarea.fill("My edited draft");
  await sendTranscriptSelection(page, worker, tabId);
  const dialog = panel.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(panel.getByRole("button", { name: "Keep my draft" })).toBeFocused();
  await panel.getByRole("button", { name: "Keep my draft" }).click();
  await expect(textarea).toHaveValue("My edited draft");
  await expect(dialog).toBeHidden();
  await sendTranscriptSelection(page, worker, tabId);
  await panel.getByRole("button", { name: "Replace draft" }).click();
  await expect(textarea).toHaveValue(expected);

  // The draft is kept in session storage only, and Clear removes it.
  await expect.poll(() => sessionGet(worker, `draft:${tabId}`)).toMatchObject({ text: expected, lessonKey: "demo-course/101" });
  await panel.getByRole("button", { name: "Clear" }).click();
  await expect(textarea).toHaveValue("");
  await expect(panel.getByText("Draft cleared.")).toBeVisible();
  await expect.poll(() => sessionGet(worker, `draft:${tabId}`)).toBeNull();
});

test("empty selection is reported, not inserted", async ({ context, worker, extensionId }) => {
  const { page, tabId } = await openLecture(context, worker, 102);
  const panel = await openPanel(context, extensionId, tabId);
  await page.evaluate(() => document.getSelection()!.removeAllRanges());
  await worker.evaluate(
    ([tab, url]) => (globalThis as unknown as { mydubbE2E: { sendSelection(t: number, s: string, u: string): Promise<unknown> } }).mydubbE2E.sendSelection(tab, "   ", url),
    [tabId, page.url()] as const,
  );
  await expect(panel.getByText(/The selection was empty/)).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Transcript selection" })).toHaveValue("");
});

test("play, pause and seek drive the real video and the panel follows its events", async ({ context, worker, extensionId }) => {
  const { page, tabId } = await openLecture(context, worker, 103);
  const panel = await openPanel(context, extensionId, tabId);
  const play = panel.getByRole("button", { name: "Play video" });
  await expect(play).toBeEnabled();
  await expect(panel.locator("#time-duration")).toHaveText("0:30");
  const before = await page.evaluate(() => window.fixture.state());

  await play.click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.paused)).toBe(false);
  await expect(panel.getByRole("button", { name: "Pause video" })).toBeVisible();
  await panel.getByRole("button", { name: "Pause video" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.paused)).toBe(true);

  // Pausing/playing from the page itself is reflected (events, not just the clicked icon).
  await page.evaluate(() => window.fixture.videos()[0]!.play());
  await expect(panel.getByRole("button", { name: "Pause video" })).toBeVisible();
  await page.evaluate(() => window.fixture.videos()[0]!.pause());
  await expect(panel.getByRole("button", { name: "Play video" })).toBeVisible();

  // Seeks are clamped to the playable range.
  await page.evaluate(() => (window.fixture.videos()[0]!.currentTime = 2));
  await panel.getByRole("button", { name: "Back 5 seconds" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.currentTime)).toBe(0);
  await panel.getByRole("button", { name: "Forward 5 seconds" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.currentTime)).toBe(5);
  await expect(panel.locator("#time-current")).toHaveText("0:05");
  await page.evaluate(() => (window.fixture.videos()[0]!.currentTime = 28));
  await panel.getByRole("button", { name: "Forward 5 seconds" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.currentTime)).toBe(30);

  const after = await page.evaluate(() => window.fixture.state());
  expect([after!.muted, after!.volume, after!.rate]).toEqual([before!.muted, before!.volume, before!.rate]);
});

test("several videos: controls stay disabled until the user starts one, then follow only that one", async ({ context, worker, extensionId }) => {
  const { page, tabId } = await openLecture(context, worker, 104, "?videos=2");
  const panel = await openPanel(context, extensionId, tabId);
  await expect(panel.getByText(/Found 2 videos/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Play video" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Forward 5 seconds" })).toBeDisabled();

  await page.evaluate(() => window.fixture.videos()[1]!.play());
  await expect(panel.getByRole("button", { name: "Pause video" })).toBeEnabled();
  await panel.getByRole("button", { name: "Pause video" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state(1)!.paused)).toBe(true);
  await panel.getByRole("button", { name: "Forward 5 seconds" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state(1)!.currentTime)).toBeGreaterThan(4);
  expect(await page.evaluate(() => window.fixture.state(0))).toMatchObject({ paused: true, currentTime: 0 });
});

test("replaced video, SPA lecture change, reload and tab close", async ({ context, worker, extensionId }) => {
  const { page, tabId } = await openLecture(context, worker, 105);
  const panel = await openPanel(context, extensionId, tabId);
  const textarea = panel.getByRole("textbox", { name: "Transcript selection" });
  await sendTranscriptSelection(page, worker, tabId);
  await expect(textarea).not.toHaveValue("");

  // The player swaps its <video> element: controls re-attach, the draft stays.
  await page.evaluate(() => window.fixture.replaceVideo(30));
  await expect(panel.getByText(/video player was replaced/)).toBeVisible();
  await expect(textarea).not.toHaveValue("");
  await panel.getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.paused)).toBe(false);

  // SPA navigation to another lecture: draft cleared, new lecture and video linked.
  await page.evaluate(() => window.fixture.navigate(205));
  await expect(panel.getByText("Lecture 205 | Demo Course | Udemy (lecture 205)")).toBeVisible();
  await expect(panel.getByText(/The lecture changed\. The previous draft was cleared/)).toBeVisible();
  await expect(textarea).toHaveValue("");
  await expect.poll(() => sessionGet(worker, `draft:${tabId}`)).toBeNull();
  await expect(panel.locator("#time-duration")).toHaveText("0:20");
  await panel.getByRole("button", { name: "Forward 5 seconds" }).click();
  await expect.poll(() => page.evaluate(() => window.fixture.state()!.currentTime)).toBeGreaterThanOrEqual(5);

  // Reload of the same lecture: the panel reconnects and keeps the draft.
  await sendTranscriptSelection(page, worker, tabId);
  await expect(textarea).not.toHaveValue("");
  await page.reload();
  await expect(panel.getByText("Connected to the lecture tab.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Play video" })).toBeEnabled();
  await expect(textarea).not.toHaveValue("");

  // Tab closed: panel says so, controls off, session data removed.
  await page.close();
  await expect(panel.getByText(/linked tab was closed/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Play video" })).toBeDisabled();
  await expect.poll(() => sessionGet(worker, `draft:${tabId}`)).toBeNull();
});

test("panels are tied to one tab and never control another", async ({ context, worker, extensionId }) => {
  const a = await openLecture(context, worker, 106);
  const b = await openLecture(context, worker, 107);
  const panelA = await openPanel(context, extensionId, a.tabId);
  const panelB = await openPanel(context, extensionId, b.tabId);
  await sendTranscriptSelection(a.page, worker, a.tabId);
  await expect(panelA.getByRole("textbox", { name: "Transcript selection" })).not.toHaveValue("");
  await expect(panelB.getByRole("textbox", { name: "Transcript selection" })).toHaveValue("");
  await panelB.getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => b.page.evaluate(() => window.fixture.state()!.paused)).toBe(false);
  expect(await a.page.evaluate(() => window.fixture.state()!.paused)).toBe(true);

  // Opening a second panel for the same tab and closing it leaves the first one working.
  const extra = await openPanel(context, extensionId, a.tabId);
  await expect(extra.getByRole("button", { name: "Play video" })).toBeEnabled();
  await extra.close();
  await panelA.getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => a.page.evaluate(() => window.fixture.state()!.paused)).toBe(false);
});

test("unsupported tab and missing tab are reported with controls disabled", async ({ context, worker, extensionId }) => {
  const other = await context.newPage();
  await other.goto("https://example.test/");
  const otherId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs[tabs.length - 1]!.id!;
  });
  const panel = await openPanel(context, extensionId, otherId);
  await expect(panel.getByText(/MyDubb is not active in this tab/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Play video" })).toBeDisabled();
  // The web page has no channel into the extension.
  expect(await other.evaluate(() => typeof (window as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id)).toBe("undefined");

  const missing = await openPanel(context, extensionId, 999_999);
  await expect(missing.getByText(/linked tab was closed/)).toBeVisible();
  const unlinked = await context.newPage();
  await unlinked.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(unlinked.getByText(/not linked to a tab/)).toBeVisible();
});

test("a lecture's draft never survives a detour through a non-lecture page to another lecture", async ({ context, worker, extensionId }) => {
  const { page, tabId } = await openLecture(context, worker, 108);
  let panel = await openPanel(context, extensionId, tabId);
  await sendTranscriptSelection(page, worker, tabId);
  await panel.getByRole("textbox", { name: "Transcript selection" }).fill("Edited draft for lecture 108");
  await expect.poll(() => sessionGet(worker, `draft:${tabId}`)).toMatchObject({
    lessonKey: "demo-course/108",
    text: "Edited draft for lecture 108",
  });

  // Lecture A has a draft; close the panel and go to a Udemy page that is not a lecture.
  await panel.close();
  await page.goto(`${ORIGIN}/course/demo-course/?videos=0`);
  expect(await sessionGet(worker, `draft:${tabId}`)).toMatchObject({ lessonKey: "demo-course/108" });

  // Reopen the panel there: leaving the lecture is confirmed, so draft A is discarded.
  panel = await openPanel(context, extensionId, tabId);
  const textarea = panel.getByRole("textbox", { name: "Transcript selection" });
  await expect(panel.locator("#lesson-label")).toHaveText("Not a Udemy lecture page");
  await expect(panel.getByText(/You left the lecture\. The previous draft was cleared/)).toBeVisible();
  await expect(textarea).toHaveValue("");
  await expect.poll(() => sessionGet(worker, `draft:${tabId}`)).toBeNull();

  // SPA navigation to lecture B: linked to B, with no trace of A's draft.
  await page.evaluate(() => window.fixture.navigate(208));
  await expect(panel.getByText("Lecture 208 | Demo Course | Udemy (lecture 208)")).toBeVisible();
  await expect(textarea).toHaveValue("");
  expect(await sessionGet(worker, `draft:${tabId}`)).toBeNull();
  expect(await sessionGet(worker, `pending:${tabId}`)).toBeNull();

  // An edit whose debounced save is still pending cannot restore a draft after the lecture changes.
  await textarea.fill("Typed on lecture 208");
  await page.evaluate(() => window.fixture.navigate(209));
  await expect(panel.getByText("Lecture 209 | Demo Course | Udemy (lecture 209)")).toBeVisible();
  await expect(textarea).toHaveValue("");
  await panel.waitForTimeout(600); // longer than the 250 ms save debounce
  expect(await sessionGet(worker, `draft:${tabId}`)).toBeNull();

  // A new selection on the current lecture is accepted and stored under that lecture.
  await sendTranscriptSelection(page, worker, tabId);
  await expect(textarea).not.toHaveValue("");
  await expect.poll(() => sessionGet(worker, `draft:${tabId}`)).toMatchObject({ lessonKey: "demo-course/209" });
});
