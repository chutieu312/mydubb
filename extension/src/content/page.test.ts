// @vitest-environment-options {"url": "https://www.udemy.com/course/demo-course/learn/lecture/101#overview"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PANEL_PORT_NAME, type ContentToPanel, type StateMessage } from "../shared/messages";
import { PageSession, readSelection, type PortLike } from "./page";
import { fakeVideo } from "./testVideo";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const PANEL_URL = `chrome-extension://${EXT_ID}/sidepanel.html`;

class FakePort implements PortLike {
  sent: ContentToPanel[] = [];
  disconnected = false;
  private messageListeners: ((m: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  onMessage = { addListener: (l: (m: unknown) => void) => void this.messageListeners.push(l) };
  onDisconnect = { addListener: (l: () => void) => void this.disconnectListeners.push(l) };

  constructor(
    public name = PANEL_PORT_NAME,
    public sender: chrome.runtime.MessageSender = { id: EXT_ID, url: `${PANEL_URL}?tabId=5` },
  ) {}

  postMessage(m: ContentToPanel) {
    this.sent.push(m);
  }
  disconnect() {
    this.disconnected = true;
  }
  receive(m: unknown) {
    for (const l of this.messageListeners) l(m);
  }
  close() {
    for (const l of this.disconnectListeners) l();
  }
  lastState() {
    return [...this.sent].reverse().find((m): m is StateMessage => m.type === "state")!.state;
  }
  results() {
    return this.sent.filter((m) => m.type === "result");
  }
}

let intervals: number;
let session: PageSession;
let visible: Set<HTMLVideoElement>;

function newSession() {
  intervals = 0;
  return new PageSession({
    doc: document,
    win: window,
    extensionId: EXT_ID,
    panelUrl: PANEL_URL,
    isVisible: (v) => visible.has(v),
    setInterval: (fn, ms) => {
      intervals += 1;
      return window.setInterval(fn, ms);
    },
    clearInterval: (id) => {
      intervals -= 1;
      window.clearInterval(id);
    },
  });
}

function addVideo(init = {}) {
  const v = fakeVideo(document, init);
  document.body.append(v);
  visible.add(v);
  return v;
}

beforeEach(() => {
  history.replaceState(null, "", "/course/demo-course/learn/lecture/101#overview");
  document.title = "Lecture 101 | Udemy";
  document.body.replaceChildren();
  visible = new Set();
  session = newSession();
});

afterEach(() => vi.useRealTimers());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PageSession ports", () => {
  it("rejects ports from anything but this extension's side panel", () => {
    const wrongName = new FakePort("other");
    const otherExtension = new FakePort(PANEL_PORT_NAME, { id: "x".repeat(32), url: `${PANEL_URL}` });
    const wrongPage = new FakePort(PANEL_PORT_NAME, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/evil.html` });
    const webPage = new FakePort(PANEL_PORT_NAME, { id: EXT_ID, url: "https://www.udemy.com/", tab: { id: 1 } as chrome.tabs.Tab });
    for (const port of [wrongName, otherExtension, wrongPage, webPage]) expect(session.acceptPort(port)).toBe(false);
    expect([otherExtension, wrongPage, webPage].every((p) => p.disconnected)).toBe(true);
    expect(session.running).toBe(false);
  });

  it("runs one timer however many panels connect, and stops when the last one leaves", () => {
    const ports = [new FakePort(), new FakePort(), new FakePort()];
    ports.forEach((p) => session.acceptPort(p));
    expect(intervals).toBe(1);
    expect(session.connectedPanels).toBe(3);
    ports[0]!.close();
    ports[1]!.close();
    expect(session.running).toBe(true);
    ports[2]!.close();
    expect(session.running).toBe(false);
    expect(intervals).toBe(0);
    // Reconnecting starts exactly one timer again.
    session.acceptPort(new FakePort());
    expect(intervals).toBe(1);
  });

  it("sends the lecture identity and video state on connect", () => {
    addVideo({ currentTime: 12 });
    const port = new FakePort();
    session.acceptPort(port);
    expect(port.lastState()).toMatchObject({
      lesson: { key: "demo-course/101", lectureId: "101", title: "Lecture 101 | Udemy" },
      video: { status: "ready", id: 1, currentTime: 12 },
    });
  });

  it("reports ambiguity with several videos, and follows the one the user starts", () => {
    const a = addVideo();
    addVideo();
    const port = new FakePort();
    session.acceptPort(port);
    expect(port.lastState().video).toEqual({ status: "ambiguous", candidates: 2 });
    a.dispatchEvent(new Event("play"));
    expect(port.lastState().video).toMatchObject({ status: "ready", id: 1 });
  });

  it("reports no video on a non-lecture page", () => {
    history.replaceState(null, "", "/course/demo-course/");
    addVideo();
    const port = new FakePort();
    session.acceptPort(port);
    expect(port.lastState()).toMatchObject({ lesson: null, video: { status: "none" } });
  });
});

describe("PageSession commands", () => {
  function connected(init = {}) {
    const video = addVideo(init);
    const port = new FakePort();
    session.acceptPort(port);
    return { video, port };
  }

  it("plays, pauses and seeks the attached video", async () => {
    const { video, port } = connected({ currentTime: 50 });
    port.receive({ type: "command", requestId: 1, command: "play", lessonKey: "demo-course/101", videoId: 1 });
    await flush();
    expect(video.media.paused).toBe(false);
    expect(port.lastState().video).toMatchObject({ paused: false });
    port.receive({ type: "command", requestId: 2, command: "seek", delta: 5, lessonKey: "demo-course/101", videoId: 1 });
    port.receive({ type: "command", requestId: 3, command: "pause", lessonKey: "demo-course/101", videoId: 1 });
    await flush();
    expect(video.media.currentTime).toBe(55);
    expect(video.media.paused).toBe(true);
    expect(port.results()).toEqual([
      { type: "result", requestId: 1, ok: true },
      { type: "result", requestId: 2, ok: true },
      { type: "result", requestId: 3, ok: true },
    ]);
  });

  it("refuses commands aimed at another lecture or a replaced video", async () => {
    const { video, port } = connected();
    port.receive({ type: "command", requestId: 1, command: "play", lessonKey: "demo-course/999", videoId: 1 });
    port.receive({ type: "command", requestId: 2, command: "play", lessonKey: "demo-course/101", videoId: 2 });
    await flush();
    expect(video.media.paused).toBe(true);
    expect(port.results().map((r) => r.type === "result" && r.error)).toEqual(["stale", "stale"]);
  });

  it("rejects malformed commands", async () => {
    const { video, port } = connected({ currentTime: 10 });
    port.receive({ type: "command", requestId: 1, command: "seek", delta: 3600, lessonKey: "demo-course/101", videoId: 1 });
    port.receive({ type: "command", requestId: 2, command: "mute", lessonKey: "demo-course/101", videoId: 1 });
    port.receive("play");
    await flush();
    expect(video.media.currentTime).toBe(10);
    expect(port.results()).toEqual([
      { type: "result", requestId: 1, ok: false, error: "invalid" },
      { type: "result", requestId: 2, ok: false, error: "invalid" },
    ]);
  });

  it("attaches a new controller when the video element is replaced", async () => {
    const { video, port } = connected();
    video.remove();
    visible.delete(video);
    const replacement = addVideo();
    session.refresh();
    expect(port.lastState().video).toMatchObject({ status: "ready", id: 2 });
    // The old element no longer drives state.
    video.dispatchEvent(new Event("play"));
    port.receive({ type: "command", requestId: 1, command: "play", lessonKey: "demo-course/101", videoId: 2 });
    await flush();
    expect(replacement.media.paused).toBe(false);
  });

  it("re-attaches on SPA navigation to another lecture, even with the same element", () => {
    const { port } = connected();
    history.pushState(null, "", "/course/demo-course/learn/lecture/102");
    session.refresh();
    expect(port.lastState()).toMatchObject({ lesson: { key: "demo-course/102" }, video: { status: "ready", id: 2 } });
  });

  it("picks up URL changes from its own timer without being asked", () => {
    vi.useFakeTimers();
    const { port } = connected();
    history.pushState(null, "", "/course/demo-course/learn/lecture/103");
    vi.advanceTimersByTime(1000);
    expect(port.lastState().lesson?.key).toBe("demo-course/103");
  });
});

describe("readSelection", () => {
  it("returns the selection as plain text with line breaks, never markup", () => {
    document.body.innerHTML = "<div id=t><p>First <b>line</b> &lt;tag&gt;</p><p>Second line</p></div>";
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("t")!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const { text, tooLong } = readSelection(document);
    expect(tooLong).toBe(false);
    expect(text).toContain("First line <tag>");
    expect(text).toContain("Second line");
    expect(text).not.toContain("<b>");
  });

  it("returns empty text when nothing is selected", () => {
    document.getSelection()!.removeAllRanges();
    expect(readSelection(document)).toEqual({ text: "", tooLong: false });
  });

  it("flags an oversized selection instead of cutting it", () => {
    const area = document.createElement("textarea");
    area.value = "x".repeat(100_001);
    document.body.append(area);
    area.focus();
    area.setSelectionRange(0, area.value.length);
    expect(readSelection(document)).toEqual({ text: "", tooLong: true });
  });
});
