import { describe, expect, it } from "vitest";

import { previewWordCount } from "./wordCount";

describe("previewWordCount (mirrors backend/app/transcript/words.py)", () => {
  it("counts whitespace-separated tokens with a letter or digit", () => {
    expect(previewWordCount("A neural network — uses 2 layers.")).toBe(6);
    expect(previewWordCount("  ")).toBe(0);
    expect(previewWordCount("Tiếng Việt có dấu")).toBe(4);
  });

  it("does not count timestamp lines, cue timings or headers", () => {
    const youtube = "0:00\nHello world\n0:05.480\nsecond caption\n1:02:03\nthird";
    expect(previewWordCount(youtube)).toBe(5);
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nHello there\n";
    // The cue index "1" still counts here; the server drops it with its cleaning (preview only).
    expect(previewWordCount(srt)).toBe(3);
    expect(previewWordCount("WEBVTT\n\n[00:01]\nHi")).toBe(1);
  });

  it("keeps a time that is part of a sentence", () => {
    expect(previewWordCount("10:30 is our meeting time.")).toBe(5);
  });
});
