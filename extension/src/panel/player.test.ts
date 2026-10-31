import { describe, expect, it, vi } from "vitest";

import type { PanelPlayerView, PanelToPlayer } from "../shared/playback";
import { PlayerLink, type PanelPort, type PlayerDeps } from "./player";

const VIEW: PanelPlayerView = {
  sessionId: "s1",
  lessonKey: "demo-course/1",
  status: "ready",
  paused: true,
  ended: false,
  currentTime: 0,
  duration: 30,
  problem: null,
  choices: { languageLabel: "Vietnamese", voiceLabel: "Andrew", speed: 1 },
  floating: false,
  owner: { userId: "u1", connectionId: "c1", jobId: "job-1", operationId: "op-1" },
  linked: false,
};
const REQUEST = { lessonKey: "demo-course/1", owner: VIEW.owner, choices: VIEW.choices };

class FakePort implements PanelPort {
  readonly sent: PanelToPlayer[] = [];
  private readonly messages: ((m: unknown) => void)[] = [];
  private readonly disconnects: (() => void)[] = [];
  readonly onMessage = { addListener: (l: (m: unknown) => void) => void this.messages.push(l) };
  readonly onDisconnect = { addListener: (l: () => void) => void this.disconnects.push(l) };
  constructor(private readonly onSend: (port: FakePort, m: PanelToPlayer) => void = () => undefined) {}
  postMessage(message: PanelToPlayer) {
    this.sent.push(message);
    this.onSend(this, message);
  }
  disconnect = vi.fn();
  receive(message: unknown) {
    for (const l of this.messages) l(message);
  }
  close() {
    for (const l of this.disconnects) l();
  }
}

/** An offscreen document that answers like hub.ts. */
function document(options: { exists?: boolean; failOpen?: "revoked" } = {}) {
  let exists = options.exists ?? false;
  const ports: FakePort[] = [];
  const sentAudio: [string, Blob][] = [];
  const respond = (port: FakePort, m: PanelToPlayer) => {
    queueMicrotask(() => {
      if (m.type === "watch") port.receive({ type: "state", tabId: 3, view: null });
      if (m.type === "open") {
        if (options.failOpen) port.receive({ type: "open-failed", tabId: 3, transferId: m.transferId, reason: options.failOpen });
        else port.receive({ type: "send-audio", tabId: 3, transferId: m.transferId });
      }
    });
  };
  const deps: PlayerDeps = {
    tabId: 3,
    hasDocument: vi.fn(async () => exists),
    createDocument: vi.fn(async () => {
      exists = true;
    }),
    connect: () => {
      const port = new FakePort(respond);
      ports.push(port);
      return port;
    },
    sendAudio: (id, blob) => {
      sentAudio.push([id, blob]);
      const port = ports.at(-1)!;
      queueMicrotask(() => {
        port.receive({ type: "opened", tabId: 3, transferId: id, sessionId: "s1" });
        port.receive({ type: "state", tabId: 3, view: VIEW });
      });
    },
    randomId: (() => {
      let n = 0;
      return () => `t${++n}`;
    })(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
  return { deps, ports, sentAudio };
}

describe("PlayerLink", () => {
  it("does not create the offscreen document just to look", async () => {
    const { deps, ports } = document();
    const link = new PlayerLink(deps);
    await link.ready();
    expect(deps.createDocument).not.toHaveBeenCalled();
    expect(ports).toHaveLength(0);
    expect(link.view).toBeNull();
  });

  it("watches its own tab only, and follows the state", async () => {
    const { deps, ports } = document({ exists: true });
    const link = new PlayerLink(deps);
    const changes = vi.fn();
    link.subscribe(changes);
    await link.ready();
    expect(ports[0]!.sent).toEqual([{ type: "watch", tabId: 3 }]);
    ports[0]!.receive({ type: "state", tabId: 4, view: { ...VIEW, sessionId: "other-tab" } });
    expect(link.view).toBeNull();
    ports[0]!.receive({ type: "state", tabId: 3, view: VIEW });
    expect(link.view?.sessionId).toBe("s1");
    // The document closing means no session any more.
    ports[0]!.close();
    expect(link.view).toBeNull();
    // The first (empty) state, the session, and its end.
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("opens: creates the document, sends the Blob only when asked, and reports the session", async () => {
    const { deps, ports, sentAudio } = document();
    const link = new PlayerLink(deps);
    const blob = new Blob(["mp3"], { type: "audio/mpeg" });
    const outcome = await link.open(REQUEST, blob);
    expect(outcome).toEqual({ ok: true, sessionId: "s1" });
    expect(deps.createDocument).toHaveBeenCalledTimes(1);
    expect(ports[0]!.sent.map((m) => m.type)).toEqual(["watch", "open"]);
    expect(ports[0]!.sent[1]).toMatchObject({ type: "open", tabId: 3, transferId: "t1", ...REQUEST });
    // The token is never part of what goes to the document.
    expect(JSON.stringify(ports[0]!.sent)).not.toMatch(/token|Bearer/);
    expect(sentAudio).toEqual([["t1", blob]]);
    await Promise.resolve();
    link.command({ command: "play" });
    link.setFloating(true);
    link.end();
    expect(ports[0]!.sent.slice(2)).toEqual([
      { type: "command", tabId: 3, sessionId: "s1", command: "play" },
      { type: "floating", tabId: 3, sessionId: "s1", visible: true },
      { type: "end", tabId: 3, sessionId: null },
    ]);
  });

  it("passes on a refusal, and closing the panel only disconnects", async () => {
    const { deps, ports } = document({ failOpen: "revoked" });
    const link = new PlayerLink(deps);
    expect(await link.open(REQUEST, new Blob(["x"], { type: "audio/mpeg" }))).toEqual({ ok: false, reason: "revoked" });
    link.dispose();
    expect(ports[0]!.disconnect).toHaveBeenCalled();
    expect(ports[0]!.sent.some((m) => m.type === "end")).toBe(false);
  });

  it("tries once more when the document went away during the open", async () => {
    const { deps, ports, sentAudio } = document();
    const link = new PlayerLink(deps);
    const first = deps.connect;
    let calls = 0;
    deps.connect = () => {
      const port = first() as FakePort;
      calls += 1;
      // The first document closes itself right after the port opened.
      if (calls === 1) queueMicrotask(() => port.close());
      return port;
    };
    const outcome = await link.open(REQUEST, new Blob(["x"], { type: "audio/mpeg" }));
    expect(outcome).toEqual({ ok: true, sessionId: "s1" });
    expect(ports).toHaveLength(2);
    expect(sentAudio).toHaveLength(1);
  });
});
