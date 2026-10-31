// Sync with video (story 4): the coordinator of one playback session. It lives in the offscreen
// document next to the session's <audio>, so it keeps working when the side panel closes, and it
// drives the Udemy video only through operations the tab's content script runs on the video it
// identified (content/sync.ts). Kept free of Chrome globals: the audio, the page and timers come in
// through SyncDeps.
//
// The audio is the clock and always plays at 1x (the speed is in the MP3); the video runs at
// R = (V1 - V0) / D and follows V = V0 + A x R (shared/sync.ts).
//
// - Off by default. Turning it on is a user action: both pause, the video is bound, muted, set to R
//   and moved to the audio's position; nothing starts until the user presses Play.
// - Every activation has its own syncId and every operation a command id: replies for another
//   activation or a command already given up are dropped, and a newer user action (`action`)
//   makes every older async step stop where it is. Echoes of MyDubb's own operations are told
//   apart by the content script (it knows what it just did), so a user seek on the video moves
//   only the audio and never comes back as another video seek.
// - The user's intent (paused / playing) is kept apart from buffering: when one side waits for
//   data the other is held, and only an intent to play still in force resumes it.
// - Drift is measured in MP3 seconds: d = (V - V0) / R - A, V read by the content script when it
//   answers, A read here when the answer arrives (the message delay, a few ms, adds R x delay of
//   error). Checked once per second while both play; |d| <= 0.3 s is left alone (seeking the video
//   is a visible jump and may rebuffer; the timing itself is only estimated to a few tenths of a
//   second), a larger d seen twice in a row is corrected by seeking the video (never by changing
//   the audio's rate), at most once per 3 s and 3 times per 30 s; the next one pauses both and
//   says so. A lecture tab in the background is not counted against that limit, and coming back
//   to it re-aligns at once.
// - The video's rate is kept by the content script (content/sync.ts): R set again, a bounded
//   number of times, when the page puts its own speed back while the video settles;
//   "rate-not-held" when that does not hold, "rate-changed" for a change while it plays steadily.
//   Both end Sync. Nothing here sets the rate.
// - Diagnostics: a short trace (numbers, op and event names, the activation's id; nothing about
//   the job, the account or the lecture) of the last steps, for the inspection hook and the
//   offscreen console (console.debug), to tell on a real site what changed the rate and when.

import type { VideoCommand, VideoEventName, VideoOp, VideoOpError, VideoReply, VideoSample } from "../shared/playback";
import {
  audioTime,
  syncMapping,
  videoTime,
  type SyncMapping,
  type SyncNotice,
  type SyncSource,
  type SyncStatus,
  type SyncView,
} from "../shared/sync";
import type { AudioLike } from "./hub";

export const DRIFT_CHECK_MS = 1000;
export const DRIFT_THRESHOLD_SECONDS = 0.3;
export const DRIFT_CONFIRMATIONS = 2;
export const CORRECTION_COOLDOWN_MS = 3000;
export const CORRECTION_WINDOW_MS = 30_000;
export const MAX_CORRECTIONS = 3;
const MAX_MISSED_SAMPLES = 3;
// A video position this close outside V0..V1 still counts as inside (rounding of seeks).
const RANGE_EPSILON_SECONDS = 0.05;
// Play this close to the end of the MP3 starts the span again from the beginning.
const END_EPSILON_SECONDS = 0.05;

export const VIDEO_TIMEOUTS_MS: Record<VideoOp["op"], number> = {
  attach: 5000,
  seek: 10_000,
  play: 10_000,
  pause: 3000,
  position: 3000,
  release: 0,
};

export interface SyncDeps {
  /** Posts to the tab's linked page; false when no page is linked. */
  post(message: VideoCommand): boolean;
  linked(): boolean;
  randomId(): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** The view changed. */
  changed(): void;
  /** The audio is about to start: every other tab's session is paused first (one MyDubb audio). */
  claim(): void;
  /** Diagnostics only (the offscreen console). */
  log?(entry: SyncTraceEntry): void;
}

/** One step of the diagnostics trace. */
export interface SyncTraceEntry {
  /** deps.now() */
  t: number;
  /** "enable", "op:seek", "reply:play", "event:rate-restored", "off:rate-not-held"... */
  step: string;
  /** The first 8 characters of the activation's id. */
  sync: string | null;
  cmd: number | null;
  /** The user-action generation. */
  action: number;
  /** R, when there is a mapping. */
  expectedRate: number | null;
  /** The video's playbackRate in the reply or event, when there is one. */
  videoRate: number | null;
  ok?: boolean;
  error?: string | null;
}

export const TRACE_LENGTH = 60;

type Reply = Pick<VideoReply, "ok" | "error" | "video"> | { ok: false; error: "timeout" | "no-page"; video: null };

/** Measured drift, for the browser tests' inspection hook. */
export interface DriftStats {
  samples: number;
  corrections: number;
  maxAbsDrift: number;
  lastDrift: number | null;
}

function noticeFor(error: VideoOpError | "timeout" | "no-page" | null): SyncNotice {
  switch (error) {
    case "no-video":
    case "range-outside-video":
    case "rate-unsupported":
      return error;
    case "not-ready":
      return "video-not-ready";
    case "play-blocked":
      return "video-play-blocked";
    case "play-failed":
    case "superseded":
      return "video-play-failed";
    case "not-attached":
      return "video-replaced";
    default:
      return "no-response";
  }
}

export class SyncController {
  private state: "off" | "starting" | "on" = "off";
  private syncId: string | null = null;
  private nextCmd = 1;
  private readonly pending = new Map<number, { op: VideoOp["op"]; resolve(reply: Reply): void; timer: number }>();
  private intent: "paused" | "playing" = "paused";
  private phase: "idle" | "aligning" | "playing" | "buffering" = "idle";
  private buffering: "audio" | "video" | null = null;
  // Bumped by every user action and by turning off: an older async step stops where it is.
  private action = 0;
  // What MyDubb last asked of the audio. A media event that agrees with it, or that the element's
  // state has already overtaken (a late "pause" after a newer play), is not an outside action; this
  // holds whatever the order and timing of the events, across turning Sync off and on.
  private audioWanted: "paused" | "playing" = "paused";
  private atEnd = false;
  private notice: SyncNotice | null = null;
  private confirmed = false;
  private tickTimer: number | null = null;
  private over = 0;
  private missed = 0;
  private lastCorrection = Number.NEGATIVE_INFINITY;
  private corrections: number[] = [];
  // The browser paused the video of a background tab while the audio went on.
  private realignOnVisible = false;
  readonly stats: DriftStats = { samples: 0, corrections: 0, maxAbsDrift: 0, lastDrift: null };
  readonly trace: SyncTraceEntry[] = [];

  constructor(
    private readonly source: SyncSource | null,
    private readonly audio: AudioLike,
    private readonly deps: SyncDeps,
  ) {}

  /** Sync is on (or being turned on): playback commands go through it. */
  get active(): boolean {
    return this.state !== "off";
  }

  private mapping(): ReturnType<typeof syncMapping> {
    const d = this.audio.duration;
    return syncMapping(this.source, Number.isFinite(d) && d > 0 ? d : null);
  }

  view(): SyncView {
    const result = this.mapping();
    const m = result.ok ? result.mapping : null;
    let status: SyncStatus;
    if (this.state === "starting") status = "starting";
    else if (this.state === "on") {
      status =
        this.phase === "buffering" || this.phase === "aligning"
          ? "buffering"
          : this.intent === "playing"
            ? "playing"
            : "paused";
    } else if (!result.ok) status = "unavailable";
    else status = this.deps.linked() ? "off" : "unavailable";
    return {
      status,
      unavailable: status !== "unavailable" ? null : result.ok ? "not-linked" : result.reason,
      start: m?.start ?? null,
      end: m?.end ?? null,
      duration: m?.duration ?? null,
      rate: m?.rate ?? null,
      confirmed: this.confirmed,
      notice: this.notice,
    };
  }

  // ---- Turning it on and off -----------------------------------------------------------------

  async enable(): Promise<void> {
    if (this.state !== "off") return;
    const result = this.mapping();
    if (!result.ok) return this.deps.changed();
    if (!this.deps.linked()) return this.setNotice("not-linked");
    const m = result.mapping;
    const action = ++this.action;
    this.state = "starting";
    this.syncId = this.deps.randomId();
    this.intent = "paused";
    this.phase = "idle";
    this.notice = null;
    this.resetDrift();
    this.pauseAudio();
    this.record("enable");
    this.deps.changed();
    const a = Math.min(m.duration, Math.max(0, this.audio.currentTime));
    const reply = await this.video({ op: "attach", start: m.start, end: m.end, rate: m.rate, time: videoTime(m, a) });
    if (action !== this.action || this.state !== "starting") return;
    if (!reply.ok) return this.finish(noticeFor(reply.error));
    this.state = "on";
    this.confirmed = true;
    this.atEnd = a >= m.duration - END_EPSILON_SECONDS;
    this.deps.changed();
  }

  /** Off: both paused; the video gets back what MyDubb changed. */
  disable(notice: SyncNotice | null = null): void {
    this.finish(notice);
  }

  private finish(notice: SyncNotice | null): void {
    if (this.state === "off") return;
    this.record(`off:${notice ?? "user"}`);
    this.action += 1;
    this.pauseAudio();
    this.stopTicks();
    const syncId = this.syncId;
    if (syncId) this.deps.post({ type: "video", syncId, cmdId: this.nextCmd++, op: "release" });
    this.dropPending();
    this.state = "off";
    this.syncId = null;
    this.intent = "paused";
    this.phase = "idle";
    this.buffering = null;
    this.realignOnVisible = false;
    this.notice = notice;
    this.deps.changed();
  }

  /** The session ends (or its page went away): stop without waiting for anything. */
  dispose(): void {
    if (this.state !== "off") {
      const syncId = this.syncId;
      // Still linked (account change, another result): the page restores its video now.
      if (syncId) this.deps.post({ type: "video", syncId, cmdId: this.nextCmd++, op: "release" });
    }
    this.action += 1;
    this.stopTicks();
    this.dropPending();
    this.state = "off";
    this.syncId = null;
  }

  // ---- Commands from the panel and the floating player ----------------------------------------

  async play(): Promise<void> {
    if (this.state !== "on") return;
    const action = ++this.action;
    this.notice = null;
    this.resetDrift();
    this.intent = "playing";
    if (this.atEnd || this.audio.ended) this.audio.currentTime = 0;
    this.atEnd = false;
    await this.alignAndPlay(action);
  }

  pause(notice: SyncNotice | null = null): void {
    if (this.state === "starting") return this.finish(notice);
    if (this.state !== "on") return;
    this.action += 1;
    this.holdBoth(notice);
  }

  /** A position in the MP3 (seek bar, ±5 s): both move there. */
  async seek(target: number): Promise<void> {
    if (this.state !== "on") return;
    const result = this.mapping();
    if (!result.ok) return this.finish(null);
    const m = result.mapping;
    const action = ++this.action;
    const a = Math.min(m.duration, Math.max(0, target));
    this.notice = null;
    this.resetDrift();
    this.audio.currentTime = a;
    this.atEnd = a >= m.duration - END_EPSILON_SECONDS;
    if (this.intent === "playing" && this.atEnd) return this.reachedEnd();
    if (this.intent === "playing") return this.alignAndPlay(action);
    this.deps.changed();
    const reply = await this.video({ op: "seek", time: videoTime(m, a) });
    if (this.still(action) && !reply.ok) this.holdBoth(noticeFor(reply.error));
  }

  // ---- Playing both ----------------------------------------------------------------------------

  private still(action: number): boolean {
    return action === this.action && this.state === "on";
  }

  /** Holds the audio, moves the video to it, starts the video, then the audio where the video is. */
  private async alignAndPlay(action: number): Promise<void> {
    const result = this.mapping();
    if (!result.ok) return this.finish(null);
    const m = result.mapping;
    this.phase = "aligning";
    this.buffering = null;
    this.pauseAudio();
    this.stopTicks();
    this.deps.changed();
    const seek = await this.video({ op: "seek", time: videoTime(m, this.audio.currentTime) });
    if (!this.still(action)) return;
    if (!seek.ok) return this.holdBoth(noticeFor(seek.error));
    const started = await this.video({ op: "play" });
    if (!this.still(action)) return;
    if (!started.ok) return this.holdBoth(noticeFor(started.error));
    // The video may have moved on while it started: the audio starts where the video is.
    if (started.video) this.audio.currentTime = this.clampAudio(m, audioTime(m, started.video.currentTime));
    const problem = await this.playAudio();
    if (!this.still(action)) return;
    if (problem) return this.holdBoth(problem);
    this.phase = "playing";
    this.startTicks();
    this.deps.changed();
  }

  /** Both paused, intent paused (Sync stays on). */
  private holdBoth(notice: SyncNotice | null): void {
    this.intent = "paused";
    this.phase = "idle";
    this.buffering = null;
    this.pauseAudio();
    this.stopTicks();
    void this.video({ op: "pause" });
    if (notice !== null) this.notice = notice;
    this.deps.changed();
  }

  private reachedEnd(): void {
    this.action += 1;
    this.atEnd = true;
    this.holdBoth("ended");
  }

  private clampAudio(m: SyncMapping, a: number): number {
    return Math.min(m.duration, Math.max(0, a));
  }

  private inRange(m: SyncMapping, v: number): boolean {
    return v >= m.start - RANGE_EPSILON_SECONDS && v <= m.end + RANGE_EPSILON_SECONDS;
  }

  private pauseAudio(): void {
    this.audioWanted = "paused";
    if (!this.audio.paused) this.audio.pause();
  }

  private async playAudio(): Promise<SyncNotice | null> {
    this.audioWanted = "playing";
    if (!this.audio.paused) return null;
    // One MyDubb audio at a time: the hub pauses every other tab's session (and synced video) first.
    this.deps.claim();
    try {
      await this.audio.play();
      return null;
    } catch (error) {
      const name = typeof error === "object" && error !== null ? String((error as { name?: unknown }).name) : "";
      // AbortError: a newer action paused it first; that action decides.
      if (name === "AbortError") return null;
      this.audioWanted = "paused";
      return name === "NotAllowedError" ? "audio-play-blocked" : "audio-play-failed";
    }
  }

  // ---- Events --------------------------------------------------------------------------------

  /** An event of the session's <audio> element. */
  onAudioEvent(name: string): void {
    if (this.state === "off") return;
    switch (name) {
      case "pause":
        // Asked for by MyDubb, or already overtaken by a newer play: nothing happened from outside.
        if (this.audioWanted === "paused" || !this.audio.paused || this.state !== "on") return;
        // Paused from outside MyDubb's controls (e.g. Chrome's media controls): the video too.
        this.action += 1;
        this.holdBoth(null);
        return;
      case "play":
        if (this.audioWanted === "playing" || this.audio.paused) return;
        // Started from outside while Sync is being set up: both stay paused until it is ready.
        if (this.state === "starting") return this.pauseAudio();
        // From outside (media controls): the same aligned start as MyDubb's Play.
        void this.play();
        return;
    }
    if (this.state !== "on") return;
    switch (name) {
      case "waiting":
        if (this.intent === "playing" && this.phase === "playing") {
          this.phase = "buffering";
          this.buffering = "audio";
          this.stopTicks();
          void this.video({ op: "pause" });
          this.deps.changed();
        }
        return;
      case "playing":
        if (this.intent === "playing" && this.buffering === "audio") void this.alignAndPlay(++this.action);
        return;
      case "ended":
        this.reachedEnd();
        return;
      case "error":
        this.finish("audio-error");
    }
  }

  /** A reply of the content script to one of this activation's operations. */
  onVideoReply(reply: VideoReply): void {
    if (reply.syncId !== this.syncId) return;
    const waiting = this.pending.get(reply.cmdId);
    if (!waiting) return;
    if (waiting.op !== "position") {
      this.record(`reply:${waiting.op}`, { cmd: reply.cmdId, videoRate: reply.video?.rate ?? null, ok: reply.ok, error: reply.error });
    }
    this.pending.delete(reply.cmdId);
    this.deps.clearTimeout(waiting.timer);
    waiting.resolve(reply);
  }

  /** Something happened to the synced video that MyDubb did not ask for. */
  onVideoEvent(syncId: string, event: VideoEventName, sample: VideoSample): void {
    if (syncId !== this.syncId) return;
    this.record(`event:${event}`, { videoRate: sample.rate });
    if (this.state === "starting") {
      // Only what makes the binding itself void matters before it is answered.
      if (event === "replaced") this.finish("video-replaced");
      else if (event === "error") this.finish("video-error");
      else if (event === "rate-changed" || event === "rate-not-held") this.finish(event);
      return;
    }
    if (this.state !== "on") return;
    const result = this.mapping();
    if (!result.ok) return this.finish(null);
    const m = result.mapping;
    switch (event) {
      case "user-play":
        void this.followVideoPlay(m, sample);
        return;
      case "user-pause":
        // A background tab's video paused by the browser: the audio goes on, realigned on return.
        if (sample.hidden && this.intent === "playing") {
          this.realignOnVisible = true;
          return;
        }
        if (this.intent === "playing" || this.phase !== "idle") {
          this.action += 1;
          this.intent = "paused";
          this.phase = "idle";
          this.buffering = null;
          this.pauseAudio();
          this.stopTicks();
          this.deps.changed();
        }
        return;
      case "user-seek": {
        if (!this.inRange(m, sample.currentTime)) return this.finish("seek-outside");
        this.action += 1;
        this.resetDrift();
        const a = this.clampAudio(m, audioTime(m, sample.currentTime));
        this.audio.currentTime = a;
        this.atEnd = a >= m.duration - END_EPSILON_SECONDS;
        this.deps.changed();
        return;
      }
      case "waiting":
        if (this.intent === "playing" && this.phase === "playing") {
          this.phase = "buffering";
          this.buffering = "video";
          this.pauseAudio();
          this.stopTicks();
          this.deps.changed();
        }
        return;
      case "playing":
        if (this.intent === "playing" && this.buffering === "video") void this.followVideoPlay(m, sample, true);
        return;
      case "rate-changed":
      case "rate-not-held":
        return this.finish(event);
      case "rate-restored":
        // The content script set R again; only the trace keeps it.
        return;
      case "unmuted":
        this.notice = "unmuted";
        this.deps.changed();
        return;
      case "reached-end":
      case "ended":
        return this.reachedEnd();
      case "error":
        return this.finish("video-error");
      case "replaced":
        return this.finish("video-replaced");
      case "visible":
        if (this.intent !== "playing" || this.phase === "aligning") return;
        if (this.realignOnVisible) {
          this.realignOnVisible = false;
          void this.alignAndPlay(++this.action);
        } else if (this.phase === "playing") {
          void this.sample(true);
        }
    }
  }

  /** The video plays (started on the video, or after buffering): the audio joins where it is. */
  private async followVideoPlay(m: SyncMapping, sample: VideoSample, afterBuffering = false): Promise<void> {
    if (!afterBuffering && this.intent === "playing" && this.phase === "playing") return;
    if (!this.inRange(m, sample.currentTime)) return this.finish("seek-outside");
    const action = ++this.action;
    this.intent = "playing";
    if (!afterBuffering) this.notice = null;
    this.resetDrift();
    this.buffering = null;
    this.atEnd = false;
    this.audio.currentTime = this.clampAudio(m, audioTime(m, sample.currentTime));
    const problem = await this.playAudio();
    if (!this.still(action)) return;
    if (problem) return this.holdBoth(problem);
    this.phase = "playing";
    this.startTicks();
    this.deps.changed();
  }

  // ---- Drift ---------------------------------------------------------------------------------

  private resetDrift(): void {
    this.over = 0;
    this.missed = 0;
    this.corrections = [];
    this.lastCorrection = Number.NEGATIVE_INFINITY;
  }

  private startTicks(): void {
    this.stopTicks();
    this.tickTimer = this.deps.setTimeout(() => {
      this.tickTimer = null;
      void this.sample();
    }, DRIFT_CHECK_MS);
  }

  private stopTicks(): void {
    if (this.tickTimer !== null) this.deps.clearTimeout(this.tickTimer);
    this.tickTimer = null;
  }

  /** One drift check; `now`: the tab came back to the foreground (corrected at once, no cooldown, not counted). */
  private async sample(now = false): Promise<void> {
    if (this.state !== "on" || this.intent !== "playing" || this.phase !== "playing") return;
    this.stopTicks();
    const action = this.action;
    const reply = await this.video({ op: "position" });
    if (!this.still(action) || this.phase !== "playing") return;
    const result = this.mapping();
    if (!result.ok) return this.finish(null);
    const m = result.mapping;
    if (!reply.ok || !reply.video) {
      this.missed += 1;
      if (this.missed >= MAX_MISSED_SAMPLES) return this.holdBoth("no-response");
      return this.startTicks();
    }
    this.missed = 0;
    const v = reply.video;
    // Paused or buffering: its event decides what happens.
    if (v.paused || v.waiting) return this.startTicks();
    const drift = audioTime(m, v.currentTime) - this.audio.currentTime;
    this.stats.samples += 1;
    this.stats.lastDrift = drift;
    this.stats.maxAbsDrift = Math.max(this.stats.maxAbsDrift, Math.abs(drift));
    if (Math.abs(drift) <= DRIFT_THRESHOLD_SECONDS) {
      this.over = 0;
      return this.startTicks();
    }
    this.over += 1;
    const time = this.deps.now();
    if (now || (this.over >= DRIFT_CONFIRMATIONS && time - this.lastCorrection >= CORRECTION_COOLDOWN_MS)) {
      if (!now && !v.hidden) {
        this.corrections = this.corrections.filter((t) => time - t < CORRECTION_WINDOW_MS);
        if (this.corrections.length >= MAX_CORRECTIONS) return this.holdBoth("unstable");
        this.corrections.push(time);
      }
      this.lastCorrection = time;
      this.over = 0;
      this.stats.corrections += 1;
      const seek = await this.video({ op: "seek", time: videoTime(m, this.audio.currentTime) });
      if (!this.still(action)) return;
      if (!seek.ok) return this.holdBoth(noticeFor(seek.error));
    }
    this.startTicks();
  }

  // ---- Operations on the video ---------------------------------------------------------------

  private video(op: VideoOp): Promise<Reply> {
    const syncId = this.syncId;
    if (!syncId) return Promise.resolve({ ok: false, error: "no-page", video: null });
    const cmdId = this.nextCmd++;
    if (op.op !== "position") this.record(`op:${op.op}`, { cmd: cmdId });
    return new Promise<Reply>((resolve) => {
      const timer = this.deps.setTimeout(() => {
        if (this.pending.delete(cmdId)) {
          this.record(`timeout:${op.op}`, { cmd: cmdId });
          resolve({ ok: false, error: "timeout", video: null });
        }
      }, VIDEO_TIMEOUTS_MS[op.op]);
      this.pending.set(cmdId, { op: op.op, resolve, timer });
      if (!this.deps.post({ type: "video", syncId, cmdId, ...op })) {
        this.pending.delete(cmdId);
        this.deps.clearTimeout(timer);
        resolve({ ok: false, error: "no-page", video: null });
      }
    });
  }

  private dropPending(): void {
    for (const [, waiting] of this.pending) {
      this.deps.clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, error: "timeout", video: null });
    }
    this.pending.clear();
  }

  private record(step: string, extra: Partial<SyncTraceEntry> = {}): void {
    const result = this.mapping();
    const entry: SyncTraceEntry = {
      t: this.deps.now(),
      step,
      sync: this.syncId?.slice(0, 8) ?? null,
      cmd: null,
      action: this.action,
      expectedRate: result.ok ? result.mapping.rate : null,
      videoRate: null,
      ...extra,
    };
    this.trace.push(entry);
    if (this.trace.length > TRACE_LENGTH) this.trace.splice(0, this.trace.length - TRACE_LENGTH);
    this.deps.log?.(entry);
  }

  private setNotice(notice: SyncNotice): void {
    this.notice = notice;
    this.deps.changed();
  }
}
