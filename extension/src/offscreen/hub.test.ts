import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PanelPlayerView, PlaybackOwner, PlayerToPage, PlayerToPanel } from "../shared/playback";
import { PlaybackHub, type AudioLike, type HubDeps, type HubPort } from "./hub";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const PANEL_URL = `chrome-extension://${EXT}/sidepanel.html`;
const LESSON = "demo-course/1";
const OWNER: PlaybackOwner = { userId: "u1", connectionId: "conn-a", jobId: "job-1", operationId: "op-1" };
const CHOICES = { languageLabel: "Vietnamese", voiceLabel: "Andrew Multilingual", speed: 1.5 };

/** A media element whose state the test sets; play() can be made to fail. */
class FakeAudio extends EventTarget {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  error: MediaError | null = null;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preload = "";
  autoplay = true;
  src = "";
  playError: { name: string } | null = null;
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load = vi.fn();
  async play() {
    if (this.playError) throw this.playError;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  loaded(duration = 180) {
    this.duration = duration;
    this.readyState = 4;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
}

class FakePort<Out> implements HubPort<Out> {
  readonly sent: Out[] = [];
  disconnected = false;
  private readonly messageListeners: ((m: unknown) => void)[] = [];
  private readonly disconnectListeners: (() => void)[] = [];
  readonly onMessage = { addListener: (l: (m: unknown) => void) => void this.messageListeners.push(l) };
  readonly onDisconnect = { addListener: (l: () => void) => void this.disconnectListeners.push(l) };
  constructor(
    readonly name: string,
    readonly sender: chrome.runtime.MessageSender,
  ) {}
  postMessage(message: Out) {
    if (this.disconnected) throw new Error("disconnected");
    this.sent.push(structuredClone(message));
  }
  disconnect() {
    this.disconnected = true;
  }
  receive(message: unknown) {
    for (const l of this.messageListeners) l(message);
  }
  /** The other side went away. */
  close() {
    this.disconnected = true;
    for (const l of this.disconnectListeners) l();
  }
  last(): Out | undefined {
    return this.sent.at(-1);
  }
}

let audios: FakeAudio[];
let revoked: string[];
let closed: number;
let timers: Map<number, () => void>;

function makeHub() {
  let id = 0;
  let timer = 0;
  const deps: HubDeps = {
    extensionId: EXT,
    panelUrl: PANEL_URL,
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio as unknown as AudioLike;
    },
    createObjectURL: () => `blob:chrome-extension://${EXT}/${audios.length}`,
    revokeObjectURL: (url) => revoked.push(url),
    randomId: () => `id-${++id}`,
    now: () => Date.now(),
    setTimeout: (fn) => {
      timer += 1;
      timers.set(timer, fn);
      return timer;
    },
    clearTimeout: (t) => void timers.delete(t),
    close: () => void (closed += 1),
  };
  return new PlaybackHub(deps);
}

function panelPort(tabId: number, url = `${PANEL_URL}?tabId=${tabId}`) {
  return new FakePort<PlayerToPanel>("mydubb-player-panel", { id: EXT, url });
}

function pagePort(tabId: number, overrides: Partial<chrome.runtime.MessageSender> = {}) {
  return new FakePort<PlayerToPage>("mydubb-player-page", {
    id: EXT,
    url: `https://www.udemy.com/course/demo-course/learn/lecture/1`,
    frameId: 0,
    tab: { id: tabId } as chrome.tabs.Tab,
    ...overrides,
  });
}

const blob = () => new Blob(["mp3"], { type: "audio/mpeg" });
const lastView = (port: FakePort<PlayerToPanel>) => {
  const states = port.sent.filter((m) => m.type === "state");
  return (states.at(-1) as { view: PanelPlayerView | null } | undefined)?.view;
};

/** A panel bound to `tabId` with an opened session; returns the ports and the audio. */
function opened(hub: PlaybackHub, tabId = 4, owner = OWNER, lessonKey = LESSON) {
  const panel = panelPort(tabId);
  hub.acceptPanel(panel);
  panel.receive({ type: "watch", tabId });
  panel.receive({ type: "open", tabId, transferId: `t-${tabId}-${owner.jobId}`, lessonKey, owner, choices: CHOICES });
  hub.receiveAudio({ transferId: `t-${tabId}-${owner.jobId}`, blob: blob() });
  const audio = audios.at(-1)!;
  audio.loaded();
  return { panel, audio, sessionId: lastView(panel)!.sessionId };
}

function linkPage(hub: PlaybackHub, tabId = 4, lessonKey = LESSON) {
  const page = pagePort(tabId);
  hub.acceptPage(page);
  page.receive({ type: "hello", lessonKey });
  return page;
}

beforeEach(() => {
  audios = [];
  revoked = [];
  closed = 0;
  timers = new Map();
});

describe("opening a session", () => {
  it("asks for the Blob on the panel's port, then plays nothing by itself, at 1x", () => {
    const hub = makeHub();
    const panel = panelPort(4);
    hub.acceptPanel(panel);
    panel.receive({ type: "watch", tabId: 4 });
    expect(panel.last()).toEqual({ type: "state", tabId: 4, view: null });
    panel.receive({ type: "open", tabId: 4, transferId: "t1", lessonKey: LESSON, owner: OWNER, choices: CHOICES });
    expect(panel.last()).toEqual({ type: "send-audio", tabId: 4, transferId: "t1" });
    // A Blob nobody asked for, or of the wrong type, is ignored or refused.
    hub.receiveAudio({ transferId: "other", blob: blob() });
    expect(audios).toHaveLength(0);
    hub.receiveAudio({ transferId: "t1", blob: blob() });
    const audio = audios[0]!;
    expect(audio.src).toMatch(/^blob:chrome-extension:/);
    expect(audio.autoplay).toBe(false);
    expect(audio.paused).toBe(true);
    expect(panel.sent.find((m) => m.type === "opened")).toMatchObject({ transferId: "t1", sessionId: "id-1" });
    audio.loaded();
    expect(lastView(panel)).toMatchObject({ status: "ready", paused: true, duration: 180, choices: CHOICES, owner: OWNER, linked: false });
    audio.playbackRate = 2;
    audio.dispatchEvent(new Event("ratechange"));
    expect(audio.playbackRate).toBe(1);
  });

  it("refuses a Blob that is not audio", () => {
    const hub = makeHub();
    const panel = panelPort(4);
    hub.acceptPanel(panel);
    panel.receive({ type: "watch", tabId: 4 });
    panel.receive({ type: "open", tabId: 4, transferId: "t1", lessonKey: LESSON, owner: OWNER, choices: CHOICES });
    hub.receiveAudio({ transferId: "t1", blob: new Blob(["<html>"], { type: "text/html" }) });
    expect(panel.last()).toEqual({ type: "open-failed", tabId: 4, transferId: "t1", reason: "invalid-audio" });
    expect(audios).toHaveLength(0);
  });

  it("gives up a transfer that never arrives", () => {
    const hub = makeHub();
    const panel = panelPort(4);
    hub.acceptPanel(panel);
    panel.receive({ type: "watch", tabId: 4 });
    panel.receive({ type: "open", tabId: 4, transferId: "t1", lessonKey: LESSON, owner: OWNER, choices: CHOICES });
    for (const fn of [...timers.values()]) fn();
    expect(panel.sent.some((m) => m.type === "open-failed" && m.reason === "timeout")).toBe(true);
  });

  it("replacing the result stops and releases the old audio first", () => {
    const hub = makeHub();
    const { panel, audio } = opened(hub);
    void audio.play();
    panel.receive({ type: "open", tabId: 4, transferId: "t2", lessonKey: LESSON, owner: { ...OWNER, jobId: "job-2" }, choices: CHOICES });
    hub.receiveAudio({ transferId: "t2", blob: blob() });
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("");
    expect(revoked).toHaveLength(1);
    expect(lastView(panel)?.owner.jobId).toBe("job-2");
    expect(hub.tabs.size).toBe(1);
  });
});

describe("senders", () => {
  it("accepts panel ports only from the extension's side panel, bound to the tab in its own address", () => {
    const hub = makeHub();
    const stranger = new FakePort<PlayerToPanel>("mydubb-player-panel", { id: "other-extension", url: `${PANEL_URL}?tabId=4` });
    expect(hub.acceptPanel(stranger)).toBe(false);
    expect(stranger.disconnected).toBe(true);
    const page = new FakePort<PlayerToPanel>("mydubb-player-panel", { id: EXT, url: "https://www.udemy.com/x" });
    expect(hub.acceptPanel(page)).toBe(false);
    // The panel of tab 5 cannot watch (and so drive) tab 4.
    opened(hub, 4);
    const other = panelPort(5);
    hub.acceptPanel(other);
    other.receive({ type: "watch", tabId: 4 });
    expect(other.disconnected).toBe(true);
    expect(other.sent).toEqual([]);
  });

  it("accepts page ports only from a top-frame Udemy content script, for its own tab", () => {
    const hub = makeHub();
    opened(hub, 4);
    for (const sender of [
      { tab: undefined },
      { frameId: 3 },
      { url: "https://evil.example/" },
      { id: "other-extension" },
    ] as Partial<chrome.runtime.MessageSender>[]) {
      const port = pagePort(4, sender);
      expect(hub.acceptPage(port)).toBe(false);
      expect(port.disconnected).toBe(true);
    }
    // Another tab's page sees nothing of tab 4.
    const tab5 = linkPage(hub, 5);
    expect(tab5.sent).toEqual([{ type: "ended" }]);
    expect(tab5.disconnected).toBe(true);
  });

  it("takes worker messages only from the extension itself, never from a tab", () => {
    const hub = makeHub();
    opened(hub, 4);
    const fromTab = { id: EXT, url: "https://www.udemy.com/", tab: { id: 4 } as chrome.tabs.Tab };
    expect(hub.onWorkerMessage({ type: "mydubb:player-identity", connectionId: null }, fromTab)).toBe(false);
    expect(hub.onWorkerMessage({ type: "mydubb:player-identity", connectionId: null }, { id: "x", url: "chrome-extension://x/" })).toBe(false);
    expect(hub.tabs.size).toBe(1);
  });

  it("drops malformed messages and commands for another session", () => {
    const hub = makeHub();
    const { panel, audio } = opened(hub, 4);
    const page = linkPage(hub, 4);
    panel.receive({ type: "command", tabId: 4, sessionId: "id-1", command: "seek-by", value: 1e9 });
    panel.receive({ type: "command", tabId: 4, sessionId: "id-1", command: "eval" });
    panel.receive({ type: "command", tabId: 4, sessionId: "old-session", command: "play" });
    page.receive({ type: "command", sessionId: "old-session", lessonKey: LESSON, command: "play" });
    page.receive({ type: "command", sessionId: "id-1", lessonKey: LESSON, command: "play", value: 3 });
    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(0);
  });
});

describe("playback", () => {
  it("plays only once the page is linked, and from either the panel or the page", async () => {
    const hub = makeHub();
    const { panel, audio, sessionId } = opened(hub, 4);
    panel.receive({ type: "command", tabId: 4, sessionId, command: "play" });
    await Promise.resolve();
    expect(audio.paused).toBe(true);
    expect(lastView(panel)?.problem).toBe("not-linked");
    const page = linkPage(hub, 4);
    expect(lastView(panel)?.linked).toBe(true);
    page.receive({ type: "command", sessionId, lessonKey: LESSON, command: "play" });
    await Promise.resolve();
    expect(audio.paused).toBe(false);
    expect(lastView(panel)).toMatchObject({ paused: false, problem: null });
    expect(page.last()).toMatchObject({ type: "view", view: { paused: false, sessionId } });
    // The page's view carries display state only.
    const view = (page.last() as unknown as { view: Record<string, unknown> }).view;
    expect(Object.keys(view).sort()).toEqual(
      ["choices", "currentTime", "duration", "ended", "floating", "lessonKey", "paused", "problem", "sessionId", "status"].sort(),
    );
    panel.receive({ type: "command", tabId: 4, sessionId, command: "pause" });
    expect(audio.paused).toBe(true);
  });

  it("clamps seeking to the audio", () => {
    const hub = makeHub();
    const { panel, audio, sessionId } = opened(hub, 4);
    const seek = (command: "seek-by" | "seek-to", value: number) =>
      panel.receive({ type: "command", tabId: 4, sessionId, command, value });
    seek("seek-by", -5);
    expect(audio.currentTime).toBe(0);
    seek("seek-to", 178);
    seek("seek-by", 5);
    expect(audio.currentTime).toBe(180);
    seek("seek-by", -5);
    expect(audio.currentTime).toBe(175);
    seek("seek-to", 5000);
    expect(audio.currentTime).toBe(180);
  });

  it("reports blocked autoplay and a failed start, and recovers on the next play", async () => {
    const hub = makeHub();
    const { panel, audio, sessionId } = opened(hub, 4);
    linkPage(hub, 4);
    audio.playError = { name: "NotAllowedError" };
    panel.receive({ type: "command", tabId: 4, sessionId, command: "play" });
    await Promise.resolve();
    await Promise.resolve();
    expect(lastView(panel)?.problem).toBe("play-blocked");
    audio.playError = { name: "NotSupportedError" };
    panel.receive({ type: "command", tabId: 4, sessionId, command: "play" });
    await Promise.resolve();
    await Promise.resolve();
    expect(lastView(panel)?.problem).toBe("play-failed");
    audio.playError = null;
    panel.receive({ type: "command", tabId: 4, sessionId, command: "play" });
    await Promise.resolve();
    expect(lastView(panel)).toMatchObject({ problem: null, paused: false });
    audio.error = { code: 3 } as MediaError;
    audio.dispatchEvent(new Event("error"));
    expect(lastView(panel)).toMatchObject({ status: "error", problem: "media-error" });
  });

  it("playing in tab B pauses tab A, which keeps its position", async () => {
    const hub = makeHub();
    const a = opened(hub, 4);
    const b = opened(hub, 5, { ...OWNER, jobId: "job-5" }, "demo-course/5");
    linkPage(hub, 4);
    linkPage(hub, 5, "demo-course/5");
    a.panel.receive({ type: "command", tabId: 4, sessionId: a.sessionId, command: "play" });
    await Promise.resolve();
    a.audio.currentTime = 42;
    b.panel.receive({ type: "command", tabId: 5, sessionId: b.sessionId, command: "play" });
    await Promise.resolve();
    expect(a.audio.paused).toBe(true);
    expect(a.audio.currentTime).toBe(42);
    expect(b.audio.paused).toBe(false);
    expect(lastView(a.panel)?.paused).toBe(true);
  });

  it("Show floating player reaches the page; Close pauses and hides but keeps the session", async () => {
    const hub = makeHub();
    const { panel, audio, sessionId } = opened(hub, 4);
    const page = linkPage(hub, 4);
    panel.receive({ type: "floating", tabId: 4, sessionId, visible: true });
    expect(page.last()).toMatchObject({ view: { floating: true } });
    page.receive({ type: "command", sessionId, lessonKey: LESSON, command: "play" });
    await Promise.resolve();
    page.receive({ type: "close", sessionId, lessonKey: LESSON });
    expect(audio.paused).toBe(true);
    expect(page.last()).toMatchObject({ view: { floating: false, paused: true } });
    expect(hub.tabs.size).toBe(1);
    expect(revoked).toEqual([]);
  });
});

describe("ending sessions", () => {
  it("ends when the page reports another lecture, or goes away (reload, navigation, closed tab)", () => {
    const hub = makeHub();
    const first = opened(hub, 4);
    const page = linkPage(hub, 4);
    page.receive({ type: "lesson", lessonKey: "demo-course/2" });
    expect(hub.tabs.size).toBe(0);
    expect(first.audio.src).toBe("");
    expect(revoked).toHaveLength(1);
    expect(page.last()).toEqual({ type: "ended" });
    expect(lastView(first.panel)).toBeNull();

    const second = opened(hub, 4, { ...OWNER, jobId: "job-2" });
    const reloaded = linkPage(hub, 4);
    reloaded.close();
    expect(hub.tabs.size).toBe(0);
    expect(second.audio.paused).toBe(true);
  });

  it("a page linking with another lecture ends the session instead of showing it", () => {
    const hub = makeHub();
    opened(hub, 4);
    const page = linkPage(hub, 4, "demo-course/9");
    expect(page.sent).toEqual([{ type: "ended" }]);
    expect(hub.tabs.size).toBe(0);
  });

  it("ends a closed tab's session, and those of a connection that ended (not others)", () => {
    const hub = makeHub();
    const worker = { id: EXT, url: `chrome-extension://${EXT}/background.js` };
    opened(hub, 4);
    opened(hub, 5, { ...OWNER, connectionId: "conn-b", jobId: "job-5" }, "demo-course/5");
    opened(hub, 6, { ...OWNER, jobId: "job-6" }, "demo-course/6");
    hub.onWorkerMessage({ type: "mydubb:player-tab-closed", tabId: 6 }, worker);
    expect([...hub.tabs.keys()]).toEqual([4, 5]);
    hub.onWorkerMessage({ type: "mydubb:player-identity", connectionId: "conn-b" }, worker);
    expect([...hub.tabs.keys()]).toEqual([5]);
    // A late open for the ended connection is refused.
    const panel = panelPort(4);
    hub.acceptPanel(panel);
    panel.receive({ type: "watch", tabId: 4 });
    panel.receive({ type: "open", tabId: 4, transferId: "late", lessonKey: LESSON, owner: OWNER, choices: CHOICES });
    expect(panel.last()).toEqual({ type: "open-failed", tabId: 4, transferId: "late", reason: "revoked" });
    hub.onWorkerMessage({ type: "mydubb:player-identity", connectionId: null }, worker);
    expect(hub.tabs.size).toBe(0);
  });

  it("the panel closing changes nothing; its own end request does", () => {
    const hub = makeHub();
    const { panel, sessionId } = opened(hub, 4);
    panel.close();
    expect(hub.tabs.size).toBe(1);
    const again = panelPort(4);
    hub.acceptPanel(again);
    again.receive({ type: "watch", tabId: 4 });
    expect(lastView(again)?.sessionId).toBe(sessionId);
    again.receive({ type: "end", tabId: 4, sessionId: "another" });
    expect(hub.tabs.size).toBe(1);
    again.receive({ type: "end", tabId: 4, sessionId: null });
    expect(hub.tabs.size).toBe(0);
  });

  it("closes the document once nothing is left, not while a session or a transfer exists", () => {
    const hub = makeHub();
    const { panel } = opened(hub, 4);
    expect(timers.size).toBe(0);
    panel.receive({ type: "end", tabId: 4, sessionId: null });
    expect(timers.size).toBe(1);
    panel.receive({ type: "open", tabId: 4, transferId: "t9", lessonKey: LESSON, owner: OWNER, choices: CHOICES });
    // Only the transfer's own timeout is pending now, not the idle close.
    expect(closed).toBe(0);
    hub.receiveAudio({ transferId: "t9", blob: blob() });
    expect(timers.size).toBe(0);
    panel.receive({ type: "end", tabId: 4, sessionId: null });
    for (const fn of [...timers.values()]) fn();
    expect(closed).toBe(1);
  });
});
