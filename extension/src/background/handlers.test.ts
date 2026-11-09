import { describe, expect, it, vi } from "vitest";
import { MAX_SELECTION_CHARS } from "../shared/messages";
import { MENU_ID, MENU_ITEM, handleAuthChanged, handleMenuClick, handleTabRemoved, reachPage, type WorkerApi } from "./handlers";

const lesson = { key: "c/1", courseSlug: "c", lectureId: "1", title: "L" };
const PAGE = "https://www.udemy.com/course/c/learn/lecture/1";

function fakeApi(reply: unknown | Error) {
  const calls: string[] = [];
  const api = {
    sidePanel: {
      setOptions: vi.fn(async () => void calls.push("setOptions")),
      open: vi.fn(async () => void calls.push("open")),
    },
    tabsSendMessage: vi.fn(async () => {
      calls.push("sendMessage");
      if (reply instanceof Error) throw reply;
      return reply;
    }),
    session: { set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    notifyPlayer: vi.fn<WorkerApi["notifyPlayer"]>(async () => undefined),
    injectPage: vi.fn<WorkerApi["injectPage"]>(async () => void calls.push("inject")),
    notifyPanel: vi.fn<WorkerApi["notifyPanel"]>(async () => undefined),
    action: { setBadgeText: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) },
    randomId: () => "id-1",
    now: () => 42,
  };
  return { api: api as unknown as WorkerApi & typeof api, calls };
}

const click = (extra: Partial<chrome.contextMenus.OnClickData> = {}) =>
  ({ menuItemId: MENU_ID, selectionText: "collapsed text", frameId: 0, pageUrl: PAGE, ...extra }) as chrome.contextMenus.OnClickData;

describe("the menu item", () => {
  it("is offered for selected text on any http(s) page only, without asking for site access", () => {
    expect(MENU_ITEM).toEqual({
      id: MENU_ID,
      title: "Send to MyDubb",
      contexts: ["selection"],
      documentUrlPatterns: ["https://*/*", "http://*/*"],
    });
  });
});

describe("handleMenuClick", () => {
  it("opens the tab's own panel before any await, then stores the exact selection", async () => {
    const text = "Line one\n  Line two <b>";
    const { api, calls } = fakeApi({ type: "mydubb:selection", text, tooLong: false, lesson });
    const pending = await handleMenuClick(api, click(), { id: 9 });
    expect(calls.slice(0, 2)).toEqual(["setOptions", "open"]);
    expect(api.sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 9, path: "sidepanel.html?tabId=9", enabled: true });
    expect(api.sidePanel.open).toHaveBeenCalledWith({ tabId: 9 });
    expect(api.tabsSendMessage).toHaveBeenCalledWith(9, { type: "mydubb:get-selection" }, { frameId: 0 });
    expect(pending).toEqual({ id: "id-1", text, problem: null, lessonKey: "c/1", at: 42 });
    expect(api.session.set).toHaveBeenCalledWith({ "pending:9": pending });
  });

  it("falls back to Chrome's selection text when the content script is unreachable", async () => {
    const { api } = fakeApi(new Error("Receiving end does not exist"));
    expect(await handleMenuClick(api, click(), { id: 3 })).toMatchObject({ text: "collapsed text", lessonKey: null, problem: null });
  });

  it("ignores malformed replies and uses the fallback", async () => {
    const { api } = fakeApi({ type: "mydubb:selection", text: 5 });
    expect(await handleMenuClick(api, click(), { id: 3 })).toMatchObject({ text: "collapsed text", lessonKey: null });
  });

  it("does not ask iframes (no content script there)", async () => {
    const { api } = fakeApi({ type: "mydubb:selection", text: "x", tooLong: false, lesson });
    await handleMenuClick(api, click({ frameId: 4 }), { id: 3 });
    expect(api.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("records an empty or oversized selection as a problem, not text", async () => {
    const empty = fakeApi({ type: "mydubb:selection", text: "  \n", tooLong: false, lesson });
    expect(await handleMenuClick(empty.api, click({ selectionText: " " }), { id: 1 })).toMatchObject({ text: "", problem: "empty" });
    const long = fakeApi({ type: "mydubb:selection", text: "", tooLong: true, lesson });
    expect(await handleMenuClick(long.api, click(), { id: 1 })).toMatchObject({ text: "", problem: "too-long" });
  });

  it("ignores other menu items, tabless clicks and pages that are not http(s)", async () => {
    const { api } = fakeApi(null);
    expect(await handleMenuClick(api, click({ menuItemId: "other" }), { id: 1 })).toBeNull();
    expect(await handleMenuClick(api, click(), undefined)).toBeNull();
    expect(await handleMenuClick(api, click(), { id: -1 })).toBeNull();
    for (const pageUrl of [undefined, "", "not a url", "file:///C:/notes.txt", "chrome://settings", "chrome-extension://abc/sidepanel.html", "ftp://example.test/a"]) {
      expect(await handleMenuClick(api, click({ pageUrl }), { id: 1 })).toBeNull();
    }
    expect(api.sidePanel.open).not.toHaveBeenCalled();
    expect(api.session.set).not.toHaveBeenCalled();
  });

  describe("on an ordinary web page", () => {
    const LOOM = "https://www.loom.com/share/abc123";

    it("opens the tab's panel and hands over Chrome's selection text; no content script is asked", async () => {
      const { api, calls } = fakeApi(new Error("there is no content script here"));
      const text = "0:05\nFirst caption.\n0:21\nLast caption.";
      const pending = await handleMenuClick(api, click({ pageUrl: LOOM, selectionText: text }), { id: 12 });
      // The page itself is only injected (for its video), never asked for the selection.
      expect(calls).toEqual(["setOptions", "open", "inject"]);
      expect(api.sidePanel.open).toHaveBeenCalledWith({ tabId: 12 });
      expect(api.tabsSendMessage).not.toHaveBeenCalled();
      // The text as Chrome gave it: nothing reformatted or guessed (timestamps stay where they are).
      expect(pending).toEqual({ id: "id-1", text, problem: null, lessonKey: null, at: 42 });
      expect(api.session.set).toHaveBeenCalledWith({ "pending:12": pending });
    });

    it("accepts http pages and a selection inside an iframe", async () => {
      const { api } = fakeApi(null);
      expect(await handleMenuClick(api, click({ pageUrl: "http://intranet.test/notes", selectionText: "Hello" }), { id: 1 })).toMatchObject({
        text: "Hello",
        problem: null,
      });
      expect(
        await handleMenuClick(api, click({ pageUrl: LOOM, frameId: 3, frameUrl: "https://embed.example/player", selectionText: "In a frame" }), { id: 2 }),
      ).toMatchObject({ text: "In a frame", lessonKey: null });
      expect(api.tabsSendMessage).not.toHaveBeenCalled();
    });

    it("records an empty selection or one over the limit as a problem, never as text", async () => {
      const { api } = fakeApi(null);
      expect(await handleMenuClick(api, click({ pageUrl: LOOM, selectionText: "  \n " }), { id: 1 })).toMatchObject({ text: "", problem: "empty" });
      expect(await handleMenuClick(api, click({ pageUrl: LOOM, selectionText: undefined }), { id: 1 })).toMatchObject({ text: "", problem: "empty" });
      expect(await handleMenuClick(api, click({ pageUrl: LOOM, selectionText: "a".repeat(MAX_SELECTION_CHARS) }), { id: 1 })).toMatchObject({
        problem: null,
      });
      expect(await handleMenuClick(api, click({ pageUrl: LOOM, selectionText: "a".repeat(MAX_SELECTION_CHARS + 1) }), { id: 1 })).toMatchObject({
        text: "",
        problem: "too-long",
      });
    });

    it("does not treat a look-alike address as Udemy", async () => {
      const { api } = fakeApi({ type: "mydubb:selection", text: "from a script", tooLong: false, lesson });
      const pending = await handleMenuClick(api, click({ pageUrl: "https://www.udemy.com.evil.test/course/c/learn/lecture/1" }), { id: 1 });
      expect(api.tabsSendMessage).not.toHaveBeenCalled();
      expect(pending).toMatchObject({ text: "collapsed text", lessonKey: null });
    });
  });

  it("flags the toolbar button when the panel cannot open, and still stores the selection", async () => {
    const { api } = fakeApi({ type: "mydubb:selection", text: "t", tooLong: false, lesson });
    api.sidePanel.open.mockRejectedValueOnce(new Error("no gesture"));
    await handleMenuClick(api, click(), { id: 2 });
    await Promise.resolve();
    expect(api.action.setBadgeText).toHaveBeenCalledWith({ tabId: 2, text: "!" });
    expect(api.session.set).toHaveBeenCalled();
  });
});

it("forgets a closed tab's draft and pending selection", async () => {
  const { api } = fakeApi(null);
  await handleTabRemoved(api, 4);
  // The draft, the hand-over, the dubbing form and the followed job of that tab only.
  expect(api.session.remove).toHaveBeenCalledWith(["pending:4", "draft:4", "form:4", "job:4", "loaded:4", "adopted:4"]);
  // And its playback session, if the offscreen document has one.
  expect(api.notifyPlayer).toHaveBeenCalledWith({ type: "mydubb:player-tab-closed", tabId: 4 });
});

it("tells the player which connection is current, also when there is no player", async () => {
  const { api } = fakeApi(null);
  api.notifyPlayer.mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
  const auth = { token: "t".repeat(43), user: { id: "u1", email: "a@b.c" }, expiresAt: "2099-01-01T00:00:00Z", connectionId: "conn-a" };
  handleAuthChanged(api, auth);
  handleAuthChanged(api, undefined);
  handleAuthChanged(api, { ...auth, expiresAt: "1970-01-01T00:00:00Z" });
  await Promise.resolve();
  expect(api.notifyPlayer.mock.calls.map((c) => c[0])).toEqual([
    { type: "mydubb:player-identity", connectionId: "conn-a" },
    { type: "mydubb:player-identity", connectionId: null },
    { type: "mydubb:player-identity", connectionId: null },
  ]);
});

describe("reaching an ordinary page's video (activeTab, on the user's click)", () => {
  it("Send to MyDubb on an ordinary page injects the content script into its top frame after opening the panel", async () => {
    const { api, calls } = fakeApi(null);
    await handleMenuClick(api, click({ pageUrl: "https://www.loom.com/share/abc" }), { id: 7 });
    await Promise.resolve();
    expect(calls.slice(0, 3)).toEqual(["setOptions", "open", "inject"]);
    expect(api.injectPage).toHaveBeenCalledWith(7);
    expect(api.notifyPanel).toHaveBeenCalledWith({ type: "mydubb:page-injected", tabId: 7 });
  });

  it("on Udemy the manifest's content script is there: nothing is injected by the menu", async () => {
    const { api } = fakeApi({ type: "mydubb:selection", text: "x", tooLong: false, lesson });
    await handleMenuClick(api, click(), { id: 7 });
    expect(api.injectPage).not.toHaveBeenCalled();
  });

  it("a page MyDubb may not reach (no access, a browser page) is left alone and nothing is announced", async () => {
    const { api } = fakeApi(null);
    api.injectPage.mockRejectedValue(new Error("Cannot access contents of the page."));
    expect(await reachPage(api, 7)).toBe(false);
    expect(api.notifyPanel).not.toHaveBeenCalled();
    api.injectPage.mockResolvedValue(undefined);
    api.notifyPanel.mockRejectedValue(new Error("Receiving end does not exist."));
    expect(await reachPage(api, 7)).toBe(true);
  });
});
