import { describe, expect, it } from "vitest";

import { analyzeTranscriptTiming, captionClock } from "./transcriptTiming";

const YOUTUBE = [
  "0:00",
  "Generally, if if somebody's trying to",
  "0:01",
  "make a company work, they should expect",
  "0:03",
  "to grind super hard. Uh except that",
  "0:11",
  "humans, uh we can make spaceships. It's",
].join("\n");

describe("recognizing a timed transcript", () => {
  it("finds the captions and the first and last caption times", () => {
    expect(analyzeTranscriptTiming(YOUTUBE)).toEqual({
      kind: "timed",
      captions: 4,
      first: 0,
      last: 11,
    });
  });

  it("reads M:SS, MM:SS and H:MM:SS, with an offset first caption", () => {
    const raw = "59:58\nA long video.\n1:00:03\nStill here.\n01:00:09\nEnd.";
    expect(analyzeTranscriptTiming(raw)).toEqual({
      kind: "timed",
      captions: 3,
      first: 3598,
      last: 3609,
    });
  });

  it("reads the milliseconds the caption import writes, exactly", () => {
    const imported = "0:10.480\nWelcome back.\n0:12.960\nStep by step.\n1:02:03.004\nBye!";
    expect(analyzeTranscriptTiming(imported)).toEqual({
      kind: "timed",
      captions: 3,
      first: 10.48,
      last: 3723.004,
    });
    expect(analyzeTranscriptTiming("0:00.1\nA.\n0:00.25\nB.")).toMatchObject({
      first: 0.1,
      last: 0.25,
    });
  });

  it("treats text without standalone timestamps as plain", () => {
    expect(analyzeTranscriptTiming("Spring Boot uses JSON.")).toEqual({ kind: "none" });
    expect(analyzeTranscriptTiming("10:30 is our meeting time.\nSee you.")).toEqual({
      kind: "none",
    });
    expect(analyzeTranscriptTiming("0:05\nonly one timestamp")).toEqual({ kind: "none" });
  });

  it("recognizes SRT and WebVTT, whose timing is not used yet", () => {
    const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello.";
    expect(analyzeTranscriptTiming(srt)).toEqual({ kind: "cues" });
    expect(analyzeTranscriptTiming("WEBVTT\n\n00:01.000 --> 00:03.000\nHi")).toEqual({
      kind: "cues",
    });
  });

  it.each([
    ["0:00\nA.\n0:05\nB.\n0:03\nC.", "go backwards (0:05 is followed by 0:03)"],
    ["0:00\nA.\n0:75\nB.", "Line 3 (0:75) is not a valid timestamp"],
    ["0:00\nA.\n1:2:03\nB.", "is not a valid timestamp"],
    ["Intro\n0:00\nA.\n0:05\nB.", "Line 1 has text before the first timestamp"],
    ["0:00\n0:03\nA.\n0:05\nB.", "line 1 has no caption text"],
    ["0:04\nA.\n0:04\nB.", "same time as the first one"],
    ["0:04.250\nA.\n0:04.250\nB.", "same time as the first one"],
    ["0:00\nA.\n0:05.5555\nB.", "(0:05.5555) is not a valid timestamp"],
    ["0:00\nA.\n0:05,500\nB.", "(0:05,500) is not a valid timestamp"],
  ])("explains why %j cannot be timed instead of guessing", (raw, message) => {
    const timing = analyzeTranscriptTiming(raw);
    expect(timing.kind).toBe("invalid");
    expect(timing.kind === "invalid" && timing.message).toContain(message);
  });
});

describe("caption clock", () => {
  it("writes times the way transcripts do", () => {
    expect(captionClock(5)).toBe("0:05");
    expect(captionClock(750)).toBe("12:30");
    expect(captionClock(3723)).toBe("1:02:03");
    expect(captionClock(10.48)).toBe("0:10.480");
    expect(captionClock(3723.004)).toBe("1:02:03.004");
  });
});
