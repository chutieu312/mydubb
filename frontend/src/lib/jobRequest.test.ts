import { describe, expect, it } from "vitest";

import { buildJobRequest, captionKey, fieldsFromCaptions, usesTimestamps } from "./jobRequest";
import { analyzeTranscriptTiming } from "./transcriptTiming";

const VALUES = {
  transcript: "Spring Boot uses Dependency Injection.",
  firstStart: "00:00:10",
  lastStart: "00:06:10",
  voice: "EmmaMultilingual",
  speed: 1.25,
  targetLanguage: "spanish",
  ignoreTimestamps: false,
};
const TIMED = "0:05.480\nFirst caption.\n0:12\nSecond caption.";

describe("buildJobRequest", () => {
  it("sends a plain transcript without timing_mode", () => {
    expect(buildJobRequest(VALUES, analyzeTranscriptTiming(VALUES.transcript))).toEqual({
      transcript: VALUES.transcript,
      first_sentence_start: "00:00:10",
      last_sentence_start: "00:06:10",
      voice: "EmmaMultilingual",
      speed: 1.25,
      target_language: "spanish",
    });
  });

  it("asks for timed mode for timestamps on their own lines, unless they are ignored", () => {
    const timing = analyzeTranscriptTiming(TIMED);
    const values = { ...VALUES, transcript: TIMED };
    expect(buildJobRequest(values, timing).timing_mode).toBe("timed");
    expect(buildJobRequest(values, timing).transcript).toBe(TIMED);
    expect(buildJobRequest({ ...values, ignoreTimestamps: true }, timing)).not.toHaveProperty(
      "timing_mode",
    );
  });

  it("asks for timed mode for invalid timestamps so the server explains them", () => {
    const timing = analyzeTranscriptTiming("0:10\nA.\n0:05\nB.");
    expect(timing.kind).toBe("invalid");
    expect(usesTimestamps(timing, false)).toBe(true);
    expect(usesTimestamps(timing, true)).toBe(false);
    expect(
      usesTimestamps(analyzeTranscriptTiming("WEBVTT\n\n00:01.000 --> 00:02.000\nA"), false),
    ).toBe(false);
  });

  it("omits the language when the server lists none", () => {
    expect(buildJobRequest({ ...VALUES, targetLanguage: "" }, { kind: "none" })).not.toHaveProperty(
      "target_language",
    );
  });
});

describe("caption fields", () => {
  it("truncate the first and last caption start to whole seconds", () => {
    const timing = analyzeTranscriptTiming(TIMED);
    expect(timing.kind === "timed" && fieldsFromCaptions(timing)).toEqual({
      first: "00:00:05",
      last: "00:00:12",
    });
    expect(captionKey(timing)).toBe("5.48-12");
    expect(fieldsFromCaptions({ first: 5.1, last: 5.9 })).toBeNull();
    expect(captionKey({ kind: "none" })).toBeNull();
  });
});
