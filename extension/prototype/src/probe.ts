// Sync prototype: the probe injected (chrome.scripting, on the user's click) into every frame of
// the tab the extension may access. It reuses the MyDubb content-side modules unchanged:
// pickVideo/AttachedVideo (src/content/video.ts) to identify and read the one video, and VideoSync
// (src/content/sync.ts) to run the offscreen coordinator's operations on it. Nothing here knows a
// site: no adapter, no selector but "video".
//
// It answers only the prototype's own lab page (a port from an extension page, no tab). It never
// reads the page's text, title or full URL; the scan reports origins, sizes and media state only.

import { VideoSync } from "../../src/content/sync";
import { AttachedVideo, isRenderedVideo, pickVideo } from "../../src/content/video";
import { isVideoCommand } from "../../src/shared/playback";
import {
  PROBE_PORT,
  sourceKind,
  type FrameScan,
  type LabToProbe,
  type LostReason,
  type PickReason,
  type ProbeApi,
  type ProbeToLab,
  type Verified,
  type VideoInfo,
} from "./protocol";

const WATCH_INTERVAL_MS = 1000;
const MUTATION_DEBOUNCE_MS = 150;
const PLAY_CHECK_MS = 2000;
const PAUSE_CHECK_MS = 500;
// A play counts as real once the element is not paused and its time moved this much.
const PLAY_ADVANCE_SECONDS = 0.25;

const ids = new WeakMap<HTMLVideoElement, number>();
let nextId = 1;
const idOf = (v: HTMLVideoElement) => {
  let id = ids.get(v);
  if (id === undefined) ids.set(v, (id = nextId++));
  return id;
};

/** Every <video> under open shadow roots too; querySelectorAll alone stops at a shadow boundary. */
function shadowOnlyVideos(doc: Document): number {
  let count = 0;
  const walk = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll("*")) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) {
        count += shadow.querySelectorAll("video").length;
        walk(shadow);
      }
    }
  };
  walk(doc);
  return count;
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0);
const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

class Probe implements ProbeApi {
  private lastPlayed: HTMLVideoElement | null = null;
  private readonly played = new WeakSet<HTMLVideoElement>();
  private readonly userStarted = new WeakSet<HTMLVideoElement>();
  private port: chrome.runtime.Port | null = null;
  private bound: {
    video: HTMLVideoElement;
    attached: AttachedVideo;
    sync: VideoSync;
    src: string;
    path: string;
    href: string;
    lost: boolean;
    watch: AbortController;
    interval: number;
    observer: MutationObserver;
    debounce: number | null;
  } | null = null;

  constructor() {
    // Media events do not bubble; capturing sees any video start. Only the element is kept.
    document.addEventListener(
      "play",
      (event) => {
        const v = event.target;
        if (!(v instanceof HTMLVideoElement)) return;
        this.played.add(v);
        // A muted video starting with no recent input on the page is the page's autoplay, not a
        // choice of the user (media events are not "trusted" input; transient activation is the hint).
        if (this.bound?.video === v || !v.muted || navigator.userActivation?.isActive) {
          this.lastPlayed = v;
          this.userStarted.add(v);
        }
      },
      true,
    );
    chrome.runtime.onConnect.addListener((port) => this.accept(port));
  }

  /**
   * Muted and looping, never started by the user: a preview, teaser or background. Muted autoplay
   * alone is not enough: the real Loom share page starts its main video muted by itself.
   */
  private decorative(v: HTMLVideoElement): boolean {
    return v !== this.bound?.video && v.muted && v.loop && !this.userStarted.has(v);
  }

  /**
   * pickVideo over the candidates (not the decorative videos), without its "the only one playing"
   * rule: with several drawn candidates only the user's own start or the current binding decides.
   */
  private pick(): ReturnType<typeof pickVideo> {
    const candidates = [...document.querySelectorAll("video")].filter((v) => !this.decorative(v));
    const p = pickVideo(candidates, this.bound?.video ?? null, this.lastPlayed, isRenderedVideo);
    const drawn = candidates.filter(isRenderedVideo).length;
    if (p.kind === "video" && drawn > 1 && p.video !== this.lastPlayed && p.video !== this.bound?.video) {
      return { kind: "ambiguous", candidates: drawn };
    }
    return p;
  }

  scan(): FrameScan {
    const all = [...document.querySelectorAll("video")];
    const videos: VideoInfo[] = all.map((v) => {
      const rect = v.getBoundingClientRect();
      return {
        id: idOf(v),
        rendered: isRenderedVideo(v),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        paused: v.paused,
        muted: v.muted,
        autoplay: v.autoplay,
        loop: v.loop,
        currentTime: finite(v.currentTime),
        duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
        readyState: v.readyState,
        rate: v.playbackRate,
        source: sourceKind(v.currentSrc || v.src),
        playedSinceScan: this.played.has(v),
        userStarted: this.userStarted.has(v),
        decorative: this.decorative(v),
      };
    });
    const pick = this.pick();
    let picked: FrameScan["pick"];
    if (pick.kind === "video") {
      const v = pick.video;
      const reason: PickReason = v === this.lastPlayed ? "user-played" : v === this.bound?.video ? "bound" : "only-visible";
      picked = { kind: "video", id: idOf(v), reason };
    } else picked = pick;
    const iframes = [...document.querySelectorAll("iframe")].map((f) => {
      const rect = f.getBoundingClientRect();
      let origin: string | null = null;
      try {
        const url = new URL(f.src, location.href);
        origin = url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
      } catch {
        origin = null;
      }
      return { origin, rendered: rect.width >= 2 && rect.height >= 2, width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    return {
      top: window.top === window,
      origin: location.origin,
      videos,
      shadowVideos: shadowOnlyVideos(document),
      audios: document.querySelectorAll("audio").length,
      userActivation: navigator.userActivation
        ? { hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive }
        : null,
      pick: picked,
      iframes,
    };
  }

  private accept(port: chrome.runtime.Port): void {
    if (port.name !== PROBE_PORT) return;
    // Only the prototype's own lab page: an extension page, not a content script of a tab.
    if (port.sender?.id !== chrome.runtime.id || port.sender.tab || !port.sender.url?.startsWith(chrome.runtime.getURL("lab.html"))) {
      port.disconnect();
      return;
    }
    this.unbind();
    this.port?.disconnect();
    this.port = port;
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.unbind();
    });
    port.onMessage.addListener((message: unknown) => void this.handle(message as LabToProbe));
  }

  private post(message: ProbeToLab): void {
    try {
      this.port?.postMessage(message);
    } catch {
      // The lab went away; onDisconnect cleans up.
    }
  }

  private async handle(message: LabToProbe): Promise<void> {
    if (isVideoCommand(message)) return this.bound?.sync.handle(message);
    switch (message.type) {
      case "bind":
        return this.bind(message.videoId);
      case "sample": {
        const v = this.bound?.video;
        if (!v) return;
        return this.post({
          type: "sample",
          sample: {
            requestId: message.requestId,
            currentTime: finite(v.currentTime),
            paused: v.paused,
            waiting: !v.paused && v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
            rate: v.playbackRate,
            hidden: document.visibilityState === "hidden",
          },
        });
      }
      case "cmd":
        return this.command(message.requestId, message.command, message.delta ?? 0);
    }
  }

  private bind(videoId: number): void {
    this.unbind();
    const pick = this.pick();
    if (pick.kind !== "video") return this.post({ type: "bound", ok: false, error: "no-video" });
    if (idOf(pick.video) !== videoId) return this.post({ type: "bound", ok: false, error: "stale" });
    const video = pick.video;
    const watch = new AbortController();
    const attached = new AttachedVideo(video, videoId, () => this.postState());
    const sync = new VideoSync({
      doc: document,
      // The identified video for as long as it stays the one: after a navigation it is no longer.
      current: () => {
        const b = this.bound;
        if (!b || b.lost) return null;
        const p = this.pick();
        return p.kind === "video" ? p.video : null;
      },
      send: (m) => this.post(m as ProbeToLab),
    });
    const observer = new MutationObserver(() => this.scheduleCheck());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const options = { signal: watch.signal };
    window.addEventListener("popstate", () => this.check(), options);
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    navigation?.addEventListener("currententrychange", () => this.check(), options);
    this.bound = {
      video,
      attached,
      sync,
      src: video.currentSrc,
      path: location.pathname,
      href: location.href,
      lost: false,
      watch,
      interval: window.setInterval(() => this.check(), WATCH_INTERVAL_MS),
      observer,
      debounce: null,
    };
    this.post({ type: "bound", ok: true, videoId });
    this.postState();
  }

  private scheduleCheck(): void {
    const b = this.bound;
    if (!b || b.debounce !== null) return;
    b.debounce = window.setTimeout(() => {
      if (this.bound === b) b.debounce = null;
      this.check();
    }, MUTATION_DEBOUNCE_MS);
  }

  /** Is the bound video still the page's one video, on the same page and media? */
  private check(): void {
    const b = this.bound;
    if (!b) return;
    let reason: LostReason | null = null;
    if (location.pathname !== b.path) reason = "navigated";
    else if (!b.video.isConnected) reason = "removed";
    else if (b.src && b.video.currentSrc && b.video.currentSrc !== b.src) reason = "source-changed";
    else {
      const p = this.pick();
      if (p.kind === "ambiguous") reason = "ambiguous";
      else if (p.kind === "none") reason = "removed";
      else if (p.video !== b.video) reason = "replaced";
    }
    if (!reason) {
      if (!b.src && b.video.currentSrc) b.src = b.video.currentSrc;
      if (location.href !== b.href) {
        const before = new URL(b.href);
        b.href = location.href;
        this.post({ type: "url", change: before.search !== location.search ? "query" : "hash" });
      }
      return;
    }
    b.lost = true;
    // The production path: VideoSync sees the identified video gone, reports "replaced" and lets go.
    b.sync.check();
    this.unbind();
    this.post({ type: "lost", reason });
  }

  private unbind(): void {
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    b.sync.release();
    b.attached.detach();
    b.watch.abort();
    b.observer.disconnect();
    window.clearInterval(b.interval);
    if (b.debounce !== null) window.clearTimeout(b.debounce);
  }

  private postState(): void {
    const b = this.bound;
    if (!b) return;
    this.post({ type: "state", state: b.attached.state(), rate: b.video.playbackRate, muted: b.video.muted });
  }

  /** Play/Pause/seek from MyDubb, then a look at what the element really did. */
  private async command(requestId: number, command: "play" | "pause" | "seek-by", delta: number): Promise<void> {
    const b = this.bound;
    if (!b) return;
    const v = b.video;
    const timeBefore = finite(v.currentTime);
    const started = performance.now();
    const ua = navigator.userActivation;
    const activation = ua ? { hasBeenActive: ua.hasBeenActive, isActive: ua.isActive } : null;
    let error: string | null;
    let outcome: Verified["outcome"];
    if (command === "play") {
      error = await b.attached.play();
      outcome = "still-paused";
      while (performance.now() - started < PLAY_CHECK_MS) {
        if (!v.paused && v.currentTime - timeBefore >= PLAY_ADVANCE_SECONDS) {
          outcome = "playing";
          break;
        }
        // A refused play() leaves nothing to wait for once the element says paused.
        if (error && v.paused) break;
        await delay(100);
      }
      if (outcome !== "playing") outcome = v.paused ? "still-paused" : "not-advancing";
    } else if (command === "pause") {
      error = b.attached.pause();
      await delay(PAUSE_CHECK_MS);
      outcome = v.paused && Math.abs(v.currentTime - timeBefore) < 0.1 ? "paused" : "still-playing";
    } else {
      error = b.attached.seekBy(delta);
      await delay(PAUSE_CHECK_MS);
      outcome = v.paused ? "paused" : "playing";
    }
    if (this.bound !== b) return;
    this.post({
      type: "result",
      requestId,
      verified: { error, outcome, timeBefore, timeAfter: finite(v.currentTime), waitedMs: Math.round(performance.now() - started), activation },
    });
  }
}

// Injected again on every Scan: the first injection in this frame stays, later ones reuse it.
const holder = globalThis as unknown as { __mydubbProto?: ProbeApi };
holder.__mydubbProto ??= new Probe();
