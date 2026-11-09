// Content-script session for one tab. It does nothing until a MyDubb side panel connects:
// no background scanning, and every observer/timer stops when the last panel disconnects and no
// playback session is linked to the page (content/playback.ts keeps the lecture watch running for
// the floating player while the panel is closed).
//
// Two kinds of page: a Udemy page (the manifest's content script; the lecture is the identity), and
// an ordinary web page (`web`: injected by chrome.scripting on the user's click on the MyDubb button
// or "Send to MyDubb", activeTab). On an ordinary page the identity is the page's address
// fingerprint (pageKeyOf), and its one main video is chosen by pickPageVideo; it is used only for
// Sync with video. Nothing of the page's text or title is read there.

import { PAGE_SOURCE, pageKeyOf, parseLecture, type LessonInfo } from "../shared/lesson";
import {
  MAX_SELECTION_CHARS,
  PANEL_PORT_NAME,
  isCommandMessage,
  isOwnExtensionPage,
  type CommandError,
  type CommandMessage,
  type ContentToPanel,
  type PageState,
  type VideoState,
  type SelectionReply,
} from "../shared/messages";
import { isPlaybackLinkMessage } from "../shared/playback";
import { PlaybackLink, type LinkEnv } from "./playback";
import { AttachedVideo, isRenderedVideo, pickVideo, type PickResult, type VisibilityCheck } from "./video";

/** The subset of chrome.runtime.Port used here, so tests can pass a fake. */
export interface PortLike {
  name: string;
  sender?: chrome.runtime.MessageSender;
  postMessage(message: ContentToPanel): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface PageEnv {
  doc: Document;
  win: Window;
  extensionId: string;
  /** chrome.runtime.getURL("sidepanel.html"): the only page allowed to connect. */
  panelUrl: string;
  isVisible?: VisibilityCheck;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  /** The link to the tab's MyDubb playback session; absent: no floating player. */
  playback?: LinkEnv;
  /** An ordinary web page (not Udemy): the content script was injected on the user's click. */
  web?: boolean;
  /** Whether an input event came from the user (tests stand in for isTrusted). */
  isTrusted?: (event: Event) => boolean;
  /** Milliseconds (default: performance.now). */
  now?: () => number;
  /** A new video key (isVideoKey); default: 8 random bytes. */
  randomKey?: () => string;
}

function randomVideoKey(): string {
  // getRandomValues works on http pages too (randomUUID needs a secure context).
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `v-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const REFRESH_INTERVAL_MS = 1000;
const MUTATION_DEBOUNCE_MS = 150;
// A video that starts this soon after the user's own click on it (or a key pressed in its player)
// is the one the user chose.
export const USER_START_MS = 1500;

/**
 * Muted and looping: a preview, teaser or background, not a candidate (unless the user chose it or
 * Sync is bound to it). Muted alone is not enough: Loom starts its main video muted by itself.
 */
export function isDecorative(video: HTMLVideoElement): boolean {
  return video.muted && video.loop;
}

/**
 * The main video of an ordinary page. Like pickVideo, but stricter, because a page may play other
 * videos by itself: never "the only one playing" (an autoplaying teaser, even with sound), muted
 * looping videos left out, and with several drawn candidates only the one the user chose (by a real
 * click or key on it) or the one Sync is bound to counts; otherwise ambiguous.
 */
export function pickPageVideo(
  all: Iterable<HTMLVideoElement>,
  synced: HTMLVideoElement | null,
  chosen: HTMLVideoElement | null,
  isVisible: VisibilityCheck = isRenderedVideo,
): PickResult {
  const candidates = [...all].filter((v) => v === synced || v === chosen || !isDecorative(v)).filter(isVisible);
  if (candidates.length === 0) return { kind: "none" };
  if (chosen && candidates.includes(chosen)) return { kind: "video", video: chosen };
  if (synced && candidates.includes(synced)) return { kind: "video", video: synced };
  if (candidates.length === 1) return { kind: "video", video: candidates[0]! };
  return { kind: "ambiguous", candidates: candidates.length };
}

/** Reads the user's current selection as plain text, preserving line breaks; never reads HTML. */
export function readSelection(doc: Document): { text: string; tooLong: boolean } {
  const active = doc.activeElement;
  let text = "";
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const { selectionStart, selectionEnd, value } = active;
    if (selectionStart !== null && selectionEnd !== null) text = value.slice(selectionStart, selectionEnd);
  }
  if (text === "") text = doc.getSelection()?.toString() ?? "";
  if (text.length > MAX_SELECTION_CHARS) return { text: "", tooLong: true };
  return { text, tooLong: false };
}

export function selectionReply(doc: Document, win: Window): SelectionReply {
  return {
    type: "mydubb:selection",
    ...readSelection(doc),
    lesson: parseLecture(win.location.href, doc.title),
  };
}

export class PageSession {
  private readonly ports = new Set<PortLike>();
  private attached: AttachedVideo | null = null;
  private lastPlayed: HTMLVideoElement | null = null;
  private lesson: LessonInfo | null = null;
  private page: string | null = null;
  // An ordinary page: the key of the identified video, for that element and that media source. A
  // new element, a new source (`currentSrc`, or `emptied`/`loadstart` on it) gives a new key.
  private videoKey: { video: HTMLVideoElement; src: string; key: string } | null = null;
  // The user's last real pointerdown (where) or keydown (in which element), ordinary pages only.
  private lastInput: { at: number; x: number; y: number; target: EventTarget | null; key: boolean } | null = null;
  private ambiguousCount = 0;
  private nextVideoId = 1;
  private observer: MutationObserver | null = null;
  private interval: number | null = null;
  private debounce: number | null = null;
  private listeners: AbortController | null = null;
  private lastSent = "";
  private readonly link: PlaybackLink | null;

  constructor(private readonly env: PageEnv) {
    this.link = env.playback
      ? new PlaybackLink(env.playback, () => this.stopIfUnused(), {
          doc: env.doc,
          // An ordinary page's video is driven only while it is the video the link was made for.
          current: () => this.syncTarget(),
        })
      : null;
  }

  get connectedPanels(): number {
    return this.ports.size;
  }

  get playbackLinked(): boolean {
    return this.link?.active ?? false;
  }

  /** A panel is connected or a playback session is linked: the page is watched. */
  private get inUse(): boolean {
    return this.ports.size > 0 || this.playbackLinked;
  }

  private stopIfUnused(): void {
    if (!this.inUse && this.running) this.stop();
  }

  get running(): boolean {
    return this.interval !== null;
  }

  acceptPort(port: PortLike): boolean {
    if (port.name !== PANEL_PORT_NAME) return false;
    if (!isOwnExtensionPage(port.sender, this.env.extensionId, this.env.panelUrl)) {
      port.disconnect();
      return false;
    }
    this.ports.add(port);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      this.stopIfUnused();
    });
    port.onMessage.addListener((message) => {
      void this.handleMessage(port, message);
    });
    if (!this.running) this.start();
    this.refresh();
    this.post(port, { type: "state", state: this.state() });
    return true;
  }

  private start(): void {
    const { doc, win } = this.env;
    const setIntervalFn = this.env.setInterval ?? ((fn, ms) => win.setInterval(fn, ms));
    this.listeners = new AbortController();
    const options = { capture: true, signal: this.listeners.signal };
    // Media events do not bubble; a capturing listener sees the user start any video. On an ordinary
    // page a start counts only right after the user's own click on that video (or a key in its
    // player): a page also starts videos by itself, with or without sound, and neither playing,
    // being unmuted nor the page's user activation says the user chose that one.
    doc.addEventListener(
      "play",
      (event) => {
        if (event.target instanceof HTMLVideoElement && (!this.env.web || this.userStarted(event.target))) {
          this.lastPlayed = event.target;
          this.refresh();
        }
      },
      options,
    );
    if (this.env.web) {
      const trusted = this.env.isTrusted ?? ((event: Event) => event.isTrusted);
      const now = this.now;
      doc.addEventListener(
        "pointerdown",
        (event) => {
          if (trusted(event)) this.lastInput = { at: now(), x: event.clientX, y: event.clientY, target: event.target, key: false };
        },
        { ...options, passive: true },
      );
      doc.addEventListener(
        "keydown",
        (event) => {
          if (trusted(event)) this.lastInput = { at: now(), x: 0, y: 0, target: event.target, key: true };
        },
        { ...options, passive: true },
      );
      // Another source in the identified element: another video, even at the same address.
      for (const name of ["emptied", "loadstart"]) {
        doc.addEventListener(
          name,
          (event) => {
            if (this.attached && event.target === this.attached.video) {
              this.videoKey = null;
              this.refresh();
            }
          },
          options,
        );
      }
    }
    win.addEventListener("online", () => this.broadcast(), options);
    win.addEventListener("offline", () => this.broadcast(), options);
    win.addEventListener("popstate", () => this.refresh(), options);
    // SPA navigation between lectures: Navigation API where present, plus the interval below.
    const navigation = (win as Window & { navigation?: EventTarget }).navigation;
    navigation?.addEventListener("currententrychange", () => this.refresh(), { signal: this.listeners.signal });
    this.observer = new MutationObserver(() => this.scheduleRefresh());
    this.observer.observe(doc.documentElement, { childList: true, subtree: true });
    this.interval = setIntervalFn(() => this.refresh(), REFRESH_INTERVAL_MS);
  }

  private stop(): void {
    const clearIntervalFn = this.env.clearInterval ?? ((id) => this.env.win.clearInterval(id));
    if (this.interval !== null) clearIntervalFn(this.interval);
    if (this.debounce !== null) this.env.win.clearTimeout(this.debounce);
    this.interval = null;
    this.debounce = null;
    this.observer?.disconnect();
    this.observer = null;
    this.listeners?.abort();
    this.listeners = null;
    this.attached?.detach();
    this.attached = null;
    this.lastPlayed = null;
    this.lastInput = null;
    this.lesson = null;
    this.page = null;
    this.videoKey = null;
    this.lastSent = "";
  }

  /** The key of the identified video now (ordinary pages); a new one for a new element or source. */
  private currentVideoKey(): string | null {
    const video = this.attached?.video;
    if (!this.env.web || !video) return null;
    const known = this.videoKey;
    if (known && known.video === video && known.src === video.currentSrc) return known.key;
    this.videoKey = { video, src: video.currentSrc, key: (this.env.randomKey ?? randomVideoKey)() };
    return this.videoKey.key;
  }

  /** The video Sync may drive: on an ordinary page only the one whose key the link was made with. */
  private syncTarget(): HTMLVideoElement | null {
    const video = this.attached?.video ?? null;
    if (!this.env.web || !video) return video;
    const linked = this.link?.videoKey;
    return linked !== undefined && linked === this.currentVideoKey() ? video : null;
  }

  private readonly now = (): number => (this.env.now ? this.env.now() : this.env.win.performance.now());

  /** The user's own click on this video, or a key pressed in its player, came just before it started. */
  private userStarted(video: HTMLVideoElement): boolean {
    const input = this.lastInput;
    if (!input || this.now() - input.at > USER_START_MS) return false;
    if (input.key) {
      const target = input.target;
      if (target === video) return true;
      const { body, documentElement } = this.env.doc;
      // The focused player element: it holds this video and no other.
      return (
        target instanceof Element &&
        target !== body &&
        target !== documentElement &&
        target.contains(video) &&
        target.querySelectorAll("video").length === 1
      );
    }
    const rect = video.getBoundingClientRect();
    return input.x >= rect.left && input.x <= rect.right && input.y >= rect.top && input.y <= rect.bottom;
  }

  private scheduleRefresh(): void {
    if (this.debounce !== null) return;
    this.debounce = this.env.win.setTimeout(() => {
      this.debounce = null;
      this.refresh();
    }, MUTATION_DEBOUNCE_MS);
  }

  /** Re-reads the lecture identity and the video choice, then reports any change. */
  refresh(): void {
    if (!this.inUse) return;
    const { doc, win } = this.env;
    const lesson = this.env.web ? null : parseLecture(win.location.href, doc.title);
    const page = this.env.web ? pageKeyOf(win.location.href) : null;
    const lessonChanged = (lesson?.key ?? null) !== (this.lesson?.key ?? null) || page !== this.page;
    this.lesson = lesson;
    this.page = page;
    if (lessonChanged) this.lastPlayed = null;
    // The MyDubb audio of one lecture never plays on under another one; on an ordinary page, another
    // address (YouTube's next video, another share) ends the link to the video.
    if (lessonChanged) this.link?.lesson(lesson?.key ?? null);

    const isVisible = this.env.isVisible ?? isRenderedVideo;
    const all = doc.querySelectorAll("video");
    const pick: PickResult = this.env.web
      ? pickPageVideo(all, this.link?.syncedVideo ?? null, this.lastPlayed, isVisible)
      : lesson
        ? pickVideo(all, this.attached?.video ?? null, this.lastPlayed, isVisible)
        : { kind: "none" };
    const next = pick.kind === "video" ? pick.video : null;
    // A new lecture always gets a fresh controller, even if Udemy reuses the same element.
    if (next !== (this.attached?.video ?? null) || (lessonChanged && next)) {
      this.attached?.detach();
      this.attached = next ? new AttachedVideo(next, this.nextVideoId++, () => this.broadcast()) : null;
    }
    // An ordinary page's link was made for one video: another element or source ends it, Sync on or
    // off, so the result's audio never drives that other video.
    if (this.env.web && this.link?.active && this.link.videoKey !== this.currentVideoKey()) this.link.lesson(null);
    // A synced video that is no longer the identified one: the sync ends, nothing follows the new one.
    this.link?.videoChanged();
    this.ambiguousCount = pick.kind === "ambiguous" ? pick.candidates : 0;
    this.broadcast();
  }

  state(): PageState {
    return {
      lesson: this.lesson,
      page: this.page,
      online: this.env.win.navigator.onLine,
      video: this.attached
        ? this.env.web
          ? { ...(this.attached.state() as Extract<VideoState, { status: "ready" }>), key: this.currentVideoKey()! }
          : this.attached.state()
        : this.ambiguousCount > 0
          ? { status: "ambiguous", candidates: this.ambiguousCount }
          : { status: "none" },
    };
  }

  private broadcast(): void {
    if (this.ports.size === 0) return;
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSent) return;
    this.lastSent = serialized;
    for (const port of this.ports) this.post(port, { type: "state", state });
  }

  private post(port: PortLike, message: ContentToPanel): void {
    try {
      port.postMessage(message);
    } catch {
      // The panel went away between events; its onDisconnect handler cleans up.
    }
  }

  private async handleMessage(port: PortLike, message: unknown): Promise<void> {
    if (isPlaybackLinkMessage(message)) {
      this.refresh();
      if (this.env.web) {
        // Only for the page shown now, and only while its one main video is identified and is the
        // video (element and source) the result was made with.
        if (
          message.lessonKey === PAGE_SOURCE &&
          message.page !== undefined &&
          message.page === this.page &&
          this.attached &&
          message.video !== undefined &&
          message.video === this.currentVideoKey()
        ) {
          this.link?.link(PAGE_SOURCE, message.page, message.video);
        }
        return;
      }
      // Only for the lecture this page shows now.
      if (this.lesson?.key === message.lessonKey && message.page === undefined) this.link?.link(message.lessonKey);
      return;
    }
    if (!isCommandMessage(message)) {
      const requestId = (message as { requestId?: unknown } | null)?.requestId;
      if (Number.isSafeInteger(requestId)) {
        this.post(port, { type: "result", requestId: requestId as number, ok: false, error: "invalid" });
      }
      return;
    }
    this.refresh();
    const error = await this.execute(message);
    this.post(port, { type: "result", requestId: message.requestId, ok: error === null, ...(error ? { error } : {}) });
    this.lastSent = "";
    this.broadcast();
  }

  private async execute(message: CommandMessage): Promise<CommandError | null> {
    const attached = this.attached;
    if (!attached || !this.lesson) return "no-video";
    // Never act on a lecture or video the panel was not showing when the user clicked.
    if (message.lessonKey !== this.lesson.key || message.videoId !== attached.id) return "stale";
    switch (message.command) {
      case "play":
        return attached.play();
      case "pause":
        return attached.pause();
      case "seek":
        return attached.seekBy(message.delta ?? 0);
      case "place":
        return attached.place(message.at ?? 0);
    }
  }
}
