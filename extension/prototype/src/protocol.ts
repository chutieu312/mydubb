// Sync prototype (Story 2, prototype phase): the messages between the lab page (the prototype's side
// panel, which holds the local test audio and the real SyncController) and the probe injected into
// the page's frames (which runs the real content-side VideoSync on the video it identified).
// Development-only: nothing here is part of the MyDubb extension build (dist/).

import type { VideoCommand, VideoEvent, VideoReply } from "../../src/shared/playback";
import type { VideoState } from "../../src/shared/messages";

export const PROBE_PORT = "mydubb-proto-probe";

/**
 * How the media element was chosen: pickVideo (src/content/video.ts) over the candidates, minus its
 * "the only one playing" rule, which on other sites picks a muted autoplaying preview.
 */
export type PickReason = "user-played" | "bound" | "only-visible";

/** One <video> of a frame, as the probe sees it (no URL, no title: only what the report needs). */
export interface VideoInfo {
  id: number;
  rendered: boolean;
  width: number;
  height: number;
  paused: boolean;
  muted: boolean;
  autoplay: boolean;
  loop: boolean;
  currentTime: number;
  duration: number | null;
  readyState: number;
  rate: number;
  /** "blob" usually means Media Source Extensions (HLS/DASH in JS); "none": no source yet. */
  source: "blob" | "http" | "https" | "data" | "none" | "other";
  /** Started since the probe was injected (the user, or the page). */
  playedSinceScan: boolean;
  /** Started with sound on, or with the user's input on the page: taken as the user's choice. */
  userStarted: boolean;
  /** Muted and looping, never started by the user: a preview or background, not a candidate. */
  decorative: boolean;
}

export interface FrameScan {
  top: boolean;
  origin: string;
  videos: VideoInfo[];
  /** Videos only reachable through an open shadow root (document.querySelectorAll does not see them). */
  shadowVideos: number;
  audios: number;
  /** navigator.userActivation of the frame: the user has interacted with it (sticky) / just now (transient). */
  userActivation: { hasBeenActive: boolean; isActive: boolean } | null;
  pick: { kind: "none" } | { kind: "ambiguous"; candidates: number } | { kind: "video"; id: number; reason: PickReason };
  /** The frame's own child frames: their origin (null for about:blank/srcdoc) and whether they are drawn. */
  iframes: { origin: string | null; rendered: boolean; width: number; height: number }[];
}

export type LabToProbe =
  | { type: "bind"; videoId: number }
  | { type: "cmd"; requestId: number; command: "play" | "pause" | "seek-by"; delta?: number }
  | { type: "sample"; requestId: number }
  | VideoCommand;

/** How a Play/Pause from MyDubb turned out, checked on the element afterwards (not only the promise). */
export interface Verified {
  /** The promise/command result. */
  error: string | null;
  /** What the element did afterwards. */
  outcome: "playing" | "paused" | "not-advancing" | "still-paused" | "still-playing";
  timeBefore: number;
  timeAfter: number;
  waitedMs: number;
  /** The frame's navigator.userActivation when the command arrived (Chrome's autoplay policy reads it). */
  activation: { hasBeenActive: boolean; isActive: boolean } | null;
}

export interface ProbeSample {
  requestId: number;
  currentTime: number;
  paused: boolean;
  waiting: boolean;
  rate: number;
  hidden: boolean;
}

/** Why the probe let go of the video it was bound to. */
export type LostReason = "replaced" | "removed" | "source-changed" | "navigated" | "ambiguous";

export type ProbeToLab =
  | { type: "bound"; ok: true; videoId: number }
  | { type: "bound"; ok: false; error: "stale" | "no-video" }
  | { type: "state"; state: VideoState; rate: number; muted: boolean }
  | { type: "result"; requestId: number; verified: Verified }
  | { type: "sample"; sample: ProbeSample }
  | { type: "lost"; reason: LostReason }
  /** A URL change that did not end the binding (only the query or fragment changed): logged. */
  | { type: "url"; change: "query" | "hash" }
  | VideoReply
  | VideoEvent;

export type ProbeApi = { scan(): FrameScan };

export function sourceKind(src: string): VideoInfo["source"] {
  if (!src) return "none";
  const scheme = src.slice(0, src.indexOf(":") + 1);
  switch (scheme) {
    case "blob:":
      return "blob";
    case "http:":
      return "http";
    case "https:":
      return "https";
    case "data:":
      return "data";
    default:
      return "other";
  }
}
