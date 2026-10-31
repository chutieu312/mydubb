// Content-script session for one Udemy tab. It does nothing until a MyDubb side panel connects:
// no background scanning, and every observer/timer stops when the last panel disconnects.

import { parseLecture, type LessonInfo } from "../shared/lesson";
import {
  MAX_SELECTION_CHARS,
  PANEL_PORT_NAME,
  isCommandMessage,
  isOwnExtensionPage,
  type CommandError,
  type CommandMessage,
  type ContentToPanel,
  type PageState,
  type SelectionReply,
} from "../shared/messages";
import { AttachedVideo, isRenderedVideo, pickVideo, type VisibilityCheck } from "./video";

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
}

const REFRESH_INTERVAL_MS = 1000;
const MUTATION_DEBOUNCE_MS = 150;

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
  private ambiguousCount = 0;
  private nextVideoId = 1;
  private observer: MutationObserver | null = null;
  private interval: number | null = null;
  private debounce: number | null = null;
  private listeners: AbortController | null = null;
  private lastSent = "";

  constructor(private readonly env: PageEnv) {}

  get connectedPanels(): number {
    return this.ports.size;
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
      if (this.ports.size === 0) this.stop();
    });
    port.onMessage.addListener((message) => {
      void this.handleMessage(port, message);
    });
    if (this.ports.size === 1) this.start();
    this.refresh();
    this.post(port, { type: "state", state: this.state() });
    return true;
  }

  private start(): void {
    const { doc, win } = this.env;
    const setIntervalFn = this.env.setInterval ?? ((fn, ms) => win.setInterval(fn, ms));
    this.listeners = new AbortController();
    const options = { capture: true, signal: this.listeners.signal };
    // Media events do not bubble; a capturing listener sees the user start any video.
    doc.addEventListener(
      "play",
      (event) => {
        if (event.target instanceof HTMLVideoElement) {
          this.lastPlayed = event.target;
          this.refresh();
        }
      },
      options,
    );
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
    this.lesson = null;
    this.lastSent = "";
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
    if (this.ports.size === 0) return;
    const { doc, win } = this.env;
    const lesson = parseLecture(win.location.href, doc.title);
    const lessonChanged = (lesson?.key ?? null) !== (this.lesson?.key ?? null);
    this.lesson = lesson;
    if (lessonChanged) this.lastPlayed = null;

    const pick = lesson
      ? pickVideo(doc.querySelectorAll("video"), this.attached?.video ?? null, this.lastPlayed, this.env.isVisible ?? isRenderedVideo)
      : ({ kind: "none" } as const);
    const next = pick.kind === "video" ? pick.video : null;
    // A new lecture always gets a fresh controller, even if Udemy reuses the same element.
    if (next !== (this.attached?.video ?? null) || (lessonChanged && next)) {
      this.attached?.detach();
      this.attached = next ? new AttachedVideo(next, this.nextVideoId++, () => this.broadcast()) : null;
    }
    this.ambiguousCount = pick.kind === "ambiguous" ? pick.candidates : 0;
    this.broadcast();
  }

  state(): PageState {
    return {
      lesson: this.lesson,
      online: this.env.win.navigator.onLine,
      video: this.attached
        ? this.attached.state()
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
    }
  }
}
