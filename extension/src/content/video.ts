// Finds the lecture's <video> and drives it. Only play/pause and currentTime are touched; muted,
// volume and playbackRate are never written.

import type { CommandError, VideoState } from "../shared/messages";

export type VisibilityCheck = (video: HTMLVideoElement) => boolean;

export function isRenderedVideo(video: HTMLVideoElement): boolean {
  if (!video.isConnected) return false;
  const rect = video.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = video.ownerDocument.defaultView?.getComputedStyle(video);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

export type PickResult =
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: number }
  | { kind: "video"; video: HTMLVideoElement };

/**
 * Chooses the lecture video among rendered candidates. Never falls back to "the first one":
 * with several candidates it takes the one the user last started, the one already attached, or
 * the only one playing; otherwise it reports the ambiguity.
 */
export function pickVideo(
  all: Iterable<HTMLVideoElement>,
  previous: HTMLVideoElement | null,
  lastPlayed: HTMLVideoElement | null,
  isVisible: VisibilityCheck = isRenderedVideo,
): PickResult {
  const visible = [...all].filter(isVisible);
  if (visible.length === 0) return { kind: "none" };
  if (lastPlayed && visible.includes(lastPlayed)) return { kind: "video", video: lastPlayed };
  if (previous && visible.includes(previous)) return { kind: "video", video: previous };
  if (visible.length === 1) return { kind: "video", video: visible[0]! };
  const playing = visible.filter((v) => !v.paused && !v.ended);
  if (playing.length === 1) return { kind: "video", video: playing[0]! };
  return { kind: "ambiguous", candidates: visible.length };
}

/** The playable range: the seekable ranges' outer bounds, or [0, duration] once known. */
export function seekBounds(video: HTMLVideoElement): [number, number] | null {
  const ranges = video.seekable;
  if (ranges && ranges.length > 0) {
    const start = ranges.start(0);
    const end = ranges.end(ranges.length - 1);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return [start, end];
  }
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(video.duration)) {
    return [0, video.duration];
  }
  return null;
}

const MEDIA_ERRORS: Record<number, string> = {
  1: "Video loading was aborted.",
  2: "Network error while loading the video.",
  3: "The video could not be decoded.",
  4: "The video source is not supported.",
};

const STATE_EVENTS = [
  "play",
  "pause",
  "playing",
  "waiting",
  "stalled",
  "seeking",
  "seeked",
  "ended",
  "durationchange",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "progress",
  "emptied",
  "error",
] as const;

const TIMEUPDATE_INTERVAL_MS = 250;

/** Listens to one <video> element and reports its real state; detach() removes every listener. */
export class AttachedVideo {
  private readonly abort = new AbortController();
  private waiting = false;
  private lastTimeUpdate = 0;

  constructor(
    readonly video: HTMLVideoElement,
    readonly id: number,
    private readonly onChange: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    const options = { signal: this.abort.signal };
    for (const name of STATE_EVENTS) {
      video.addEventListener(name, () => this.handleEvent(name), options);
    }
    video.addEventListener("timeupdate", () => this.handleTimeUpdate(), options);
  }

  detach(): void {
    this.abort.abort();
  }

  private handleEvent(name: string): void {
    if (name === "waiting" || name === "stalled") this.waiting = true;
    if (name === "playing" || name === "canplay" || name === "seeked" || name === "pause") {
      this.waiting = false;
    }
    if (name === "emptied") this.waiting = false;
    this.onChange();
  }

  private handleTimeUpdate(): void {
    const t = this.now();
    if (t - this.lastTimeUpdate < TIMEUPDATE_INTERVAL_MS) return;
    this.lastTimeUpdate = t;
    this.onChange();
  }

  state(): VideoState {
    const v = this.video;
    const bounds = seekBounds(v);
    return {
      status: "ready",
      id: this.id,
      paused: v.paused,
      ended: v.ended,
      currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
      duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
      seekStart: bounds ? bounds[0] : null,
      seekEnd: bounds ? bounds[1] : null,
      readyState: v.readyState,
      waiting: this.waiting && !v.paused,
      error: v.error ? (MEDIA_ERRORS[v.error.code] ?? "The video reported an error.") : null,
    };
  }

  async play(): Promise<CommandError | null> {
    const v = this.video;
    if (v.error || (v.readyState === HTMLMediaElement.HAVE_NOTHING && v.networkState === HTMLMediaElement.NETWORK_NO_SOURCE)) {
      return "not-ready";
    }
    try {
      await v.play();
      return null;
    } catch (error) {
      // DOMException is not reliably `instanceof Error` across realms (page vs isolated world).
      const name = typeof error === "object" && error !== null ? String((error as { name?: unknown }).name) : "";
      if (name === "NotAllowedError") return "play-blocked";
      if (name === "AbortError") return "play-interrupted";
      return "play-failed";
    }
  }

  pause(): CommandError | null {
    this.video.pause();
    return null;
  }

  seekBy(delta: number): CommandError | null {
    const v = this.video;
    if (v.readyState < HTMLMediaElement.HAVE_METADATA) return "not-ready";
    const bounds = seekBounds(v);
    if (!bounds) return "not-seekable";
    const [start, end] = bounds;
    v.currentTime = Math.min(end, Math.max(start, v.currentTime + delta));
    return null;
  }
}
