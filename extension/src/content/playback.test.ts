// @vitest-environment-options {"url": "https://www.udemy.com/course/demo-course/learn/lecture/1"}
import { describe, expect, it, vi } from "vitest";

import type { PageToPlayer, PlayerView } from "../shared/playback";
import type { FloatingActions } from "./floating";
import { PageSession, type PortLike } from "./page";
import { PlaybackLink, type FloatingView, type PlayerPort } from "./playback";

const VIEW: PlayerView = {
  sessionId: "s1",
  lessonKey: "demo-course/1",
  status: "ready",
  paused: true,
  ended: false,
  currentTime: 0,
  duration: 30,
  problem: null,
  choices: { languageLabel: "Vietnamese", voiceLabel: "Andrew", speed: 1 },
  floating: true,
};

class FakePlayerPort implements PlayerPort {
  readonly sent: PageToPlayer[] = [];
  disconnected = false;
  private readonly messages: ((m: unknown) => void)[] = [];
  private readonly disconnects: (() => void)[] = [];
  readonly onMessage = { addListener: (l: (m: unknown) => void) => void this.messages.push(l) };
  readonly onDisconnect = { addListener: (l: () => void) => void this.disconnects.push(l) };
  postMessage(message: PageToPlayer) {
    this.sent.push(message);
  }
  disconnect() {
    this.disconnected = true;
  }
  receive(message: unknown) {
    for (const l of this.messages) l(message);
  }
  close() {
    for (const l of this.disconnects) l();
  }
}

function linkEnv() {
  const ports: FakePlayerPort[] = [];
  let actions: FloatingActions | null = null;
  const ui: FloatingView & { views: PlayerView[]; hidden: number } = {
    views: [],
    hidden: 0,
    render(view) {
      this.views.push(view);
    },
    hide() {
      this.hidden += 1;
    },
  };
  return {
    ports,
    ui,
    actions: () => actions!,
    env: {
      connect: () => {
        const port = new FakePlayerPort();
        ports.push(port);
        return port;
      },
      createPlayer: (a: FloatingActions) => {
        actions = a;
        return ui;
      },
    },
  };
}

describe("PlaybackLink", () => {
  it("says hello for its lecture, shows views and sends commands tied to session and lecture", () => {
    const { env, ports, ui, actions } = linkEnv();
    const link = new PlaybackLink(env, vi.fn());
    link.link("demo-course/1");
    link.link("demo-course/1");
    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent).toEqual([{ type: "hello", lessonKey: "demo-course/1" }]);
    ports[0]!.receive({ type: "view", view: VIEW });
    expect(ui.views).toHaveLength(1);
    actions().command({ command: "seek-by", value: 5 });
    actions().close();
    expect(ports[0]!.sent.slice(1)).toEqual([
      { type: "command", sessionId: "s1", lessonKey: "demo-course/1", command: "seek-by", value: 5 },
      { type: "close", sessionId: "s1", lessonKey: "demo-course/1" },
    ]);
  });

  it("ends on another lecture, a view for another lecture, 'ended' or a lost port", () => {
    const onEnd = vi.fn();
    const { env, ports, ui } = linkEnv();
    const link = new PlaybackLink(env, onEnd);
    link.link("demo-course/1");
    ports[0]!.receive({ type: "view", view: VIEW });
    link.lesson("demo-course/2");
    expect(ports[0]!.sent.at(-1)).toEqual({ type: "lesson", lessonKey: "demo-course/2" });
    expect(ports[0]!.disconnected).toBe(true);
    expect(link.active).toBe(false);
    expect(ui.hidden).toBe(1);

    link.link("demo-course/1");
    ports[1]!.receive({ type: "view", view: { ...VIEW, lessonKey: "demo-course/9" } });
    expect(link.active).toBe(false);
    link.link("demo-course/1");
    ports[2]!.receive({ type: "ended" });
    expect(link.active).toBe(false);
    link.link("demo-course/1");
    ports[3]!.close();
    expect(link.active).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(4);
    // Malformed messages are ignored.
    link.link("demo-course/1");
    ports[4]!.receive({ type: "view", view: { ...VIEW, currentTime: "soon" } });
    expect(link.active).toBe(true);
  });
});

class FakePanelPort implements PortLike {
  name = "mydubb-panel";
  sender = { id: "ext", url: "chrome-extension://ext/sidepanel.html?tabId=1" };
  private readonly messages: ((m: unknown) => void)[] = [];
  private readonly disconnects: (() => void)[] = [];
  onMessage = { addListener: (l: (m: unknown) => void) => void this.messages.push(l) };
  onDisconnect = { addListener: (l: () => void) => void this.disconnects.push(l) };
  postMessage = vi.fn();
  disconnect = vi.fn();
  receive(message: unknown) {
    for (const l of this.messages) l(message);
  }
  close() {
    for (const l of this.disconnects) l();
  }
}

describe("PageSession with a linked playback session", () => {
  function setup(path = "/course/demo-course/learn/lecture/1") {
    window.history.replaceState({}, "", path);
    const { env, ports } = linkEnv();
    const timers: (() => void)[] = [];
    const session = new PageSession({
      doc: document,
      win: window,
      extensionId: "ext",
      panelUrl: "chrome-extension://ext/sidepanel.html",
      isVisible: () => true,
      setInterval: (fn) => timers.push(fn),
      clearInterval: () => undefined,
      playback: env,
    });
    return { session, ports, timers };
  }

  it("links only for the lecture it shows, and keeps watching it after the panel closes", () => {
    const { session, ports, timers } = setup();
    const panel = new FakePanelPort();
    session.acceptPort(panel);
    panel.receive({ type: "playback-link", lessonKey: "demo-course/9" });
    expect(ports).toHaveLength(0);
    panel.receive({ type: "playback-link", lessonKey: "demo-course/1" });
    expect(ports).toHaveLength(1);
    panel.close();
    expect(session.connectedPanels).toBe(0);
    expect(session.running).toBe(true);

    // SPA navigation to another lecture with no panel open: the session is ended, the watch stops.
    window.history.pushState({}, "", "/course/demo-course/learn/lecture/2");
    timers.at(-1)!();
    expect(ports[0]!.sent.at(-1)).toEqual({ type: "lesson", lessonKey: "demo-course/2" });
    expect(session.playbackLinked).toBe(false);
    expect(session.running).toBe(false);
  });

  it("leaving the lecture pages ends it too", () => {
    const { session, ports, timers } = setup();
    const panel = new FakePanelPort();
    session.acceptPort(panel);
    panel.receive({ type: "playback-link", lessonKey: "demo-course/1" });
    window.history.pushState({}, "", "/course/demo-course/");
    timers.at(-1)!();
    expect(ports[0]!.sent.at(-1)).toEqual({ type: "lesson", lessonKey: null });
    expect(session.playbackLinked).toBe(false);
  });
});
