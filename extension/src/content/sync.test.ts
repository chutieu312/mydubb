// @vitest-environment-options {"url": "https://www.udemy.com/course/demo-course/learn/lecture/1"}
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PageToPlayer, VideoCommand, VideoEvent, VideoReply } from "../shared/playback";
import { VideoSync } from "./sync";
import { fakeVideo } from "./testVideo";

type Video = ReturnType<typeof fakeVideo> & { rate: { value: number; max: number }; volumeWrites: number };

/** fakeVideo plus rate, mute and source, with the events a real element fires for them. */
function video(src = "blob:https://www.udemy.com/lecture-1"): Video {
  const v = fakeVideo(document, { duration: 120, seekable: [[0, 120]] }) as Video;
  v.rate = { value: 1, max: 16 };
  v.volumeWrites = 0;
  let muted = false;
  Object.defineProperty(v, "playbackRate", {
    configurable: true,
    get: () => v.rate.value,
    set: (value: number) => {
      if (value > v.rate.max) throw new DOMException("unsupported", "NotSupportedError");
      v.rate.value = value;
      v.dispatchEvent(new Event("ratechange"));
    },
  });
  Object.defineProperty(v, "muted", {
    configurable: true,
    get: () => muted,
    set: (value: boolean) => {
      muted = value;
      v.dispatchEvent(new Event("volumechange"));
    },
  });
  Object.defineProperty(v, "volume", {
    configurable: true,
    get: () => 1,
    set: () => void (v.volumeWrites += 1),
  });
  Object.defineProperty(v, "currentSrc", { configurable: true, get: () => src, set: (s: string) => (src = s) });
  Object.defineProperty(v, "seeking", { configurable: true, get: () => false });
  document.body.append(v);
  return v;
}

let sent: PageToPlayer[];
let current: HTMLVideoElement | null;
let sync: VideoSync;
let v: Video;
let cmd: number;

const command = (op: Record<string, unknown>, syncId = "sync-1") => ({ type: "video", syncId, cmdId: ++cmd, ...op }) as VideoCommand;
const replies = () => sent.filter((m): m is VideoReply => m.type === "video-reply");
const events = () => sent.filter((m): m is VideoEvent => m.type === "video-event").map((m) => m.event);
const lastReply = () => replies().at(-1)!;
const seeked = () => v.dispatchEvent(new Event("seeked"));

function attach(extra: Record<string, unknown> = {}) {
  sync.handle(command({ op: "attach", start: 10, end: 56, rate: 1.5, time: 16, ...extra }));
}

beforeEach(() => {
  document.body.replaceChildren();
  sent = [];
  cmd = 0;
  v = video();
  current = v;
  sync = new VideoSync({ doc: document, current: () => current, send: (m) => sent.push(structuredClone(m)) });
});

afterEach(() => sync.release());

describe("binding the video", () => {
  it("pauses, sets the rate, mutes (volume untouched), seeks, then answers once the seek is done", async () => {
    v.media.paused = false;
    attach();
    expect(v.paused).toBe(true);
    expect(v.playbackRate).toBe(1.5);
    expect(v.muted).toBe(true);
    expect(v.volumeWrites).toBe(0);
    expect(v.currentTime).toBe(16);
    expect(replies()).toEqual([]);
    seeked();
    expect(lastReply()).toMatchObject({ ok: true, cmdId: 1, video: { currentTime: 16, paused: true } });
    // Its own pause, rate, mute and seek are not reported as the user's.
    expect(events()).toEqual([]);
  });

  it("refuses: no identified video, not ready, the span outside the video, a rate the browser rejects", () => {
    current = null;
    attach();
    expect(lastReply()).toMatchObject({ ok: false, error: "no-video" });
    current = v;
    v.media.readyState = 0;
    attach();
    expect(lastReply()).toMatchObject({ ok: false, error: "not-ready" });
    v.media.readyState = 4;
    attach({ end: 130 });
    expect(lastReply()).toMatchObject({ ok: false, error: "range-outside-video" });
    v.rate.max = 4;
    attach({ rate: 5 });
    expect(lastReply()).toMatchObject({ ok: false, error: "rate-unsupported" });
    expect(v.playbackRate).toBe(1);
    expect(v.muted).toBe(false);
    expect(sync.attached).toBeNull();
  });

  it("release pauses and gives back the rate and the sound it took", () => {
    attach();
    seeked();
    sync.release();
    expect(v).toMatchObject({ paused: true, muted: false, playbackRate: 1 });
  });

  it("does not take what was already so: a muted video stays muted, the same rate is not 'owned'", () => {
    v.muted = true;
    v.rate.value = 1.5;
    attach();
    seeked();
    sync.release();
    expect(v.muted).toBe(true);
    expect(v.playbackRate).toBe(1.5);
  });

  it("keeps a user's unmute (reported, never muted again) and leaves a changed rate alone", () => {
    attach();
    seeked();
    v.muted = false;
    expect(events()).toEqual(["unmuted"]);
    v.playbackRate = 2;
    expect(events()).toEqual(["unmuted", "rate-changed"]);
    // Not forced back, and not restored over the user's choice.
    expect(v.playbackRate).toBe(2);
    sync.release();
    expect(v.playbackRate).toBe(2);
    expect(v.muted).toBe(false);
  });

  it("never restores into another source (a reused element showing another lecture)", () => {
    attach();
    seeked();
    (v as { currentSrc: string }).currentSrc = "blob:https://www.udemy.com/lecture-2";
    v.dispatchEvent(new Event("emptied"));
    expect(events()).toEqual(["replaced"]);
    expect(v.muted).toBe(true);
    expect(v.playbackRate).toBe(1.5);
    expect(sync.attached).toBeNull();
  });

  it("a replaced element ends the binding; the new one is never driven by an old command", async () => {
    attach();
    seeked();
    const next = video("blob:https://www.udemy.com/lecture-1b");
    current = next;
    sync.check();
    expect(events()).toEqual(["replaced"]);
    // The old element is given back; the new one untouched.
    expect(v).toMatchObject({ muted: false, playbackRate: 1 });
    sync.handle(command({ op: "play" }));
    await Promise.resolve();
    expect(lastReply()).toMatchObject({ ok: false, error: "not-attached" });
    expect(next.paused).toBe(true);
    expect(next.muted).toBe(false);
  });
});

describe("own operations and the user's", () => {
  beforeEach(() => {
    attach();
    seeked();
    sent = [];
  });

  it("its play, pause and seek are echoes; the same actions by the user are reported", async () => {
    sync.handle(command({ op: "play" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(lastReply()).toMatchObject({ ok: true });
    sync.handle(command({ op: "seek", time: 30 }));
    seeked();
    sync.handle(command({ op: "pause" }));
    expect(events()).toEqual([]);
    // The user (or the site) now.
    await v.play();
    v.pause();
    v.currentTime = 40;
    seeked();
    expect(events()).toEqual(["user-play", "user-pause", "user-seek"]);
  });

  it("late play/pause events of its own operations are no news; the user's next action still is", async () => {
    // Bound while playing (the attach paused it); MyDubb plays it again before the events arrive.
    sync.handle(command({ op: "play" }));
    await Promise.resolve();
    await Promise.resolve();
    sent = [];
    // The late "pause" of the attach, and a repeated "play": the element is playing, as wanted.
    v.dispatchEvent(new Event("pause"));
    v.dispatchEvent(new Event("play"));
    expect(events()).toEqual([]);
    // The user pauses now: reported once, however many pause events follow.
    v.pause();
    v.dispatchEvent(new Event("pause"));
    expect(events()).toEqual(["user-pause"]);
    // MyDubb pauses it again (already paused): nothing; the user plays: reported.
    sync.handle(command({ op: "pause" }));
    await v.play();
    expect(events()).toEqual(["user-pause", "user-play"]);
  });

  it("a user seek while its own seek is pending: its seek is superseded and the user's reported", () => {
    sync.handle(command({ op: "seek", time: 30 }));
    v.currentTime = 50;
    seeked();
    expect(lastReply()).toMatchObject({ ok: false, error: "superseded" });
    expect(events()).toEqual(["user-seek"]);
  });

  it("a blocked play is reported as such", async () => {
    v.media.playImpl = async () => {
      throw new DOMException("no", "NotAllowedError");
    };
    sync.handle(command({ op: "play" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(lastReply()).toMatchObject({ ok: false, error: "play-blocked" });
    expect(events()).toEqual([]);
  });

  it("stops at the end of the span by itself", async () => {
    sync.handle(command({ op: "play" }));
    await Promise.resolve();
    v.media.currentTime = 56.1;
    v.dispatchEvent(new Event("timeupdate"));
    expect(v.paused).toBe(true);
    expect(events()).toEqual(["reached-end"]);
  });

  it("reports buffering, a return to the foreground, and refuses another activation's commands", () => {
    v.media.paused = false;
    v.dispatchEvent(new Event("waiting"));
    v.dispatchEvent(new Event("playing"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(events()).toEqual(["waiting", "playing", "visible"]);
    sync.handle(command({ op: "position" }, "sync-old"));
    expect(lastReply()).toMatchObject({ ok: false, error: "not-attached", syncId: "sync-old" });
    sync.handle(command({ op: "position" }));
    expect(lastReply()).toMatchObject({ ok: true, video: { currentTime: 16, paused: false, hidden: false } });
  });

  it("refuses a seek outside its span", () => {
    sync.handle(command({ op: "seek", time: 80 }));
    expect(lastReply()).toMatchObject({ ok: false, error: "range-outside-video" });
    expect(v.currentTime).toBe(16);
  });

  it("after release nothing is listened to or answered as attached", () => {
    sync.release();
    sent = [];
    v.currentTime = 30;
    seeked();
    v.playbackRate = 3;
    expect(events()).toEqual([]);
  });
});
