// The floating MyDubb player drawn on the Udemy lecture page. It is a remote control only: the
// audio plays in the extension's offscreen document, and this UI receives display state
// (PlayerView) and sends a few playback commands. It holds no token, account, job or audio address,
// and offers no sign-in or Generate. Built with createElement/textContent inside a Shadow DOM, so
// page styles do not reach it; only trusted (real user) events act, never events a page script
// dispatches.

import { formatTime } from "../panel/draft";
import { PLAYER_SEEK_SECONDS, choicesLabel, type PlayerCommand, type PlayerView } from "../shared/playback";
import { syncNoticeText, syncPreviewText, syncStatusText } from "../shared/sync";

export interface FloatingActions {
  command(command: PlayerCommand): void;
  close(): void;
  /** Sync with video on or off (the offscreen document decides whether it can). */
  sync(on: boolean): void;
}

const MARGIN = 8;
const KEY_STEP = 20;

/** Keeps a box of size w×h fully inside a vw×vh viewport (with a margin when there is room). */
export function clampBox(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  const clamp = (value: number, size: number, room: number) => {
    const margin = room - size >= 2 * MARGIN ? MARGIN : 0;
    return Math.max(margin, Math.min(value, Math.max(margin, room - size - margin)));
  };
  return { x: clamp(x, w, vw), y: clamp(y, h, vh) };
}

const STYLE = `
:host { all: initial; }
.box {
  --bg: #ffffff; --fg: #1d1d1f; --muted: #5f6368; --border: #c7c7cc; --accent: #2f5bd3; --accent-fg: #ffffff; --error: #b3261e;
  box-sizing: border-box; width: 264px; max-width: calc(100vw - 16px);
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 6px 8px 8px;
}
@media (prefers-color-scheme: dark) {
  .box { --bg: #1b1c1f; --fg: #ececf1; --muted: #a5a9b1; --border: #4a4d55; --accent: #8fb0ff; --accent-fg: #10131a; --error: #ffb4ab; }
}
.bar { display: flex; align-items: center; gap: 4px; }
.handle {
  flex: 1; font-weight: 600; cursor: grab; padding: 4px 2px; user-select: none; touch-action: none; border-radius: 4px;
}
.handle:active { cursor: grabbing; }
button {
  font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--border); border-radius: 6px;
  padding: 2px 8px; min-height: 26px; cursor: pointer;
}
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); min-width: 56px; }
button:disabled { opacity: 0.5; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.body[hidden] { display: none; }
.info { color: var(--muted); margin: 4px 0; overflow-wrap: anywhere; }
.seek { width: 100%; margin: 4px 0; accent-color: var(--accent); }
.row { display: flex; align-items: center; gap: 6px; }
.time { margin-left: auto; font-variant-numeric: tabular-nums; }
.status { margin: 4px 0 0; color: var(--muted); }
.status.problem { color: var(--error); }
.status:empty { display: none; }
.sync { margin: 6px 0 0; padding-top: 6px; border-top: 1px solid var(--border); }
.sync-state { margin: 0 0 4px; font-weight: 600; }
.sync-confirm[hidden], .sync-toggle[hidden] { display: none; }
.sync-confirm p { margin: 4px 0; color: var(--muted); }
`;

const PROBLEM_TEXT: Record<string, string> = {
  "play-blocked": "Chrome blocked playback. Press Play again.",
  "play-failed": "The audio could not start. Press Play to try again.",
  "media-error": "The audio could not be played. Load it again from the MyDubb panel.",
  "not-linked": "This page is not linked to the player. Reload the lecture tab.",
};

export class FloatingPlayer {
  private host: HTMLElement | null = null;
  private ui: ReturnType<FloatingPlayer["build"]> | null = null;
  private view: PlayerView | null = null;
  private collapsed = false;
  private seeking = false;
  // The explanation shown before Sync is turned on the first time.
  private confirmingSync = false;
  // null: the default place (top right); otherwise where the user moved it.
  private position: { x: number; y: number } | null = null;
  private drag: { pointerId: number; dx: number; dy: number } | null = null;
  private events: AbortController | null = null;

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly actions: FloatingActions,
    private readonly shadowMode: ShadowRootMode = "closed",
    // Real user input only: a page script can dispatch events, but never trusted ones.
    private readonly isTrusted: (event: Event) => boolean = (event) => event.isTrusted,
  ) {}

  get visible(): boolean {
    return this.host !== null;
  }

  render(view: PlayerView): void {
    this.view = view;
    if (!view.floating) {
      this.hide();
      return;
    }
    if (!this.host) this.mount();
    this.update();
  }

  hide(): void {
    this.events?.abort();
    this.events = null;
    this.host?.remove();
    this.host = null;
    this.ui = null;
    this.drag = null;
    this.seeking = false;
  }

  private mount(): void {
    const host = this.doc.createElement("mydubb-player");
    // Inline !important: page styles cannot move, hide or restyle the host.
    const fixed: [string, string][] = [
      ["all", "initial"],
      ["position", "fixed"],
      ["z-index", "2147483646"],
      ["top", "88px"],
      ["right", "16px"],
      ["display", "block"],
    ];
    for (const [name, value] of fixed) host.style.setProperty(name, value, "important");
    const root = host.attachShadow({ mode: this.shadowMode });
    const style = this.doc.createElement("style");
    style.textContent = STYLE;
    this.events = new AbortController();
    this.ui = this.build(this.events.signal);
    root.append(style, this.ui.box);
    this.doc.documentElement.append(host);
    this.host = host;
    if (this.position) this.moveTo(this.position.x, this.position.y);
    // Resizing the window or zooming changes the viewport: the player stays inside it.
    this.win.addEventListener("resize", () => this.keepInside(), { signal: this.events.signal });
  }

  private build(signal: AbortSignal = new AbortController().signal) {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
      const node = this.doc.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const trusted = (handler: (event: Event) => void) => (event: Event) => {
      if (this.isTrusted(event)) handler(event);
    };
    const on = (target: EventTarget, name: string, handler: (event: Event) => void) =>
      target.addEventListener(name, trusted(handler), { signal });

    const box = el("div", "box");
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "MyDubb audio player");
    const bar = el("div", "bar");
    const handle = el("div", "handle", "MyDubb");
    handle.tabIndex = 0;
    handle.title = "Drag to move";
    handle.setAttribute("aria-roledescription", "drag handle");
    handle.setAttribute("aria-label", "MyDubb player. Drag, or use the arrow keys, to move it.");
    const play = el("button", "primary", "Play");
    play.type = "button";
    const collapse = el("button", "", "–");
    collapse.type = "button";
    const close = el("button", "", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close the MyDubb player (pauses the audio)");
    close.title = "Close (pauses the audio)";
    bar.append(handle, play, collapse, close);

    const body = el("div", "body");
    const info = el("p", "info");
    const seek = el("input", "seek");
    seek.type = "range";
    seek.min = "0";
    seek.step = "0.1";
    seek.setAttribute("aria-label", "Position in the MyDubb audio");
    const row = el("div", "row");
    const back = el("button", "", `−${PLAYER_SEEK_SECONDS}s`);
    back.type = "button";
    back.setAttribute("aria-label", `Back ${PLAYER_SEEK_SECONDS} seconds in the MyDubb audio`);
    const forward = el("button", "", `+${PLAYER_SEEK_SECONDS}s`);
    forward.type = "button";
    forward.setAttribute("aria-label", `Forward ${PLAYER_SEEK_SECONDS} seconds in the MyDubb audio`);
    const time = el("span", "time");
    time.setAttribute("aria-label", "MyDubb audio position");
    row.append(back, forward, time);
    const status = el("p", "status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const sync = el("div", "sync");
    sync.setAttribute("role", "group");
    sync.setAttribute("aria-label", "Sync with video");
    const syncState = el("p", "sync-state");
    syncState.setAttribute("role", "status");
    syncState.setAttribute("aria-live", "polite");
    const syncToggle = el("button", "sync-toggle", "Sync with video");
    syncToggle.type = "button";
    const syncConfirm = el("div", "sync-confirm");
    syncConfirm.hidden = true;
    const syncPreview = el("p");
    const syncOn = el("button", "primary", "Turn on sync");
    syncOn.type = "button";
    const syncCancel = el("button", "", "Cancel");
    syncCancel.type = "button";
    const syncRow = el("div", "row");
    syncRow.append(syncOn, syncCancel);
    syncConfirm.append(syncPreview, syncRow);
    const syncNotice = el("p", "status problem");
    syncNotice.setAttribute("role", "alert");
    sync.append(syncState, syncToggle, syncConfirm, syncNotice);
    body.append(info, seek, row, status, sync);
    box.append(bar, body);

    on(play, "click", () => {
      const view = this.view;
      if (view) this.actions.command({ command: view.paused || view.ended ? "play" : "pause" });
    });
    on(back, "click", () => this.actions.command({ command: "seek-by", value: -PLAYER_SEEK_SECONDS }));
    on(forward, "click", () => this.actions.command({ command: "seek-by", value: PLAYER_SEEK_SECONDS }));
    on(syncToggle, "click", () => {
      const view = this.view;
      if (!view) return;
      const s = view.sync;
      if (s.status === "off" && !s.confirmed) {
        this.confirmingSync = true;
        this.update();
      } else if (s.status === "off") this.actions.sync(true);
      else if (s.status !== "unavailable") this.actions.sync(false);
    });
    on(syncOn, "click", () => {
      this.confirmingSync = false;
      this.actions.sync(true);
      this.update();
    });
    on(syncCancel, "click", () => {
      this.confirmingSync = false;
      this.update();
    });
    on(collapse, "click", () => {
      this.collapsed = !this.collapsed;
      this.update();
      this.keepInside();
    });
    on(close, "click", () => {
      this.actions.close();
      this.hide();
    });
    on(seek, "input", () => {
      this.seeking = true;
      time.textContent = `${formatTime(Number(seek.value))} / ${formatTime(this.view?.duration ?? null)}`;
    });
    on(seek, "change", () => {
      this.seeking = false;
      this.actions.command({ command: "seek-to", value: Number(seek.value) });
    });
    // Moving: only the handle drags, so buttons and the seek bar are never taken for a drag.
    on(handle, "pointerdown", (event) => {
      const e = event as PointerEvent;
      if (e.button !== 0) return;
      const rect = box.getBoundingClientRect();
      this.drag = { pointerId: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    on(handle, "pointermove", (event) => {
      const e = event as PointerEvent;
      if (this.drag?.pointerId === e.pointerId) this.moveTo(e.clientX - this.drag.dx, e.clientY - this.drag.dy);
    });
    for (const name of ["pointerup", "pointercancel"]) {
      on(handle, name, (event) => {
        if (this.drag?.pointerId === (event as PointerEvent).pointerId) this.drag = null;
      });
    }
    on(handle, "keydown", (event) => {
      const e = event as KeyboardEvent;
      const step = e.shiftKey ? KEY_STEP * 3 : KEY_STEP;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      this.moveTo(rect.left + move[0], rect.top + move[1]);
    });
    return {
      box,
      play,
      collapse,
      body,
      info,
      seek,
      back,
      forward,
      time,
      status,
      syncState,
      syncToggle,
      syncConfirm,
      syncPreview,
      syncNotice,
    };
  }

  private update(): void {
    const ui = this.ui;
    const view = this.view;
    if (!ui || !view) return;
    const playing = !view.paused && !view.ended;
    ui.play.textContent = playing ? "Pause" : "Play";
    ui.play.setAttribute("aria-label", playing ? "Pause MyDubb audio" : "Play MyDubb audio");
    ui.play.disabled = view.status === "error";
    ui.collapse.textContent = this.collapsed ? "+" : "–";
    ui.collapse.setAttribute("aria-expanded", String(!this.collapsed));
    ui.collapse.setAttribute("aria-label", this.collapsed ? "Expand the MyDubb player" : "Collapse the MyDubb player");
    ui.body.hidden = this.collapsed;
    ui.info.textContent = choicesLabel(view.choices);
    const ready = view.status === "ready";
    ui.back.disabled = !ready;
    ui.forward.disabled = !ready;
    ui.seek.disabled = !ready || view.duration === null;
    ui.seek.max = String(view.duration ?? 0);
    if (!this.seeking) {
      ui.seek.value = String(view.currentTime);
      ui.time.textContent = `${formatTime(view.currentTime)} / ${formatTime(view.duration)}`;
    }
    ui.seek.setAttribute("aria-valuetext", `${formatTime(view.currentTime)} of ${formatTime(view.duration)}`);
    const problem = view.problem ? PROBLEM_TEXT[view.problem] : null;
    ui.status.className = problem ? "status problem" : "status";
    ui.status.textContent = problem ?? (view.status === "loading" ? "Loading the audio…" : view.ended ? "Ended." : "");
    const sync = view.sync;
    if (sync.status !== "off") this.confirmingSync = false;
    ui.syncState.textContent = syncStatusText(sync);
    const on = sync.status !== "off" && sync.status !== "unavailable";
    ui.syncToggle.textContent = on ? "Turn off sync" : "Sync with video";
    ui.syncToggle.setAttribute("aria-pressed", String(on));
    ui.syncToggle.disabled = sync.status === "unavailable";
    ui.syncToggle.hidden = this.confirmingSync;
    ui.syncConfirm.hidden = !this.confirmingSync;
    ui.syncPreview.textContent = syncPreviewText(sync);
    ui.syncNotice.textContent = syncNoticeText(sync);
  }

  private moveTo(x: number, y: number): void {
    const host = this.host;
    const box = this.ui?.box;
    if (!host || !box) return;
    const rect = box.getBoundingClientRect();
    const viewport = this.doc.documentElement;
    const next = clampBox(x, y, rect.width, rect.height, viewport.clientWidth || this.win.innerWidth, viewport.clientHeight || this.win.innerHeight);
    this.position = next;
    host.style.setProperty("left", `${next.x}px`, "important");
    host.style.setProperty("top", `${next.y}px`, "important");
    host.style.setProperty("right", "auto", "important");
  }

  private keepInside(): void {
    const box = this.ui?.box;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    this.moveTo(this.position?.x ?? rect.left, this.position?.y ?? rect.top);
  }
}
