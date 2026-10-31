import { describe, expect, it } from "vitest";

import { AUDIO_SPEEDS } from "../../../frontend/src/lib/speed";
import {
  audioTime,
  clockLabel,
  isSyncSource,
  rateLabel,
  syncMapping,
  syncNoticeText,
  syncPreviewText,
  syncStatusText,
  videoTime,
  type SyncSource,
  type SyncView,
} from "./sync";

function mapped(source: SyncSource, duration: number) {
  const result = syncMapping(source, duration);
  if (!result.ok) throw new Error(`no mapping: ${result.reason}`);
  return result.mapping;
}

describe("timeline mapping", () => {
  it("the story's example: V0 10 s, V1 30 s, MP3 13.333 s -> video 1.5x, audio 4 s = video 16 s", () => {
    const m = mapped({ mode: "plain", start: 10, end: 30, baseline: 20, speed: 1.5 }, 20 / 1.5);
    expect(m.rate).toBeCloseTo(1.5, 12);
    expect(videoTime(m, 4)).toBeCloseTo(16, 12);
    expect(audioTime(m, 16)).toBeCloseTo(4, 12);
    expect(videoTime(m, 0)).toBe(10);
    expect(videoTime(m, m.duration)).toBeCloseTo(30, 12);
  });

  it.each(AUDIO_SPEEDS)("V0 with milliseconds, speed %sx: R equals the speed when the span is the baseline", (speed) => {
    // Timed captions 0:12.345 -> 1:12.345 with fields 00:00:12 -> 00:01:12 (60 s).
    const source: SyncSource = { mode: "timed", start: 12.345, end: 72.345, baseline: 60, speed };
    const m = mapped(source, 60 / speed);
    expect(m.rate).toBeCloseTo(speed, 12);
    for (const a of [0, 0.001, 1.5, m.duration / 2, m.duration]) {
      expect(audioTime(m, videoTime(m, a))).toBeCloseTo(a, 9);
    }
    expect(videoTime(m, 2)).toBeCloseTo(12.345 + 2 * speed, 9);
  });

  it("timed with changed start times: R follows the caption span and the real MP3, not the speed", () => {
    // 30 s of captions, the user typed a 46 s span and 1.5x: the MP3 is 46 / 1.5 = 30.667 s.
    const m = mapped({ mode: "timed", start: 10.25, end: 40.25, baseline: 46, speed: 1.5 }, 46 / 1.5);
    expect(m.rate).toBeCloseTo(30 / (46 / 1.5), 12);
    expect(m.rate).not.toBeCloseTo(1.5, 1);
    expect(videoTime(m, 10)).toBeCloseTo(10.25 + 10 * m.rate, 9);
    // Without the override the same captions give R = speed.
    expect(mapped({ mode: "timed", start: 10.25, end: 40.25, baseline: 30, speed: 1.5 }, 20).rate).toBeCloseTo(1.5, 12);
  });

  it("uses the real MP3 duration (encoder padding), not baseline / speed", () => {
    const m = mapped({ mode: "plain", start: 10, end: 56, baseline: 46, speed: 1.5 }, 30.563);
    expect(m.duration).toBe(30.563);
    expect(m.rate).toBeCloseTo(46 / 30.563, 12);
  });

  it("refuses, never clamps: no metadata, loading, an MP3 that does not fit, a rate Chrome cannot play", () => {
    const source: SyncSource = { mode: "plain", start: 10, end: 370, baseline: 360, speed: 1 };
    expect(syncMapping(null, 360)).toEqual({ ok: false, reason: "no-metadata" });
    expect(syncMapping(source, null)).toEqual({ ok: false, reason: "loading" });
    expect(syncMapping(source, Number.NaN)).toEqual({ ok: false, reason: "loading" });
    // 1 % of 360 s = 3.6 s of tolerance; a 30 s mock MP3 does not fit.
    expect(syncMapping(source, 30)).toEqual({ ok: false, reason: "length-mismatch" });
    expect(syncMapping(source, 356.5).ok).toBe(true);
    expect(syncMapping(source, 356.3)).toEqual({ ok: false, reason: "length-mismatch" });
    // Short MP3: 0.25 s.
    const short: SyncSource = { mode: "plain", start: 0, end: 10, baseline: 10, speed: 1 };
    expect(syncMapping(short, 10.24).ok).toBe(true);
    expect(syncMapping(short, 10.26)).toEqual({ ok: false, reason: "length-mismatch" });
    // 600 s of captions in a 30 s MP3: 20x.
    expect(syncMapping({ mode: "timed", start: 0, end: 600, baseline: 30, speed: 1 }, 30)).toEqual({
      ok: false,
      reason: "rate-unsupported",
    });
    expect(syncMapping({ mode: "timed", start: 0, end: 1, baseline: 30, speed: 1 }, 30)).toEqual({
      ok: false,
      reason: "rate-unsupported",
    });
  });

  it("validates the stored span", () => {
    expect(isSyncSource({ mode: "plain", start: 10, end: 20, baseline: 10, speed: 1 })).toBe(true);
    expect(isSyncSource({ mode: "plain", start: 20, end: 20, baseline: 10, speed: 1 })).toBe(false);
    expect(isSyncSource({ mode: "plain", start: -1, end: 20, baseline: 10, speed: 1 })).toBe(false);
    expect(isSyncSource({ mode: "other", start: 0, end: 20, baseline: 10, speed: 1 })).toBe(false);
    expect(isSyncSource({ mode: "timed", start: 0, end: 20, baseline: 0, speed: 1 })).toBe(false);
    expect(isSyncSource({ mode: "timed", start: 0, end: Number.POSITIVE_INFINITY, baseline: 10, speed: 1 })).toBe(false);
    expect(isSyncSource(null)).toBe(false);
  });
});

describe("texts", () => {
  const view: SyncView = {
    status: "off",
    unavailable: null,
    start: 10.25,
    end: 40.25,
    duration: 30.563,
    rate: 30 / 30.563,
    confirmed: false,
    notice: null,
  };

  it("labels positions and rates", () => {
    expect(clockLabel(10)).toBe("0:10");
    expect(clockLabel(10.25)).toBe("0:10.250");
    expect(clockLabel(3723.5)).toBe("1:02:03.500");
    expect(rateLabel(1.5)).toBe("1.5x");
    expect(rateLabel(46 / 30.563)).toBe("1.505x");
  });

  it("says what Sync does before it is turned on, and its state", () => {
    expect(syncPreviewText(view)).toBe(
      "Video 0:10.250 → 0:40.250 (30 s), MP3 30.563 s, video speed 0.982x. The video is muted: the MyDubb audio replaces the spoken part. The timing is an estimate, not word by word.",
    );
    expect(syncStatusText(view)).toBe("Sync with video: OFF");
    expect(syncStatusText({ ...view, status: "buffering" })).toBe("Sync with video: ON · Buffering…");
    expect(syncStatusText({ ...view, status: "unavailable", unavailable: "no-metadata" })).toContain("Generate it again");
    expect(syncNoticeText({ ...view, notice: "seek-outside" })).toContain("outside 0:10.250–0:40.250");
    expect(syncNoticeText(view)).toBe("");
  });

  it("says which speed the video could not keep, without blaming the user for a change of unknown origin", () => {
    expect(syncNoticeText({ ...view, notice: "rate-not-held" })).toBe(
      "Sync turned off: the video speed did not stay at 0.982x, the speed Sync needs (the page kept setting another speed). Both are paused.",
    );
    const changed = syncNoticeText({ ...view, notice: "rate-changed" });
    expect(changed).toContain("the video speed changed from 0.982x, the speed Sync needs, while it played");
    for (const text of [changed, syncNoticeText({ ...view, notice: "rate-not-held" })]) expect(text).not.toMatch(/\byou\b/i);
  });
});
