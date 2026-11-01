import { describe, expect, it, vi } from "vitest";
import { AttachedVideo, pickVideo, seekBounds } from "./video";
import { fakeVideo } from "./testVideo";

const all = () => true;

describe("pickVideo", () => {
  it("reports none when no video is rendered", () => {
    const v = fakeVideo(document);
    expect(pickVideo([v], null, null, () => false)).toEqual({ kind: "none" });
  });

  it("takes the only rendered video", () => {
    const hidden = fakeVideo(document);
    const shown = fakeVideo(document);
    expect(pickVideo([hidden, shown], null, null, (v) => v === shown)).toEqual({ kind: "video", video: shown });
  });

  it("does not default to the first of several candidates", () => {
    const a = fakeVideo(document);
    const b = fakeVideo(document);
    expect(pickVideo([a, b], null, null, all)).toEqual({ kind: "ambiguous", candidates: 2 });
  });

  it("prefers the video the user started, then the attached one, then the only playing one", () => {
    const a = fakeVideo(document);
    const b = fakeVideo(document, { paused: false });
    expect(pickVideo([a, b], null, null, all)).toEqual({ kind: "video", video: b });
    expect(pickVideo([a, b], a, null, all)).toEqual({ kind: "video", video: a });
    expect(pickVideo([a, b], b, a, all)).toEqual({ kind: "video", video: a });
  });

  it("drops an attached video that is no longer rendered", () => {
    const a = fakeVideo(document);
    const b = fakeVideo(document);
    const c = fakeVideo(document);
    expect(pickVideo([b, c], a, null, all)).toEqual({ kind: "ambiguous", candidates: 2 });
  });
});

describe("seekBounds", () => {
  it("uses the outer seekable range, else [0, duration] once metadata is known", () => {
    expect(seekBounds(fakeVideo(document, { seekable: [[2, 10], [12, 50]] }))).toEqual([2, 50]);
    expect(seekBounds(fakeVideo(document, { seekable: [], duration: 30 }))).toEqual([0, 30]);
    expect(seekBounds(fakeVideo(document, { seekable: [], readyState: 0 }))).toBeNull();
    expect(seekBounds(fakeVideo(document, { seekable: [], duration: Infinity }))).toBeNull();
  });
});

describe("AttachedVideo", () => {
  it("clamps seeks to the playable range", () => {
    const v = fakeVideo(document, { currentTime: 3, seekable: [[0, 20]] });
    const attached = new AttachedVideo(v, 1, () => undefined);
    expect(attached.seekBy(-5)).toBeNull();
    expect(v.media.currentTime).toBe(0);
    v.media.currentTime = 18;
    expect(attached.seekBy(5)).toBeNull();
    expect(v.media.currentTime).toBe(20);
    v.media.currentTime = 10;
    attached.seekBy(5);
    expect(v.media.currentTime).toBe(15);
  });

  describe("place", () => {
    const seeked = (video: HTMLVideoElement) => queueMicrotask(() => video.dispatchEvent(new Event("seeked")));

    it("pauses the video at an exact position, done only once the seek finished", async () => {
      const v = fakeVideo(document, { paused: false, currentTime: 40, seekable: [[0, 100]], seekOutcome: seeked });
      const attached = new AttachedVideo(v, 1, () => undefined);
      await expect(attached.place(73)).resolves.toBeNull();
      expect(v.media.paused).toBe(true);
      expect(v.media.currentTime).toBe(73);
      await expect(attached.place(0)).resolves.toBeNull();
      expect(v.media.currentTime).toBe(0);
    });

    it("is refused, never clamped, outside the range or before metadata", async () => {
      const v = fakeVideo(document, { paused: false, currentTime: 12, seekable: [[0, 100]] });
      await expect(new AttachedVideo(v, 1, () => undefined).place(101)).resolves.toBe("out-of-range");
      expect(v.media.currentTime).toBe(12);
      expect(v.media.paused).toBe(false);
      await expect(new AttachedVideo(fakeVideo(document, { readyState: 0 }), 1, () => undefined).place(5)).resolves.toBe("not-ready");
      const live = fakeVideo(document, { seekable: [], duration: Infinity });
      await expect(new AttachedVideo(live, 1, () => undefined).place(5)).resolves.toBe("not-seekable");
    });

    it("fails when the seek lands elsewhere, the page plays it again, or the seek never finishes", async () => {
      const elsewhere = fakeVideo(document, {
        seekOutcome: (video) => {
          (video as typeof elsewhere).media.currentTime = 2;
          seeked(video);
        },
      });
      await expect(new AttachedVideo(elsewhere, 1, () => undefined).place(73)).resolves.toBe("seek-failed");
      const replayed = fakeVideo(document, {
        seekOutcome: (video) => {
          (video as typeof replayed).media.paused = false;
          seeked(video);
        },
      });
      await expect(new AttachedVideo(replayed, 1, () => undefined).place(73)).resolves.toBe("seek-failed");
      vi.useFakeTimers();
      try {
        // currentTime reads 73 at once, as on a real video still seeking; "seeked" never comes.
        const placing = new AttachedVideo(fakeVideo(document), 1, () => undefined).place(73);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(placing).resolves.toBe("seek-failed");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("refuses to seek before metadata or without a range", () => {
    expect(new AttachedVideo(fakeVideo(document, { readyState: 0 }), 1, () => undefined).seekBy(5)).toBe("not-ready");
    const live = fakeVideo(document, { seekable: [], duration: Infinity });
    expect(new AttachedVideo(live, 1, () => undefined).seekBy(5)).toBe("not-seekable");
  });

  it("maps a rejected play() to a clear error", async () => {
    const blocked = fakeVideo(document, {
      playImpl: () => Promise.reject(new DOMException("blocked", "NotAllowedError")),
    });
    expect(await new AttachedVideo(blocked, 1, () => undefined).play()).toBe("play-blocked");
    const aborted = fakeVideo(document, { playImpl: () => Promise.reject(new DOMException("x", "AbortError")) });
    expect(await new AttachedVideo(aborted, 1, () => undefined).play()).toBe("play-interrupted");
    const noSource = fakeVideo(document, { readyState: 0, networkState: 3 });
    expect(await new AttachedVideo(noSource, 1, () => undefined).play()).toBe("not-ready");
  });

  it("never touches muted, volume or playbackRate", async () => {
    const v = fakeVideo(document, { currentTime: 10 });
    v.muted = true;
    v.volume = 0.3;
    v.playbackRate = 1.5;
    const attached = new AttachedVideo(v, 1, () => undefined);
    await attached.play();
    attached.pause();
    attached.seekBy(5);
    expect([v.muted, v.volume, v.playbackRate]).toEqual([true, 0.3, 1.5]);
  });

  it("reports state from media events, tracks buffering and stops listening on detach", () => {
    const v = fakeVideo(document, { duration: NaN });
    const onChange = vi.fn();
    let now = 0;
    const attached = new AttachedVideo(v, 7, onChange, () => now);
    expect(attached.state()).toMatchObject({ status: "ready", id: 7, paused: true, duration: null });
    v.media.paused = false;
    v.dispatchEvent(new Event("waiting"));
    expect(attached.state()).toMatchObject({ waiting: true, paused: false });
    v.dispatchEvent(new Event("playing"));
    expect(attached.state()).toMatchObject({ waiting: false });
    now = 1000;
    v.dispatchEvent(new Event("timeupdate"));
    v.dispatchEvent(new Event("timeupdate")); // throttled
    expect(onChange).toHaveBeenCalledTimes(3);
    v.media.error = { code: 2 };
    expect(attached.state()).toMatchObject({ error: "Network error while loading the video." });
    attached.detach();
    v.dispatchEvent(new Event("pause"));
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
