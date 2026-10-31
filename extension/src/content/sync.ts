// Sync with video (story 4), the page's half: runs the offscreen coordinator's operations
// (offscreen/sync.ts) on the one <video> the content script identified, and reports what the video
// does that MyDubb did not ask for. It never sees the token, the job or the audio.
//
// Telling MyDubb's own operations apart from the user's (or the site's): before each operation it
// records what it expects (a pause, a play, a seek to a target, the rate it set), and an event that
// matches is that operation's echo; anything else is reported as "user-*". event.isTrusted is not
// used: media events are never trusted-only, whoever caused them.
//
// Ownership: at attach it notes the element's muted state and rate. It mutes only an unmuted video
// and gives back only what still holds MyDubb's value when it lets go (a user's later unmute or
// rate change is theirs to keep), and only on the same element still showing the same media (not
// on another lecture's video, even in a reused element). Volume is never touched.

import type { PageToPlayer, VideoCommand, VideoEventName, VideoOpError, VideoSample } from "../shared/playback";
import { seekBounds } from "./video";

const RANGE_EPSILON_SECONDS = 0.05;
const RATE_EPSILON = 1e-3;
// A seeked event this close to the target is the echo of MyDubb's seek.
const SEEK_MATCH_SECONDS = 0.5;
// The end of the span: the video pauses there (checked on timeupdate, about 4 per second).
const END_MARGIN_SECONDS = 0.005;

export interface SyncEnv {
  doc: Document;
  /** The video the content script identified for the lecture now shown. */
  current(): HTMLVideoElement | null;
  send(message: PageToPlayer): void;
}

interface Bound {
  syncId: string;
  video: HTMLVideoElement;
  src: string;
  start: number;
  end: number;
  rate: number;
  rateBefore: number;
  rateOwned: boolean;
  mutedByUs: boolean;
  expectPause: number;
  expectPlay: number;
  seek: { cmdId: number; target: number } | null;
  events: AbortController;
}

export class VideoSync {
  private bound: Bound | null = null;

  constructor(private readonly env: SyncEnv) {}

  get attached(): HTMLVideoElement | null {
    return this.bound?.video ?? null;
  }

  handle(message: VideoCommand): void {
    if (message.op === "attach") return this.attach(message);
    const b = this.bound;
    if (!b || b.syncId !== message.syncId) {
      if (message.op !== "release") this.reply(message, false, "not-attached");
      return;
    }
    switch (message.op) {
      case "release":
        return this.release();
      case "seek":
        return this.seek(b, message.cmdId, message.time);
      case "play":
        return void this.play(b, message);
      case "pause":
        this.pauseOwn(b);
        return this.reply(message, true);
      case "position":
        return this.reply(message, true);
    }
  }

  /** The identified video changed or left the page: the binding ends (MyDubb pauses its audio). */
  check(): void {
    const b = this.bound;
    if (!b) return;
    if (this.env.current() !== b.video || !b.video.isConnected) {
      this.emit(b, "replaced");
      this.release();
    }
  }

  /** Lets go of the video: paused, and what MyDubb changed given back where it still applies. */
  release(): void {
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    b.events.abort();
    const v = b.video;
    if (v.currentSrc !== b.src) return;
    if (!v.paused) v.pause();
    if (b.mutedByUs && v.muted) v.muted = false;
    if (b.rateOwned && Math.abs(v.playbackRate - b.rate) < RATE_EPSILON) v.playbackRate = b.rateBefore;
  }

  private attach(message: Extract<VideoCommand, { op: "attach" }>): void {
    this.release();
    const v = this.env.current();
    if (!v) return this.reply(message, false, "no-video");
    if (v.readyState < HTMLMediaElement.HAVE_METADATA || !Number.isFinite(v.duration)) {
      return this.reply(message, false, "not-ready");
    }
    const bounds = seekBounds(v);
    if (!bounds || message.start < bounds[0] - RANGE_EPSILON_SECONDS || message.end > bounds[1] + RANGE_EPSILON_SECONDS) {
      return this.reply(message, false, "range-outside-video");
    }
    const b: Bound = {
      syncId: message.syncId,
      video: v,
      src: v.currentSrc,
      start: message.start,
      end: message.end,
      rate: message.rate,
      rateBefore: v.playbackRate,
      rateOwned: false,
      mutedByUs: false,
      expectPause: 0,
      expectPlay: 0,
      seek: null,
      events: new AbortController(),
    };
    this.bound = b;
    this.listen(b);
    this.pauseOwn(b);
    try {
      v.playbackRate = message.rate;
    } catch {
      // NotSupportedError: outside what this browser plays. Nothing is clamped.
    }
    if (Math.abs(v.playbackRate - message.rate) > RATE_EPSILON) {
      this.release();
      try {
        v.playbackRate = b.rateBefore;
      } catch {
        // unchanged
      }
      return this.reply(message, false, "rate-unsupported");
    }
    b.rateOwned = Math.abs(b.rateBefore - message.rate) > RATE_EPSILON;
    if (!v.muted) {
      v.muted = true;
      b.mutedByUs = true;
    }
    this.seek(b, message.cmdId, message.time, message.syncId);
  }

  private listen(b: Bound): void {
    const v = b.video;
    const options = { signal: b.events.signal };
    const on = (name: string, handler: () => void) => v.addEventListener(name, handler, options);
    on("play", () => {
      if (b.expectPlay > 0) b.expectPlay -= 1;
      else this.emit(b, "user-play");
    });
    on("pause", () => {
      if (b.expectPause > 0) b.expectPause -= 1;
      // The pause before "ended" is reported as the end.
      else if (!v.ended) this.emit(b, "user-pause");
    });
    on("seeked", () => {
      const pending = b.seek;
      if (pending && Math.abs(v.currentTime - pending.target) <= SEEK_MATCH_SECONDS) {
        b.seek = null;
        this.send({ type: "video-reply", syncId: b.syncId, cmdId: pending.cmdId, ok: true, error: null, video: this.sample(v) });
        return;
      }
      if (pending) {
        b.seek = null;
        this.send({ type: "video-reply", syncId: b.syncId, cmdId: pending.cmdId, ok: false, error: "superseded", video: this.sample(v) });
      }
      this.emit(b, "user-seek");
    });
    on("waiting", () => {
      if (!v.paused) this.emit(b, "waiting");
    });
    on("playing", () => this.emit(b, "playing"));
    on("ratechange", () => {
      if (Math.abs(v.playbackRate - b.rate) <= RATE_EPSILON) return;
      // Changed by the user or the site: MyDubb no longer owns it and never sets it again.
      b.rateOwned = false;
      this.emit(b, "rate-changed");
    });
    on("volumechange", () => {
      if (b.mutedByUs && !v.muted) {
        b.mutedByUs = false;
        this.emit(b, "unmuted");
      }
    });
    on("timeupdate", () => {
      if (!v.paused && v.currentTime >= b.end - END_MARGIN_SECONDS) {
        this.pauseOwn(b);
        this.emit(b, "reached-end");
      }
    });
    on("ended", () => this.emit(b, "ended"));
    on("error", () => this.emit(b, "error"));
    on("emptied", () => {
      // Another source in the same element (e.g. the next lecture): not the video MyDubb bound.
      this.emit(b, "replaced");
      this.release();
    });
    this.env.doc.addEventListener(
      "visibilitychange",
      () => {
        if (this.env.doc.visibilityState === "visible") this.emit(b, "visible");
      },
      options,
    );
  }

  private pauseOwn(b: Bound): void {
    if (b.video.paused) return;
    b.expectPause += 1;
    b.video.pause();
  }

  private seek(b: Bound, cmdId: number, time: number, syncId = b.syncId): void {
    const v = b.video;
    if (b.seek) {
      this.send({ type: "video-reply", syncId, cmdId: b.seek.cmdId, ok: false, error: "superseded", video: this.sample(v) });
      b.seek = null;
    }
    if (time < b.start - RANGE_EPSILON_SECONDS || time > b.end + RANGE_EPSILON_SECONDS) {
      return this.send({ type: "video-reply", syncId, cmdId, ok: false, error: "range-outside-video", video: this.sample(v) });
    }
    if (Math.abs(v.currentTime - time) < 0.01 && !v.seeking) {
      return this.send({ type: "video-reply", syncId, cmdId, ok: true, error: null, video: this.sample(v) });
    }
    b.seek = { cmdId, target: time };
    v.currentTime = time;
  }

  private async play(b: Bound, message: VideoCommand): Promise<void> {
    const v = b.video;
    if (!v.paused) return this.reply(message, true);
    b.expectPlay += 1;
    try {
      await v.play();
      if (this.bound === b) this.reply(message, true);
    } catch (error) {
      b.expectPlay = 0;
      const name = typeof error === "object" && error !== null ? String((error as { name?: unknown }).name) : "";
      if (this.bound === b) this.reply(message, false, name === "NotAllowedError" ? "play-blocked" : "play-failed");
    }
  }

  private sample(v: HTMLVideoElement): VideoSample {
    return {
      currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
      paused: v.paused,
      waiting: !v.paused && v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      hidden: this.env.doc.visibilityState === "hidden",
    };
  }

  private emit(b: Bound, event: VideoEventName): void {
    this.send({ type: "video-event", syncId: b.syncId, event, video: this.sample(b.video) });
  }

  private reply(message: VideoCommand, ok: boolean, error: VideoOpError | null = null): void {
    const v = this.bound?.video ?? this.env.current();
    this.send({
      type: "video-reply",
      syncId: message.syncId,
      cmdId: message.cmdId,
      ok,
      error,
      video: v ? this.sample(v) : null,
    });
  }

  private send(message: PageToPlayer): void {
    this.env.send(message);
  }
}
