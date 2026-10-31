import { beforeEach, describe, expect, it } from "vitest";

import type { VideoCommand, VideoEventName, VideoSample } from "../shared/playback";
import type { SyncSource } from "../shared/sync";
import type { AudioLike } from "./hub";
import { SyncController } from "./sync";

// Plain 00:00:10 -> 00:00:56 at 1.5x, MP3 30.563 s: R = 46 / 30.563.
const SOURCE: SyncSource = { mode: "plain", start: 10, end: 56, baseline: 46, speed: 1.5 };
const D = 30.563;
const R = 46 / D;
const V = (a: number) => 10 + a * R;

/**
 * A media element; play() can be made to fail. Its events fire at once, or (`deferred`) only when
 * the test delivers them, like a browser's queued media events.
 */
class FakeAudio extends EventTarget {
  deferred = false;
  private readonly queue: string[] = [];
  paused = true;
  ended = false;
  currentTime = 0;
  duration = D;
  readyState = 4;
  playbackRate = 1;
  playError: { name: string } | null = null;
  async play() {
    if (this.playError) throw this.playError;
    if (!this.paused) return;
    this.paused = false;
    this.emit("play");
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  fire(name: string) {
    this.dispatchEvent(new Event(name));
  }
  private emit(name: string) {
    if (this.deferred) this.queue.push(name);
    else this.dispatchEvent(new Event(name));
  }
  /** Delivers the queued events, in order. */
  deliver() {
    for (const name of this.queue.splice(0)) this.dispatchEvent(new Event(name));
  }
}

let clock: number;
let timers: { id: number; at: number; fn: () => void }[];
let audio: FakeAudio;
let posted: VideoCommand[];
let linked: boolean;
let changes: number;
let claims: number;
let c: SyncController;

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

/** Moves the clock on, running timers that fall due (and whatever they start). */
async function advance(ms: number) {
  const end = clock + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers[0];
    if (!next || next.at > end) break;
    timers.shift();
    clock = next.at;
    next.fn();
    await flush();
  }
  clock = end;
}

function make(source: SyncSource | null = SOURCE) {
  let id = 0;
  let timer = 0;
  audio = new FakeAudio();
  c = new SyncController(source, audio as unknown as AudioLike, {
    post: (m) => {
      if (!linked) return false;
      posted.push(structuredClone(m));
      return true;
    },
    linked: () => linked,
    randomId: () => `sync-${++id}`,
    now: () => clock,
    setTimeout: (fn, ms) => {
      timer += 1;
      timers.push({ id: timer, at: clock + ms, fn });
      return timer;
    },
    clearTimeout: (t) => {
      timers = timers.filter((x) => x.id !== t);
    },
    changed: () => void (changes += 1),
    claim: () => void (claims += 1),
  });
  for (const name of ["play", "pause", "waiting", "playing", "ended", "error"]) {
    audio.addEventListener(name, () => c.onAudioEvent(name));
  }
  return c;
}

const sample = (currentTime: number, extra: Partial<VideoSample> = {}): VideoSample => ({
  currentTime,
  paused: false,
  waiting: false,
  hidden: false,
  ...extra,
});
const last = () => posted.at(-1)!;
const ops = () => posted.map((m) => m.op);

async function reply(message: VideoCommand, ok = true, video: VideoSample | null = sample(0), error: string | null = null) {
  c.onVideoReply({ type: "video-reply", syncId: message.syncId, cmdId: message.cmdId, ok, error: error as never, video });
  await flush();
}

function event(name: VideoEventName, video: VideoSample, syncId = posted[0]!.syncId) {
  c.onVideoEvent(syncId, name, video);
}

/** Sync on (attach answered), both paused at A = `at`. */
async function on(at = 0) {
  audio.currentTime = at;
  void c.enable();
  await flush();
  await reply(last(), true, sample(V(at), { paused: true }));
  expect(c.view().status).toBe("paused");
}

/** Play from MyDubb: seek, play, audio; the video reports `videoAt` when it started. */
async function play(videoAt?: number) {
  void c.play();
  await flush();
  const seek = last();
  expect(seek.op).toBe("seek");
  await reply(seek, true, sample((seek as { time: number }).time, { paused: true }));
  const start = last();
  expect(start.op).toBe("play");
  await reply(start, true, sample(videoAt ?? (seek as { time: number }).time));
}

beforeEach(() => {
  clock = 1_000_000;
  timers = [];
  posted = [];
  linked = true;
  changes = 0;
  claims = 0;
  make();
});

describe("turning Sync on and off", () => {
  it("is off by default; on is a user action that pauses both, binds, mutes and positions, and plays nothing", async () => {
    expect(c.view()).toMatchObject({ status: "off", start: 10, end: 56, duration: D, confirmed: false, notice: null });
    expect(c.view().rate).toBeCloseTo(R, 12);
    expect(posted).toEqual([]);
    audio.currentTime = 4;
    await audio.play();
    void c.enable();
    await flush();
    expect(audio.paused).toBe(true);
    expect(c.view().status).toBe("starting");
    const attach = last() as Extract<VideoCommand, { op: "attach" }>;
    expect(attach).toMatchObject({ type: "video", op: "attach", start: 10, end: 56, syncId: "sync-1" });
    expect(attach.rate).toBeCloseTo(R, 12);
    expect(attach.time).toBeCloseTo(V(4), 9);
    await reply(attach, true, sample(V(4), { paused: true }));
    expect(c.view()).toMatchObject({ status: "paused", confirmed: true });
    expect(audio.paused).toBe(true);
    expect(ops()).toEqual(["attach"]);
  });

  it("refuses to start when the page cannot bind the video, and says why", async () => {
    void c.enable();
    await flush();
    await reply(last(), false, null, "range-outside-video");
    expect(c.view()).toMatchObject({ status: "off", notice: "range-outside-video", confirmed: false });
    // Whatever the page did is given back.
    expect(last().op).toBe("release");
  });

  it("is unavailable without a span or a fitting MP3, and when the page is not linked", async () => {
    make(null);
    expect(c.view()).toMatchObject({ status: "unavailable", unavailable: "no-metadata", rate: null });
    void c.enable();
    await flush();
    expect(posted).toEqual([]);
    make({ ...SOURCE, baseline: 360 });
    expect(c.view()).toMatchObject({ status: "unavailable", unavailable: "length-mismatch" });
    make();
    audio.duration = Number.NaN;
    expect(c.view().unavailable).toBe("loading");
    make();
    linked = false;
    expect(c.view()).toMatchObject({ status: "unavailable", unavailable: "not-linked" });
  });

  it("off pauses both and gives the video back; a late answer for that activation changes nothing", async () => {
    await on();
    await play();
    expect(audio.paused).toBe(false);
    void c.play();
    await flush();
    const pending = last();
    c.disable();
    expect(audio.paused).toBe(true);
    expect(last()).toMatchObject({ op: "release", syncId: "sync-1" });
    expect(c.view().status).toBe("off");
    await reply(pending, true, sample(20));
    expect(audio.paused).toBe(true);
    expect(last().op).toBe("release");
    // No timer is left running.
    expect(timers).toEqual([]);
  });

  it("dispose (session ended) gives the video back and leaves no timer", async () => {
    await on();
    await play();
    c.dispose();
    expect(last().op).toBe("release");
    expect(timers).toEqual([]);
    expect(c.active).toBe(false);
  });
});

describe("controls of MyDubb", () => {
  it("Play moves the video to the audio, starts it, then the audio where the video is; Pause stops both", async () => {
    await on(4);
    void c.play();
    await flush();
    expect(c.view().status).toBe("buffering");
    const seek = last() as Extract<VideoCommand, { op: "seek" }>;
    expect(seek.time).toBeCloseTo(V(4), 9);
    expect(audio.paused).toBe(true);
    await reply(seek, true, sample(V(4), { paused: true }));
    expect(last().op).toBe("play");
    expect(audio.paused).toBe(true);
    await reply(last(), true, sample(V(4) + 0.03));
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBeCloseTo(4 + 0.03 / R, 9);
    expect(c.view().status).toBe("playing");
    expect(audio.playbackRate).toBe(1);
    c.pause();
    expect(audio.paused).toBe(true);
    expect(last().op).toBe("pause");
    expect(c.view().status).toBe("paused");
    // Once the video answers, nothing is scheduled any more (no drift check while paused).
    await reply(last(), true, sample(V(4), { paused: true }));
    expect(timers).toEqual([]);
  });

  it("seek and ±5 s while paused move both; the bar stays in MP3 seconds", async () => {
    await on(4);
    void c.seek(9);
    await flush();
    expect(audio.currentTime).toBe(9);
    expect((last() as { time: number }).time).toBeCloseTo(V(9), 9);
    await reply(last(), true, sample(V(9), { paused: true }));
    void c.seek(-3);
    await flush();
    expect(audio.currentTime).toBe(0);
    expect((last() as { time: number }).time).toBe(10);
    void c.seek(999);
    await flush();
    expect(audio.currentTime).toBe(D);
    expect((last() as { time: number }).time).toBeCloseTo(56, 9);
    expect(audio.paused).toBe(true);
  });

  it("seek while playing holds the audio until the video is there, then both go on", async () => {
    await on();
    await play();
    void c.seek(12);
    await flush();
    expect(audio.paused).toBe(true);
    expect((last() as { time: number }).time).toBeCloseTo(V(12), 9);
    await reply(last(), true, sample(V(12)));
    await reply(last(), true, sample(V(12)));
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBeCloseTo(12, 9);
  });

  it("a newer action wins: Pause right after Play leaves both paused when the old answers arrive", async () => {
    await on();
    void c.play();
    await flush();
    const seek = last();
    c.pause();
    await reply(seek, true, sample(10, { paused: true }));
    expect(ops().filter((o) => o === "play")).toHaveLength(0);
    expect(audio.paused).toBe(true);
    expect(c.view().status).toBe("paused");
  });

  it("the end of the span pauses both; Play then starts both from the beginning", async () => {
    await on();
    await play();
    event("reached-end", sample(56.1, { paused: true }));
    expect(audio.paused).toBe(true);
    expect(c.view()).toMatchObject({ status: "paused", notice: "ended" });
    audio.currentTime = D - 0.4;
    void c.play();
    await flush();
    expect(audio.currentTime).toBe(0);
    expect((last() as { time: number }).time).toBe(10);
    expect(c.view().notice).toBeNull();
  });

  it("the MP3 ending pauses the video too", async () => {
    await on();
    await play();
    audio.ended = true;
    audio.pause();
    audio.fire("ended");
    expect(last().op).toBe("pause");
    expect(c.view()).toMatchObject({ status: "paused", notice: "ended" });
  });
});

describe("controls on the Udemy video", () => {
  it("a seek inside the span moves only the audio (no video seek back: no loop)", async () => {
    await on();
    const before = posted.length;
    event("user-seek", sample(40, { paused: true }));
    expect(audio.currentTime).toBeCloseTo(30 / R, 9);
    expect(posted).toHaveLength(before);
    await play();
    const count = posted.length;
    event("user-seek", sample(20));
    expect(audio.currentTime).toBeCloseTo(10 / R, 9);
    expect(audio.paused).toBe(false);
    expect(posted).toHaveLength(count);
  });

  it("a seek outside the span pauses both and turns Sync off, leaving the video where the user put it", async () => {
    await on();
    await play();
    event("user-seek", sample(5));
    expect(audio.paused).toBe(true);
    expect(c.view()).toMatchObject({ status: "off", notice: "seek-outside" });
    expect(ops().at(-1)).toBe("release");
    expect(ops()).not.toContain("seek-outside");
    // No seek was sent to pull the video back.
    expect(posted.filter((m) => m.op === "seek").every((m) => (m as { time: number }).time >= 10)).toBe(true);
  });

  it("Play and Pause on the video start and stop the audio at the mapped position", async () => {
    await on();
    event("user-play", sample(25));
    await flush();
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBeCloseTo(15 / R, 9);
    expect(c.view().status).toBe("playing");
    event("user-pause", sample(26, { paused: true }));
    expect(audio.paused).toBe(true);
    expect(c.view().status).toBe("paused");
  });

  it("a Udemy rate change, a replaced or broken video turn Sync off with both paused", async () => {
    for (const [name, notice] of [
      ["rate-changed", "rate-changed"],
      ["replaced", "video-replaced"],
      ["error", "video-error"],
    ] as const) {
      make();
      posted = [];
      await on();
      await play();
      event(name, sample(20));
      expect(audio.paused).toBe(true);
      expect(c.view()).toMatchObject({ status: "off", notice });
      expect(last().op).toBe("release");
    }
  });

  it("an unmute is respected: a notice, and Sync goes on", async () => {
    await on();
    await play();
    event("unmuted", sample(12));
    expect(c.view()).toMatchObject({ status: "playing", notice: "unmuted" });
    expect(audio.paused).toBe(false);
  });

  it("events of another activation are ignored", async () => {
    await on();
    event("user-play", sample(20), "sync-old");
    expect(audio.paused).toBe(true);
  });
});

describe("buffering, refusals and timeouts", () => {
  it("video buffering holds the audio; it resumes where the video is when the video plays again", async () => {
    await on();
    await play();
    event("waiting", sample(14, { waiting: true }));
    expect(audio.paused).toBe(true);
    expect(c.view().status).toBe("buffering");
    event("playing", sample(14.2));
    await flush();
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBeCloseTo(4.2 / R, 9);
    expect(c.view().status).toBe("playing");
  });

  it("a Pause during buffering is kept: the video becoming ready does not resume anything", async () => {
    await on();
    await play();
    event("waiting", sample(14, { waiting: true }));
    c.pause();
    event("playing", sample(14.2));
    await flush();
    expect(audio.paused).toBe(true);
    expect(c.view().status).toBe("paused");
  });

  it("audio buffering holds the video; when the audio plays again the video is realigned", async () => {
    await on();
    await play();
    audio.currentTime = 6;
    audio.fire("waiting");
    expect(last().op).toBe("pause");
    expect(c.view().status).toBe("buffering");
    audio.fire("playing");
    await flush();
    expect((last() as { time: number }).time).toBeCloseTo(V(6), 9);
  });

  it("a blocked video Play pauses the audio and says so; so does a blocked audio Play for the video", async () => {
    await on();
    void c.play();
    await flush();
    await reply(last(), true, sample(10, { paused: true }));
    await reply(last(), false, sample(10, { paused: true }), "play-blocked");
    expect(audio.paused).toBe(true);
    expect(c.view()).toMatchObject({ status: "paused", notice: "video-play-blocked" });
    audio.playError = { name: "NotAllowedError" };
    void c.play();
    await flush();
    await reply(last(), true, sample(10, { paused: true }));
    await reply(last(), true, sample(10));
    await flush();
    expect(last().op).toBe("pause");
    expect(c.view()).toMatchObject({ status: "paused", notice: "audio-play-blocked" });
  });

  it("a video that does not answer in time pauses both; its late answer changes nothing", async () => {
    await on();
    void c.play();
    await flush();
    const seek = last();
    await advance(10_000);
    expect(c.view()).toMatchObject({ status: "paused", notice: "no-response" });
    expect(last().op).toBe("pause");
    const count = posted.length;
    await reply(seek, true, sample(10));
    expect(posted).toHaveLength(count);
    expect(audio.paused).toBe(true);
  });

  it("a Play from outside MyDubb's controls (media keys) goes through the same alignment; an outside pause stops the video", async () => {
    await on();
    await play();
    audio.pause();
    expect(last().op).toBe("pause");
    expect(c.view().status).toBe("paused");
    await audio.play();
    await flush();
    expect(audio.paused).toBe(true);
    expect(last().op).toBe("seek");
  });
});

describe("drift", () => {
  async function position(drift: number, extra: Partial<VideoSample> = {}) {
    await advance(1000);
    const ask = last();
    expect(ask.op).toBe("position");
    await reply(ask, true, sample(V(audio.currentTime + drift), extra));
  }

  it("checks once a second only while both play; small drift is left alone", async () => {
    await on();
    expect(timers).toEqual([]);
    await play();
    for (let i = 0; i < 5; i += 1) await position(0.2);
    expect(ops().filter((o) => o === "seek")).toHaveLength(1);
    expect(c.stats.samples).toBe(5);
    expect(c.stats.maxAbsDrift).toBeCloseTo(0.2, 6);
    c.pause();
    await reply(last(), true, sample(20, { paused: true }));
    expect(timers).toEqual([]);
  });

  it("corrects a large drift seen twice by seeking the video (never the audio's rate), with a cooldown", async () => {
    await on();
    await play();
    const seeks = () => posted.filter((m) => m.op === "seek").length;
    await position(0.5);
    expect(seeks()).toBe(1);
    await position(-0.6);
    expect(seeks()).toBe(2);
    const correction = last() as { time: number };
    expect(correction.time).toBeCloseTo(V(audio.currentTime), 9);
    await reply(last(), true, sample(correction.time));
    // Within the 3 s cooldown: not again, even if still off.
    await position(0.5);
    await position(0.5);
    expect(seeks()).toBe(2);
    expect(audio.playbackRate).toBe(1);
    expect(c.stats.corrections).toBe(1);
  });

  it("after 3 corrections in 30 s the next one pauses both instead of correcting forever", async () => {
    await on();
    await play();
    for (let i = 0; i < 3; i += 1) {
      await position(0.8);
      await position(0.8);
      await reply(last(), true, sample(V(audio.currentTime)));
      await advance(2000);
      await reply(last(), true, sample(V(audio.currentTime)));
    }
    expect(c.stats.corrections).toBe(3);
    await position(0.8);
    await position(0.8);
    expect(c.view()).toMatchObject({ status: "paused", notice: "unstable" });
    expect(audio.paused).toBe(true);
    expect(c.stats.corrections).toBe(3);
  });

  it("a background tab is not held to that limit, and coming back realigns at once", async () => {
    await on();
    await play();
    for (let i = 0; i < 5; i += 1) {
      await position(0.8, { hidden: true });
      await position(0.8, { hidden: true });
      if (last().op === "seek") await reply(last(), true, sample(V(audio.currentTime), { hidden: true }));
      await advance(2000);
      if (last().op === "position") await reply(last(), true, sample(V(audio.currentTime), { hidden: true }));
    }
    expect(c.view().status).toBe("playing");
    // Back in front with a drift: corrected at once (no second sample, no cooldown).
    await advance(1000);
    if (last().op === "position") await reply(last(), true, sample(V(audio.currentTime)));
    const seeks = posted.filter((m) => m.op === "seek").length;
    event("visible", sample(V(audio.currentTime)));
    await flush();
    const ask = last();
    expect(ask.op).toBe("position");
    await reply(ask, true, sample(V(audio.currentTime + 1)));
    expect(posted.filter((m) => m.op === "seek").length).toBe(seeks + 1);
  });

  it("a video paused by the browser in a background tab keeps the audio; it is realigned on return", async () => {
    await on();
    await play();
    event("user-pause", sample(20, { paused: true, hidden: true }));
    expect(audio.paused).toBe(false);
    event("visible", sample(20, { paused: true }));
    await flush();
    expect(audio.paused).toBe(true);
    expect(last().op).toBe("seek");
  });

  it("three unanswered checks pause both", async () => {
    await on();
    await play();
    for (let i = 0; i < 3; i += 1) await advance(4000);
    expect(c.view()).toMatchObject({ status: "paused", notice: "no-response" });
  });
});

describe("audio events across the lifecycle (no stale expectation)", () => {
  /** Sync on, Play, then a pause from outside MyDubb (Chrome's media controls). */
  async function outsidePauseStopsBoth() {
    audio.pause();
    audio.deliver();
    expect(audio.paused).toBe(true);
    expect(c.view().status).toBe("paused");
    expect(last().op).toBe("pause");
    await reply(last(), true, sample(20, { paused: true }));
    // No drift check left running.
    expect(timers).toEqual([]);
  }

  it("Sync turned on while the audio played on its own: a later outside pause still stops both", async () => {
    await audio.play();
    await on(4);
    await play();
    expect(c.view().status).toBe("playing");
    await outsidePauseStopsBoth();
  });

  it("the same with the media events arriving late, after the synced Play", async () => {
    audio.deferred = true;
    await audio.play();
    audio.deliver();
    await on(4);
    await play();
    // The pause of turning Sync on and the play of the synced Play arrive only now.
    audio.deliver();
    expect(audio.paused).toBe(false);
    expect(c.view().status).toBe("playing");
    expect(last().op).toBe("play");
    await outsidePauseStopsBoth();
  });

  it("turning Sync off and on again, with late events in between, leaves nothing behind", async () => {
    audio.deferred = true;
    await on();
    await play();
    c.disable();
    await on();
    await play();
    audio.deliver();
    expect(c.view().status).toBe("playing");
    await outsidePauseStopsBoth();
  });

  it("after a refused audio Play, an outside play is aligned and an outside pause stops both", async () => {
    await on();
    audio.playError = { name: "NotAllowedError" };
    void c.play();
    await flush();
    await reply(last(), true, sample(10, { paused: true }));
    await reply(last(), true, sample(10));
    expect(c.view().notice).toBe("audio-play-blocked");
    expect(last().op).toBe("pause");
    await reply(last(), true, sample(10, { paused: true }));
    audio.playError = null;
    // Play from the media controls: the video is aligned first, then both play.
    await audio.play();
    await flush();
    expect(last().op).toBe("seek");
    await reply(last(), true, sample(10, { paused: true }));
    await reply(last(), true, sample(10));
    expect(c.view().status).toBe("playing");
    await outsidePauseStopsBoth();
  });

  it("an outside play while Sync is being turned on is held until it is ready", async () => {
    audio.deferred = true;
    audio.currentTime = 2;
    void c.enable();
    await flush();
    await audio.play();
    audio.deliver();
    expect(audio.paused).toBe(true);
    await reply(last(), true, sample(V(2), { paused: true }));
    expect(c.view().status).toBe("paused");
  });

  it("asks the hub for the single playback right before any audio start, never on a stale one", async () => {
    await on();
    await play();
    expect(claims).toBe(1);
    // Started from the video and after video buffering: claimed each time.
    c.pause();
    event("user-play", sample(20));
    await flush();
    expect(claims).toBe(2);
    event("waiting", sample(21, { waiting: true }));
    event("playing", sample(21.1));
    await flush();
    expect(claims).toBe(3);
    // Paused by another tab: a late "playing" of this video does not take the playback back.
    c.pause("other-tab");
    event("playing", sample(22));
    await flush();
    expect(claims).toBe(3);
    expect(audio.paused).toBe(true);
  });
});
