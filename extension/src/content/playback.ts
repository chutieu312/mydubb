// The Udemy page's link to its tab's MyDubb playback session (offscreen document). Opened only when
// the tab's side panel asks (after a session exists for this lecture), it keeps the content
// script's lecture watch running even with the panel closed, so a lecture change, a reload or
// leaving the page always ends the session instead of letting the audio play on elsewhere.
// With Sync with video on, it also runs the coordinator's video operations (sync.ts).

import {
  isPlayerToPage,
  type PageToPlayer,
  type PlayerCommand,
  type PlayerView,
} from "../shared/playback";
import type { FloatingActions } from "./floating";
import { VideoSync } from "./sync";

/** The subset of chrome.runtime.Port used here. */
export interface PlayerPort {
  postMessage(message: PageToPlayer): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface FloatingView {
  render(view: PlayerView): void;
  hide(): void;
}

export interface LinkEnv {
  /** chrome.runtime.connect({name: PLAYER_PAGE_PORT}) */
  connect(): PlayerPort;
  createPlayer(actions: FloatingActions): FloatingView;
}

export class PlaybackLink {
  private port: PlayerPort | null = null;
  private lessonKey: string | null = null;
  private view: PlayerView | null = null;
  private player: FloatingView | null = null;
  private readonly sync: VideoSync | null;

  constructor(
    private readonly env: LinkEnv,
    private readonly onEnd: () => void,
    /** The lecture video the content script identified; absent: no Sync with video. */
    video?: { doc: Document; current(): HTMLVideoElement | null },
  ) {
    this.sync = video ? new VideoSync({ ...video, send: (message) => this.post(message) }) : null;
  }

  /** The identified video may have changed: a synced one that is no longer it ends the sync. */
  videoChanged(): void {
    this.sync?.check();
  }

  get active(): boolean {
    return this.port !== null;
  }

  /** Links this page (showing `lessonKey`) to the tab's session; a second call is a no-op. */
  link(lessonKey: string): void {
    if (this.port && this.lessonKey === lessonKey) return;
    if (this.port) this.end();
    let port: PlayerPort;
    try {
      port = this.env.connect();
    } catch {
      return;
    }
    this.port = port;
    this.lessonKey = lessonKey;
    port.onMessage.addListener((message) => {
      if (this.port !== port || !isPlayerToPage(message)) return;
      if (message.type === "ended") return this.end();
      if (message.type === "video") return this.sync?.handle(message);
      // Never shown for another lecture than the one this page links.
      if (message.view.lessonKey !== this.lessonKey) return this.end();
      this.view = message.view;
      this.playerUi().render(message.view);
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.end();
    });
    this.post({ type: "hello", lessonKey });
  }

  /** Every lecture change seen by the page: another lecture (or none) ends the session. */
  lesson(key: string | null): void {
    if (!this.port || key === this.lessonKey) return;
    this.post({ type: "lesson", lessonKey: key });
    this.end();
  }

  end(): void {
    const port = this.port;
    if (!port) return;
    this.port = null;
    this.lessonKey = null;
    this.view = null;
    this.sync?.release();
    this.player?.hide();
    try {
      port.disconnect();
    } catch {
      // already gone
    }
    this.onEnd();
  }

  private playerUi(): FloatingView {
    this.player ??= this.env.createPlayer({
      command: (command) => this.command(command),
      close: () => {
        const view = this.view;
        if (view && this.lessonKey) this.post({ type: "close", sessionId: view.sessionId, lessonKey: this.lessonKey });
      },
      sync: (on) => {
        const view = this.view;
        if (view && this.lessonKey) this.post({ type: "sync", sessionId: view.sessionId, lessonKey: this.lessonKey, on });
      },
    });
    return this.player;
  }

  private command(command: PlayerCommand): void {
    const view = this.view;
    if (!view || !this.lessonKey) return;
    this.post({ type: "command", sessionId: view.sessionId, lessonKey: this.lessonKey, ...command });
  }

  private post(message: PageToPlayer): void {
    try {
      this.port?.postMessage(message);
    } catch {
      // The offscreen document went away; onDisconnect ends the link.
    }
  }
}
