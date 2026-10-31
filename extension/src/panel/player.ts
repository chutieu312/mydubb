// The side panel's link to its tab's playback session in the offscreen document (see
// src/offscreen/hub.ts). The panel never plays audio itself: it downloads the MP3 with the token
// (api.getAudio), hands the Blob over on the extension-origin BroadcastChannel when the offscreen
// document asks for it, and from then on only shows the session's state and sends commands. Closing
// the panel disconnects this link; the session (and the audio) carries on.

import {
  isPlayerToPanel,
  type OpenFailure,
  type PanelPlayerView,
  type PanelToPlayer,
  type PlaybackChoices,
  type PlaybackOwner,
  type PlayerCommand,
  type PlayerToPanel,
} from "../shared/playback";

export interface PanelPort {
  postMessage(message: PanelToPlayer): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface PlayerDeps {
  tabId: number;
  /** Whether the offscreen document exists (it is never created just to look). */
  hasDocument(): Promise<boolean>;
  /** Creates the offscreen document unless it exists (another panel may be creating it too). */
  createDocument(): Promise<void>;
  /** chrome.runtime.connect({name: PLAYER_PANEL_PORT}) */
  connect(): PanelPort;
  /** Posts the Blob on AUDIO_CHANNEL. */
  sendAudio(transferId: string, blob: Blob): void;
  randomId(): string;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface OpenRequest {
  lessonKey: string;
  owner: PlaybackOwner;
  choices: PlaybackChoices;
}

export type OpenOutcome = { ok: true; sessionId: string } | { ok: false; reason: OpenFailure | "unavailable" };

/** What dubbing.ts needs from the player link (a fake in unit tests). */
export interface PanelPlayer {
  readonly view: PanelPlayerView | null;
  subscribe(listener: () => void): void;
  /** Resolves once the current session (or its absence) is known. */
  ready(): Promise<void>;
  open(request: OpenRequest, blob: Blob): Promise<OpenOutcome>;
  command(command: PlayerCommand): void;
  setFloating(visible: boolean): void;
  /** Ends this tab's session (any, when no id is given). */
  end(sessionId?: string): void;
  dispose(): void;
}

const READY_TIMEOUT_MS = 3_000;
const OPEN_TIMEOUT_MS = 40_000;

interface Waiter {
  transferId: string;
  blob: Blob;
  resolve(outcome: OpenOutcome): void;
  timer: number;
}

export class PlayerLink implements PanelPlayer {
  view: PanelPlayerView | null = null;
  private port: PanelPort | null = null;
  private readonly listeners = new Set<() => void>();
  private readying: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private waiter: Waiter | null = null;
  private disposed = false;

  constructor(private readonly deps: PlayerDeps) {}

  subscribe(listener: () => void): void {
    this.listeners.add(listener);
  }

  ready(): Promise<void> {
    this.readying ??= this.watch();
    return this.readying;
  }

  /** Connects to the offscreen document if it exists and waits for the first state. */
  private async watch(): Promise<void> {
    let exists = false;
    try {
      exists = await this.deps.hasDocument();
    } catch {
      exists = false;
    }
    if (!exists || this.disposed) return;
    await this.attach();
  }

  /** Opens the port (if needed) and resolves on the first state, or after a short wait. */
  private attach(): Promise<void> {
    if (this.port) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let port: PanelPort;
      try {
        port = this.deps.connect();
      } catch {
        resolve();
        return;
      }
      this.port = port;
      const timer = this.deps.setTimeout(() => this.settleReady(), READY_TIMEOUT_MS);
      this.resolveReady = () => {
        this.deps.clearTimeout(timer);
        resolve();
      };
      port.onMessage.addListener((message) => {
        if (this.port === port) this.onMessage(message);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        // The document closed (nothing left to play) or crashed: no session any more.
        this.port = null;
        this.settleReady();
        this.failWaiter("unavailable");
        this.setView(null);
      });
      this.post({ type: "watch", tabId: this.deps.tabId });
    });
  }

  private settleReady(): void {
    const resolve = this.resolveReady;
    this.resolveReady = null;
    resolve?.();
  }

  private onMessage(message: unknown): void {
    if (!isPlayerToPanel(message) || message.tabId !== this.deps.tabId) return;
    this.handle(message);
  }

  private handle(message: PlayerToPanel): void {
    switch (message.type) {
      case "state":
        this.settleReady();
        this.setView(message.view);
        return;
      case "send-audio": {
        const waiter = this.waiter;
        if (waiter?.transferId === message.transferId) this.deps.sendAudio(waiter.transferId, waiter.blob);
        return;
      }
      case "opened":
        if (this.waiter?.transferId === message.transferId) this.finishWaiter({ ok: true, sessionId: message.sessionId });
        return;
      case "open-failed":
        if (this.waiter?.transferId === message.transferId) this.failWaiter(message.reason);
    }
  }

  private setView(view: PanelPlayerView | null): void {
    this.view = view;
    for (const listener of this.listeners) listener();
  }

  /** Hands this result's audio to the offscreen document: the tab's previous session ends first. */
  async open(request: OpenRequest, blob: Blob): Promise<OpenOutcome> {
    if (this.disposed) return { ok: false, reason: "unavailable" };
    // One attempt plus one retry: the document may close itself between the check and the port.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.deps.createDocument();
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (this.disposed) return { ok: false, reason: "unavailable" };
      await this.attach();
      if (!this.port) continue;
      const outcome = await this.send(request, blob);
      if (outcome.ok || outcome.reason !== "unavailable") return outcome;
    }
    return { ok: false, reason: "unavailable" };
  }

  private send(request: OpenRequest, blob: Blob): Promise<OpenOutcome> {
    this.failWaiter("busy");
    const transferId = this.deps.randomId();
    return new Promise<OpenOutcome>((resolve) => {
      const timer = this.deps.setTimeout(() => this.failWaiter("timeout"), OPEN_TIMEOUT_MS);
      this.waiter = { transferId, blob, resolve, timer };
      this.post({ type: "open", tabId: this.deps.tabId, transferId, ...request });
    });
  }

  private finishWaiter(outcome: OpenOutcome): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    this.deps.clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }

  private failWaiter(reason: OpenFailure | "unavailable"): void {
    this.finishWaiter({ ok: false, reason });
  }

  command(command: PlayerCommand): void {
    const view = this.view;
    if (view) this.post({ type: "command", tabId: this.deps.tabId, sessionId: view.sessionId, ...command });
  }

  setFloating(visible: boolean): void {
    const view = this.view;
    if (view) this.post({ type: "floating", tabId: this.deps.tabId, sessionId: view.sessionId, visible });
  }

  end(sessionId?: string): void {
    if (!this.port) return;
    this.post({ type: "end", tabId: this.deps.tabId, sessionId: sessionId ?? null });
  }

  dispose(): void {
    this.disposed = true;
    this.failWaiter("unavailable");
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // already gone
    }
  }

  private post(message: PanelToPlayer): void {
    try {
      this.port?.postMessage(message);
    } catch {
      // The document went away; onDisconnect clears the state.
    }
  }
}
