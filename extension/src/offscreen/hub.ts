// The playback sessions of the offscreen document: at most one per tab, each with its own <audio>
// element and object URL, tied to the tab, lecture, account connection and job it was opened for.
// The side panel of a tab and the floating player of that tab's Udemy page are remote controls of
// the same session; nothing else plays MyDubb audio. Kept free of Chrome globals so it can be
// tested: ports, timers and media come in through HubDeps.
//
// Lifecycle: a session ends (audio stopped, object URL revoked, listeners removed) when its panel
// asks, when its page reports another lecture or goes away (reload, navigation, closed tab: the
// page port disconnects), when the tab closes, when the account connection it belongs to ends, or
// when a newer result replaces it. With no session left, the document closes itself.
//
// Sync with video (story 4): each session has a SyncController (sync.ts), off until the user turns
// it on. While it is on, Play/Pause/Seek of the session go through it, so both remote controls
// drive the audio and the video together; ending the session turns it off first, which gives the
// video back what MyDubb changed.

import { UDEMY_ORIGIN } from "../shared/lesson";
import { isOwnExtensionPage } from "../shared/messages";
import {
  clampPosition,
  isAudioTransfer,
  isPageToPlayer,
  isPanelToPlayer,
  isWorkerToPlayer,
  type OpenFailure,
  type PageToPlayer,
  type PanelPlayerView,
  type PanelToPlayer,
  type PlaybackChoices,
  type PlaybackOwner,
  type PlaybackProblem,
  type PlayerCommand,
  type PlayerToPage,
  type PlayerToPanel,
  type PlayerView,
  type VideoCommand,
} from "../shared/playback";
import type { SyncSource } from "../shared/sync";
import { SyncController, type DriftStats } from "./sync";

export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 30_000;
const IDLE_CLOSE_MS = 5_000;
const TIME_UPDATE_MS = 250;

/** The subset of chrome.runtime.Port used here. */
export interface HubPort<Out> {
  name: string;
  sender?: chrome.runtime.MessageSender;
  postMessage(message: Out): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export type AudioLike = Pick<
  HTMLAudioElement,
  | "paused"
  | "ended"
  | "currentTime"
  | "duration"
  | "readyState"
  | "error"
  | "playbackRate"
  | "defaultPlaybackRate"
  | "preload"
  | "autoplay"
  | "src"
  | "play"
  | "pause"
  | "load"
  | "removeAttribute"
  | "addEventListener"
>;

export interface HubDeps {
  extensionId: string;
  /** chrome.runtime.getURL("sidepanel.html"): the only page allowed to drive a session. */
  panelUrl: string;
  createAudio(): AudioLike;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  randomId(): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Closes the offscreen document (nothing left to play). */
  close(): void;
}

const MEDIA_EVENTS = [
  "play",
  "pause",
  "playing",
  "ended",
  "seeked",
  "durationchange",
  "loadedmetadata",
  "canplay",
  "waiting",
  "emptied",
  "error",
] as const;

class Session {
  problem: PlaybackProblem | null = null;
  readonly sync: SyncController;
  private readonly claim: () => void;
  private readonly events = new AbortController();
  private lastTick = 0;

  constructor(
    readonly id: string,
    readonly tabId: number,
    readonly lessonKey: string,
    readonly owner: PlaybackOwner,
    readonly choices: PlaybackChoices,
    readonly audio: AudioLike,
    private readonly url: string,
    public floating: boolean,
    syncSource: SyncSource | null,
    private readonly deps: Pick<HubDeps, "revokeObjectURL" | "now" | "randomId" | "setTimeout" | "clearTimeout">,
    private readonly onChange: (session: Session) => void,
    page: { post(message: VideoCommand): boolean; linked(): boolean; claim(): void },
  ) {
    this.claim = page.claim;
    this.sync = new SyncController(syncSource, audio, {
      ...page,
      randomId: () => deps.randomId(),
      now: () => deps.now(),
      setTimeout: (fn, ms) => deps.setTimeout(fn, ms),
      clearTimeout: (id) => deps.clearTimeout(id),
      changed: () => onChange(this),
    });
    const options = { signal: this.events.signal };
    for (const name of MEDIA_EVENTS) audio.addEventListener(name, () => this.changed(name), options);
    audio.addEventListener("timeupdate", () => this.tick(), options);
    // The speed is already in the file: always 1x, whatever asks otherwise.
    audio.addEventListener("ratechange", () => this.keepNormalRate(), options);
    audio.autoplay = false;
    audio.preload = "auto";
    this.keepNormalRate();
    audio.src = url;
  }

  keepNormalRate(): void {
    if (this.audio.defaultPlaybackRate !== 1) this.audio.defaultPlaybackRate = 1;
    if (this.audio.playbackRate !== 1) this.audio.playbackRate = 1;
  }

  private changed(name: string): void {
    if (name === "error") this.problem = "media-error";
    else if (name === "playing" && this.problem !== "media-error") this.problem = null;
    // However it started (MyDubb, media controls, a resume), this audio now plays: no other tab's.
    // A late "play" of an element paused since then claims nothing.
    if (name === "play" && !this.audio.paused) this.claim();
    this.sync.onAudioEvent(name);
    this.onChange(this);
  }

  private tick(): void {
    const now = this.deps.now();
    if (now - this.lastTick < TIME_UPDATE_MS) return;
    this.lastTick = now;
    this.onChange(this);
  }

  view(): PlayerView {
    const a = this.audio;
    const duration = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null;
    return {
      sessionId: this.id,
      lessonKey: this.lessonKey,
      status: a.error ? "error" : a.readyState >= 1 ? "ready" : "loading",
      paused: a.paused,
      ended: a.ended,
      currentTime: Number.isFinite(a.currentTime) ? a.currentTime : 0,
      duration,
      problem: this.problem,
      choices: this.choices,
      floating: this.floating,
      sync: this.sync.view(),
    };
  }

  dispose(): void {
    this.sync.dispose();
    this.events.abort();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.deps.revokeObjectURL(this.url);
  }
}

interface PendingOpen {
  tabId: number;
  port: HubPort<PlayerToPanel>;
  lessonKey: string;
  owner: PlaybackOwner;
  choices: PlaybackChoices;
  sync: SyncSource | null;
  timer: number;
}

export class PlaybackHub {
  private readonly sessions = new Map<number, Session>();
  private readonly panels = new Map<HubPort<PlayerToPanel>, number | null>();
  private readonly pages = new Map<number, HubPort<PlayerToPage>>();
  private readonly pending = new Map<string, PendingOpen>();
  // Account connections that ended: their sessions are gone and none is opened for them again.
  private readonly revoked = new Set<string>();
  // The connection the service worker last reported (undefined: none reported yet).
  private identity: string | null | undefined = undefined;
  private idleTimer: number | null = null;

  constructor(private readonly deps: HubDeps) {
    this.scheduleIdle();
  }

  /** Sessions by tab, for tests and the browser-test inspection hook. */
  get tabs(): ReadonlyMap<number, { audio: AudioLike; view: PlayerView; drift: DriftStats }> {
    return new Map([...this.sessions].map(([tab, s]) => [tab, { audio: s.audio, view: s.view(), drift: { ...s.sync.stats } }]));
  }

  // ---- Side panel ----------------------------------------------------------------------------

  acceptPanel(port: HubPort<PlayerToPanel>): boolean {
    if (!isOwnExtensionPage(port.sender, this.deps.extensionId, this.deps.panelUrl)) {
      port.disconnect();
      return false;
    }
    this.panels.set(port, null);
    port.onDisconnect.addListener(() => {
      this.panels.delete(port);
      // A transfer the closed panel had started can no longer arrive.
      for (const [id, open] of this.pending) if (open.port === port) this.dropPending(id, null);
      this.scheduleIdle();
    });
    port.onMessage.addListener((message) => this.onPanelMessage(port, message));
    return true;
  }

  private onPanelMessage(port: HubPort<PlayerToPanel>, message: unknown): void {
    if (!isPanelToPlayer(message)) return;
    const bound = this.panels.get(port);
    if (bound === undefined) return;
    if (bound === null) {
      // The first message binds the port to the tab named in the panel's own address only.
      if (message.type !== "watch" || !this.panelTabMatches(port, message.tabId)) {
        port.disconnect();
        this.panels.delete(port);
        return;
      }
      this.panels.set(port, message.tabId);
      this.post(port, { type: "state", tabId: message.tabId, view: this.panelView(message.tabId) });
      return;
    }
    if (message.tabId !== bound) return;
    switch (message.type) {
      case "watch":
        this.post(port, { type: "state", tabId: bound, view: this.panelView(bound) });
        return;
      case "open":
        this.startOpen(port, message);
        return;
      case "command":
        this.runCommand(bound, message.sessionId, message);
        return;
      case "floating": {
        const session = this.sessions.get(bound);
        if (!session || session.id !== message.sessionId) return this.publish(bound);
        session.floating = message.visible;
        this.publish(bound);
        return;
      }
      case "sync":
        this.setSync(bound, message.sessionId, message.on);
        return;
      case "end": {
        const session = this.sessions.get(bound);
        if (session && (message.sessionId === null || session.id === message.sessionId)) this.endSession(bound);
        return;
      }
    }
  }

  private panelTabMatches(port: HubPort<PlayerToPanel>, tabId: number): boolean {
    try {
      return new URL(port.sender?.url ?? "").searchParams.get("tabId") === String(tabId);
    } catch {
      return false;
    }
  }

  private startOpen(port: HubPort<PlayerToPanel>, message: Extract<PanelToPlayer, { type: "open" }>): void {
    const { tabId, transferId } = message;
    if (!this.allowed(message.owner.connectionId)) {
      this.post(port, { type: "open-failed", tabId, transferId, reason: "revoked" });
      return;
    }
    // One transfer per tab: an older one is abandoned.
    for (const [id, open] of this.pending) if (open.tabId === tabId) this.dropPending(id, "busy");
    this.cancelIdle();
    const timer = this.deps.setTimeout(() => this.dropPending(transferId, "timeout"), TRANSFER_TIMEOUT_MS);
    this.pending.set(transferId, {
      tabId,
      port,
      lessonKey: message.lessonKey,
      owner: message.owner,
      choices: message.choices,
      sync: message.sync,
      timer,
    });
    this.post(port, { type: "send-audio", tabId, transferId });
  }

  private dropPending(transferId: string, reason: OpenFailure | null): void {
    const open = this.pending.get(transferId);
    if (!open) return;
    this.pending.delete(transferId);
    this.deps.clearTimeout(open.timer);
    if (reason) this.post(open.port, { type: "open-failed", tabId: open.tabId, transferId, reason });
    this.scheduleIdle();
  }

  /** A Blob from AUDIO_CHANNEL: used only for a transfer this document asked for. */
  receiveAudio(data: unknown): void {
    const transferId = (data as { transferId?: unknown } | null)?.transferId;
    const open = typeof transferId === "string" ? this.pending.get(transferId) : undefined;
    if (!open || typeof transferId !== "string") return;
    if (!isAudioTransfer(data, MAX_AUDIO_BYTES)) return this.dropPending(transferId, "invalid-audio");
    this.pending.delete(transferId);
    this.deps.clearTimeout(open.timer);
    if (!this.panels.has(open.port) || !this.allowed(open.owner.connectionId)) {
      if (this.panels.has(open.port)) this.post(open.port, { type: "open-failed", tabId: open.tabId, transferId, reason: "revoked" });
      this.scheduleIdle();
      return;
    }
    const previous = this.sessions.get(open.tabId);
    // The old audio is stopped and released before the new one exists.
    if (previous) {
      this.sessions.delete(open.tabId);
      previous.dispose();
    }
    const floating = !!previous && previous.floating && previous.lessonKey === open.lessonKey;
    if (previous && previous.lessonKey !== open.lessonKey) this.dropPage(open.tabId);
    const session = new Session(
      this.deps.randomId(),
      open.tabId,
      open.lessonKey,
      open.owner,
      open.choices,
      this.deps.createAudio(),
      this.deps.createObjectURL(data.blob),
      floating,
      open.sync,
      this.deps,
      (s) => this.sessions.get(s.tabId) === s && this.publish(s.tabId),
      {
        post: (message) => this.postVideo(open.tabId, message),
        linked: () => this.pages.has(open.tabId),
        claim: () => this.claim(open.tabId),
      },
    );
    this.sessions.set(open.tabId, session);
    this.post(open.port, { type: "opened", tabId: open.tabId, transferId, sessionId: session.id });
    this.publish(open.tabId);
  }

  // ---- Udemy page (content script) -----------------------------------------------------------

  acceptPage(port: HubPort<PlayerToPage>): boolean {
    const tabId = this.pageTab(port.sender);
    if (tabId === null) {
      port.disconnect();
      return false;
    }
    let linked = false;
    port.onMessage.addListener((message) => {
      if (!isPageToPlayer(message)) return;
      if (!linked) {
        if (message.type !== "hello") return;
        linked = this.linkPage(tabId, port, message.lessonKey);
        return;
      }
      if (this.pages.get(tabId) === port) this.onPageMessage(tabId, message);
    });
    port.onDisconnect.addListener(() => {
      // The page reloaded, navigated or closed: its session ends with it (never plays on).
      if (this.pages.get(tabId) !== port) return;
      this.pages.delete(tabId);
      this.endSession(tabId);
    });
    return true;
  }

  /** The tab of a top-frame Udemy content script of this extension, or null. */
  private pageTab(sender: chrome.runtime.MessageSender | undefined): number | null {
    const tabId = sender?.tab?.id;
    if (!sender || sender.id !== this.deps.extensionId || sender.frameId !== 0 || typeof tabId !== "number") return null;
    try {
      return new URL(sender.url ?? "").origin === UDEMY_ORIGIN ? tabId : null;
    } catch {
      return null;
    }
  }

  private linkPage(tabId: number, port: HubPort<PlayerToPage>, lessonKey: string): boolean {
    const session = this.sessions.get(tabId);
    if (!session || session.lessonKey !== lessonKey) {
      // Nothing to show for this page; a session of another lecture must not survive either.
      if (session) this.endSession(tabId);
      this.safePost(port, { type: "ended" });
      port.disconnect();
      return false;
    }
    const older = this.pages.get(tabId);
    // A second page of the tab: the video the first one bound is not this page's.
    if (older && session.sync.active) session.sync.disable("video-replaced");
    this.pages.set(tabId, port);
    if (older) {
      this.safePost(older, { type: "ended" });
      older.disconnect();
    }
    this.publish(tabId);
    return true;
  }

  private onPageMessage(tabId: number, message: PageToPlayer): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    switch (message.type) {
      case "hello":
        return;
      case "lesson":
        if (message.lessonKey !== session.lessonKey) this.endSession(tabId);
        return;
      case "command":
        if (message.lessonKey !== session.lessonKey) return this.endSession(tabId);
        this.runCommand(tabId, message.sessionId, message);
        return;
      case "close":
        // Close: pause and hide; the session (and the panel's way back to it) stays. With Sync on,
        // the video pauses too: it never runs on alone.
        if (message.sessionId !== session.id || message.lessonKey !== session.lessonKey) return this.publish(tabId);
        if (session.sync.active) session.sync.pause();
        else session.audio.pause();
        session.floating = false;
        this.publish(tabId);
        return;
      case "sync":
        if (message.lessonKey !== session.lessonKey) return this.endSession(tabId);
        this.setSync(tabId, message.sessionId, message.on);
        return;
      case "video-reply":
        session.sync.onVideoReply(message);
        return;
      case "video-event":
        session.sync.onVideoEvent(message.syncId, message.event, message.video);
    }
  }

  /** Sync with video on or off, from either remote control of that session. */
  private setSync(tabId: number, sessionId: string, on: boolean): void {
    const session = this.sessions.get(tabId);
    if (!session || session.id !== sessionId) return this.publish(tabId);
    if (!on) return session.sync.disable();
    void session.sync.enable();
  }

  /**
   * One MyDubb audio at a time: before (and whenever) the audio of `tabId` starts, every other tab's
   * session is paused, keeping its position, and with Sync on its video too. Every start goes
   * through here: MyDubb's Play, Play on a synced video, a resume after buffering, media controls.
   */
  private claim(tabId: number): void {
    for (const other of this.sessions.values()) if (other.tabId !== tabId) this.pauseSession(other, "other-tab");
  }

  private pauseSession(session: Session, notice: "other-tab" | null = null): void {
    if (session.sync.active) session.sync.pause(notice);
    else if (!session.audio.paused) session.audio.pause();
  }

  /** A video operation for the tab's page; false when no page is linked. */
  private postVideo(tabId: number, message: VideoCommand): boolean {
    const page = this.pages.get(tabId);
    if (!page) return false;
    try {
      page.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  private dropPage(tabId: number): void {
    const page = this.pages.get(tabId);
    if (!page) return;
    this.pages.delete(tabId);
    this.safePost(page, { type: "ended" });
    page.disconnect();
  }

  // ---- Service worker ------------------------------------------------------------------------

  onWorkerMessage(message: unknown, sender: chrome.runtime.MessageSender | undefined): boolean {
    if (!isWorkerToPlayer(message) || !this.fromExtension(sender)) return false;
    if (message.type === "mydubb:player-tab-closed") {
      for (const [id, open] of this.pending) if (open.tabId === message.tabId) this.dropPending(id, null);
      this.endSession(message.tabId);
      return true;
    }
    this.identity = message.connectionId;
    for (const [tabId, session] of [...this.sessions]) {
      if (session.owner.connectionId !== message.connectionId) {
        this.revoked.add(session.owner.connectionId);
        this.endSession(tabId);
      }
    }
    for (const [id, open] of this.pending) {
      if (!this.allowed(open.owner.connectionId)) this.dropPending(id, "revoked");
    }
    return true;
  }

  /** The extension's own worker or pages (no tab): never a content script or web page. */
  private fromExtension(sender: chrome.runtime.MessageSender | undefined): boolean {
    return (
      !!sender &&
      sender.id === this.deps.extensionId &&
      !sender.tab &&
      typeof sender.url === "string" &&
      sender.url.startsWith(`chrome-extension://${this.deps.extensionId}/`)
    );
  }

  private allowed(connectionId: string): boolean {
    return !this.revoked.has(connectionId) && (this.identity === undefined || this.identity === connectionId);
  }

  // ---- Playback ------------------------------------------------------------------------------

  private runCommand(tabId: number, sessionId: string, command: PlayerCommand): void {
    const session = this.sessions.get(tabId);
    // A command for an older session (or another tab) changes nothing.
    if (!session || session.id !== sessionId) return this.publish(tabId);
    const audio = session.audio;
    if (session.sync.active) return this.runSynced(session, command);
    switch (command.command) {
      case "play":
        void this.play(session);
        return;
      case "pause":
        audio.pause();
        break;
      case "seek-by":
      case "seek-to": {
        if (audio.readyState < 1) break;
        const duration = Number.isFinite(audio.duration) ? audio.duration : null;
        const base = command.command === "seek-by" ? audio.currentTime + (command.value ?? 0) : (command.value ?? 0);
        audio.currentTime = clampPosition(base, duration);
        break;
      }
    }
    this.publish(tabId);
  }

  /** Sync on: both timelines move; the seek values stay in MP3 seconds. */
  private runSynced(session: Session, command: PlayerCommand): void {
    switch (command.command) {
      case "play":
        if (!this.pages.has(session.tabId)) {
          session.problem = "not-linked";
          break;
        }
        this.claim(session.tabId);
        session.problem = null;
        void session.sync.play();
        break;
      case "pause":
        session.sync.pause();
        break;
      case "seek-by":
      case "seek-to":
        if (session.audio.readyState < 1) break;
        void session.sync.seek(
          command.command === "seek-by" ? session.audio.currentTime + (command.value ?? 0) : (command.value ?? 0),
        );
    }
    this.publish(session.tabId);
  }

  private async play(session: Session): Promise<void> {
    if (!this.pages.has(session.tabId)) {
      // Without the page's content script nobody would notice the lecture changing.
      session.problem = "not-linked";
      this.publish(session.tabId);
      return;
    }
    this.claim(session.tabId);
    session.keepNormalRate();
    session.problem = null;
    try {
      await session.audio.play();
    } catch (error) {
      if (this.sessions.get(session.tabId) !== session) return;
      const name = typeof error === "object" && error !== null ? String((error as { name?: unknown }).name) : "";
      // AbortError: paused or replaced before it started, nothing to report.
      if (name === "NotAllowedError") session.problem = "play-blocked";
      else if (name !== "AbortError") session.problem = "play-failed";
    }
    this.publish(session.tabId);
  }

  private endSession(tabId: number): void {
    const session = this.sessions.get(tabId);
    if (session) {
      this.sessions.delete(tabId);
      session.dispose();
    }
    this.dropPage(tabId);
    for (const [port, bound] of this.panels) if (bound === tabId) this.post(port, { type: "state", tabId, view: null });
    this.scheduleIdle();
  }

  private panelView(tabId: number): PanelPlayerView | null {
    const session = this.sessions.get(tabId);
    if (!session) return null;
    return { ...session.view(), owner: session.owner, linked: this.pages.has(tabId) };
  }

  private publish(tabId: number): void {
    const view = this.panelView(tabId);
    for (const [port, bound] of this.panels) if (bound === tabId) this.post(port, { type: "state", tabId, view });
    const page = this.pages.get(tabId);
    const session = this.sessions.get(tabId);
    if (page && session) this.safePost(page, { type: "view", view: session.view() });
  }

  private post(port: HubPort<PlayerToPanel>, message: PlayerToPanel): void {
    try {
      port.postMessage(message);
    } catch {
      // The panel went away; its onDisconnect cleans up.
    }
  }

  private safePost(port: HubPort<PlayerToPage>, message: PlayerToPage): void {
    try {
      port.postMessage(message);
    } catch {
      // The page went away; its onDisconnect cleans up.
    }
  }

  // ---- Document lifetime ---------------------------------------------------------------------

  private cancelIdle(): void {
    if (this.idleTimer !== null) this.deps.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    if (this.sessions.size > 0 || this.pending.size > 0) return;
    this.idleTimer = this.deps.setTimeout(() => {
      this.idleTimer = null;
      if (this.sessions.size === 0 && this.pending.size === 0) this.deps.close();
    }, IDLE_CLOSE_MS);
  }
}
