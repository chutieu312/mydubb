// @vitest-environment-options {"url": "https://www.youtube.com/watch?v=AAAA"}
// The content script on an ordinary page (injected on the user's click): its identity for Sync is
// the address fingerprint, and its one main video is chosen strictly (pickPageVideo).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PAGE_SOURCE, pageKeyOf } from "../shared/lesson";
import { PANEL_PORT_NAME, type ContentToPanel, type PageState } from "../shared/messages";
import type { PageToPlayer } from "../shared/playback";
import { PageSession, USER_START_MS, pickPageVideo, type PortLike } from "./page";
import type { PlayerPort } from "./playback";
import { fakeVideo } from "./testVideo";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const PANEL_URL = `chrome-extension://${EXT_ID}/sidepanel.html`;

class FakePort implements PortLike {
  name = PANEL_PORT_NAME;
  sender: chrome.runtime.MessageSender = { id: EXT_ID, url: `${PANEL_URL}?tabId=5` };
  sent: ContentToPanel[] = [];
  private messageListeners: ((m: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  onMessage = { addListener: (l: (m: unknown) => void) => void this.messageListeners.push(l) };
  onDisconnect = { addListener: (l: () => void) => void this.disconnectListeners.push(l) };
  postMessage(m: ContentToPanel) {
    this.sent.push(m);
  }
  disconnect() {}
  receive(m: unknown) {
    for (const l of this.messageListeners) l(m);
  }
  close() {
    for (const l of this.disconnectListeners) l();
  }
  state(): PageState {
    return [...this.sent].reverse().find((m) => m.type === "state")!.state as PageState;
  }
}

/** The page's port to the player, as PlaybackLink opens it. */
class FakePlayerPort implements PlayerPort {
  sent: PageToPlayer[] = [];
  disconnected = false;
  onMessage = { addListener: () => undefined };
  onDisconnect = { addListener: () => undefined };
  postMessage(m: PageToPlayer) {
    this.sent.push(m);
  }
  disconnect() {
    this.disconnected = true;
  }
}

let visible: Set<HTMLVideoElement>;
let rects: Map<HTMLVideoElement, DOMRect>;
let clock: number;
let ports: FakePort[];
let playerPorts: FakePlayerPort[];
let keys: number;

function start() {
  const session = new PageSession({
    doc: document,
    win: window,
    extensionId: EXT_ID,
    panelUrl: PANEL_URL,
    web: true,
    isVisible: (v) => visible.has(v),
    // jsdom's events are never trusted: here "trusted" stands for the user's real input.
    isTrusted: (event) => (event as Event & { user?: boolean }).user === true,
    now: () => clock,
    randomKey: () => `v-${String(++keys).padStart(16, "0")}`,
    playback: {
      connect: () => {
        const port = new FakePlayerPort();
        playerPorts.push(port);
        return port;
      },
      createPlayer: () => ({ render: () => undefined, hide: () => undefined }),
    },
  });
  const port = new FakePort();
  ports.push(port);
  session.acceptPort(port);
  return { session, port };
}

function addVideo(init: { muted?: boolean; loop?: boolean; rect?: [number, number, number, number] } = {}, parent: HTMLElement = document.body) {
  const v = fakeVideo(document);
  let src = "blob:https://www.youtube.com/a";
  Object.defineProperty(v, "currentSrc", { configurable: true, get: () => src, set: (next: string) => (src = next) });
  v.muted = init.muted ?? false;
  v.loop = init.loop ?? false;
  const [x, y, w, h] = init.rect ?? [0, 0, 640, 360];
  rects.set(v, new DOMRect(x, y, w, h));
  v.getBoundingClientRect = () => rects.get(v)!;
  parent.append(v);
  visible.add(v);
  return v;
}

function userInput(type: "pointerdown" | "keydown", target: EventTarget, at: { x: number; y: number } = { x: 0, y: 0 }) {
  const event =
    type === "pointerdown"
      ? new MouseEvent("pointerdown", { bubbles: true, clientX: at.x, clientY: at.y })
      : new KeyboardEvent("keydown", { bubbles: true, key: " " });
  Object.defineProperty(event, "user", { value: true });
  target.dispatchEvent(event);
}

beforeEach(() => {
  history.replaceState(null, "", "/watch?v=AAAA");
  document.body.replaceChildren();
  visible = new Set();
  rects = new Map();
  clock = 10_000;
  ports = [];
  playerPorts = [];
  keys = 0;
});

// Every session stops (observer, interval, debounce) before jsdom is torn down.
afterEach(() => {
  for (const port of ports) port.close();
});

describe("pickPageVideo", () => {
  const v = (muted = false, loop = false) => {
    const el = document.createElement("video");
    el.muted = muted;
    el.loop = loop;
    return el;
  };
  const all = () => true;

  it("takes the one candidate, leaving muted looping previews out (muted alone is a candidate)", () => {
    const main = v(true);
    const preview = v(true, true);
    expect(pickPageVideo([main, preview], null, null, all)).toEqual({ kind: "video", video: main });
    expect(pickPageVideo([preview], null, null, all)).toEqual({ kind: "none" });
    expect(pickPageVideo([], null, null, all)).toEqual({ kind: "none" });
  });

  it("with several candidates: only the user's choice or the synced video, never 'the only one playing'", () => {
    const main = v();
    const teaser = v();
    Object.defineProperty(teaser, "paused", { value: false });
    expect(pickPageVideo([main, teaser], null, null, all)).toEqual({ kind: "ambiguous", candidates: 2 });
    expect(pickPageVideo([main, teaser], null, main, all)).toEqual({ kind: "video", video: main });
    expect(pickPageVideo([main, teaser], main, null, all)).toEqual({ kind: "video", video: main });
    // A chosen preview counts.
    const preview = v(true, true);
    expect(pickPageVideo([main, preview], null, preview, all)).toEqual({ kind: "video", video: preview });
  });
});

describe("an ordinary page's session", () => {
  it("reports the page's fingerprint (no lecture) and its one video", () => {
    addVideo({ muted: true });
    const { port } = start();
    const state = port.state();
    expect(state.lesson).toBeNull();
    expect(state.page).toBe(pageKeyOf(location.href));
    expect(state.page).toMatch(/^p-[0-9a-f]{14}$/);
    expect(state.video.status).toBe("ready");
  });

  it("a second video started by the page itself (with sound) makes it ambiguous: never taken as the user's choice", async () => {
    const main = addVideo({ rect: [0, 0, 640, 360] });
    const { port, session } = start();
    expect(port.state().video.status).toBe("ready");
    const side = addVideo({ rect: [700, 0, 320, 180] });
    // The page plays it unmuted, even right after an unrelated click elsewhere.
    userInput("pointerdown", document.body, { x: 100, y: 500 });
    await side.play();
    session.refresh();
    expect(port.state().video).toEqual({ status: "ambiguous", candidates: 2 });
    // A click on it long ago does not count either.
    userInput("pointerdown", side, { x: 800, y: 50 });
    clock += USER_START_MS + 1;
    await side.play();
    expect(port.state().video).toEqual({ status: "ambiguous", candidates: 2 });
    // The user's own click on the main video, then its start: chosen.
    userInput("pointerdown", main, { x: 300, y: 200 });
    clock += 200;
    await main.play();
    expect(port.state().video).toMatchObject({ status: "ready", paused: false });
  });

  it("a key pressed in the player that holds only this video chooses it; a key on the page body does not", async () => {
    const player = document.createElement("div");
    document.body.append(player);
    const main = addVideo({}, player);
    const other = addVideo({ rect: [0, 400, 640, 360] });
    const { port } = start();
    expect(port.state().video.status).toBe("ambiguous");
    userInput("keydown", document.body);
    await other.play();
    expect(port.state().video.status).toBe("ambiguous");
    userInput("keydown", player);
    await main.play();
    expect(port.state().video.status).toBe("ready");
  });

  it("links to the player only for its own page with the video identified; another address ends the link", () => {
    addVideo();
    const { port, session } = start();
    const page = port.state().page!;
    const video = (port.state().video as { key?: string }).key!;
    expect(video).toBe("v-0000000000000001");
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page: "p-00000000000000", video });
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page, video: "v-ffffffffffffffff" });
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page });
    port.receive({ type: "playback-link", lessonKey: "demo-course/1" });
    expect(playerPorts).toHaveLength(0);
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page, video });
    expect(playerPorts).toHaveLength(1);
    expect(playerPorts[0]!.sent).toEqual([{ type: "hello", lessonKey: PAGE_SOURCE, page, video }]);

    // YouTube's next video in the same tab: another address, the link to the old one ends.
    history.pushState(null, "", "/watch?v=BBBB");
    session.refresh();
    expect(port.state().page).not.toBe(page);
    expect(playerPorts[0]!.sent.at(-1)).toEqual({ type: "lesson", lessonKey: null });
    expect(playerPorts[0]!.disconnected).toBe(true);
    // A fragment is not another address.
    history.pushState(null, "", "/watch?v=BBBB#t=30");
    session.refresh();
    expect(port.state().page).toBe(pageKeyOf("https://www.youtube.com/watch?v=BBBB"));
  });

  it("another element or another source at the same address is another video: new key, the link ends with Sync off", () => {
    const a = addVideo();
    const { port, session } = start();
    const page = port.state().page!;
    const keyOf = () => (port.state().video as { key?: string }).key;
    const keyA = keyOf()!;
    // Nothing changed: the same key, again and again.
    session.refresh();
    expect(keyOf()).toBe(keyA);
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page, video: keyA });
    expect(playerPorts).toHaveLength(1);

    // Another source in the same element (same address): a new key, the link made for A ends.
    (a as { currentSrc: string }).currentSrc = "blob:https://www.youtube.com/b";
    a.dispatchEvent(new Event("emptied"));
    const keyB = keyOf()!;
    expect(keyB).not.toBe(keyA);
    expect(playerPorts[0]!.sent.at(-1)).toEqual({ type: "lesson", lessonKey: null });
    expect(playerPorts[0]!.disconnected).toBe(true);
    // A link asked for A now is refused.
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page, video: keyA });
    expect(playerPorts).toHaveLength(1);

    // The same source loaded again (load() fires loadstart): still another video for MyDubb.
    a.dispatchEvent(new Event("loadstart"));
    expect(keyOf()).not.toBe(keyB);

    // Another element replaces it (the player rebuilt): another key again.
    const keyC = keyOf()!;
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page, video: keyC });
    expect(playerPorts).toHaveLength(2);
    a.remove();
    visible.delete(a);
    addVideo();
    session.refresh();
    expect(keyOf()).not.toBe(keyC);
    expect(playerPorts[1]!.disconnected).toBe(true);
  });

  it("does not link while several videos are ambiguous", () => {
    addVideo();
    addVideo({ rect: [0, 400, 640, 360] });
    const { port } = start();
    port.receive({ type: "playback-link", lessonKey: PAGE_SOURCE, page: port.state().page });
    expect(playerPorts).toHaveLength(0);
  });
});
