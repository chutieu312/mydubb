import { describe, expect, it } from "vitest";

import { recoveries, steadyStats, testSpan, type DriftSample } from "./drift";

const sample = (t: number, drift: number, extra: Partial<DriftSample> = {}): DriftSample => ({
  t,
  audio: 0,
  video: 0,
  drift,
  audioPaused: false,
  videoPaused: false,
  videoWaiting: false,
  videoRate: 1,
  ...extra,
});

describe("steadyStats", () => {
  it("leaves out samples that settle an operation and samples not both playing", () => {
    const samples = [sample(0, 0.9), sample(1000, 0.5), sample(2500, 0.1), sample(3000, -0.2), sample(3500, 2, { videoWaiting: true })];
    const stats = steadyStats(samples, [{ t: 0, label: "play" }]);
    expect(stats.samples).toBe(2);
    expect(stats.maxAbs).toBeCloseTo(0.2);
    expect(stats.medianAbs).toBeCloseTo(0.1);
  });

  it("is empty without samples", () => {
    expect(steadyStats([], [])).toEqual({ samples: 0, medianAbs: null, p95Abs: null, maxAbs: null });
  });
});

describe("recoveries", () => {
  it("times each operation until both play within the threshold again", () => {
    const samples = [
      sample(100, 0, { videoPaused: true }),
      sample(350, 0.8),
      sample(600, 0.25),
      sample(5000, 0, { audioPaused: true, videoPaused: true }),
    ];
    const result = recoveries(samples, [
      { t: 0, label: "seek" },
      { t: 4900, label: "pause" },
    ]);
    expect(result[0]).toEqual({ label: "seek", alignedAfterMs: 600, maxAbsDrift: 0.8, endState: "both-playing" });
    expect(result[1]).toEqual({ label: "pause", alignedAfterMs: null, maxAbsDrift: null, endState: "both-paused" });
  });

  it("says when an operation has no sample", () => {
    expect(recoveries([], [{ t: 0, label: "x" }])[0]!.endState).toBe("no-sample");
  });
});

describe("testSpan", () => {
  it("starts where the video is, as long as the MP3 at R", () => {
    expect(testSpan(12.3456, 0, 120, 30, 1.5)).toEqual({ start: 12.345, end: 57.345 });
  });

  it("moves back when the video ends first, and refuses a video that is too short", () => {
    expect(testSpan(100, 0, 120, 30, 1)).toEqual({ start: 90, end: 120 });
    expect(testSpan(0, 0, 20, 30, 1)).toEqual({ error: "too-short" });
  });
});
