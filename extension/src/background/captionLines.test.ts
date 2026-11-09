import { describe, expect, it } from "vitest";
import { analyzeTranscriptTiming } from "../../../frontend/src/lib/transcriptTiming";
import { restoreCaptionLines } from "./captionLines";

// Synthetic selections as Chrome's selectionText gives them: the transcript panel's line breaks
// collapsed to single spaces. YouTube writes M:SS with captions a second or two apart, Loom MM:SS
// with one timestamp per paragraph.
const YOUTUBE_FROM_MID_VIDEO =
  "9:58 So the first thing we do is open the settings 9:59 page and look for the export button. " +
  "10:01 The meeting starts at 9:30. 10:03 so please be on time, 10:04 and we start at 09:30 sharp. " +
  "10:06 That's it for today.";
const YOUTUBE_RESTORED = [
  "9:58",
  "So the first thing we do is open the settings",
  "9:59",
  "page and look for the export button.",
  "10:01",
  "The meeting starts at 9:30.",
  "10:03",
  "so please be on time,",
  "10:04",
  "and we start at 09:30 sharp.",
  "10:06",
  "That's it for today.",
].join("\n");
const YOUTUBE_CLOSE = "0:00 Generally, if somebody's trying to 0:01 make a company work, 0:03 they should expect to 0:04 grind hard.";
const LOOM =
  "00:00 Hi everyone, in this video I'll walk you through the new dashboard and where to find the reports " +
  "that the team asked for last week. 00:23 First, open the reports tab. You'll see three filters at the top, " +
  "and the date filter starts at 9:30 by default. 00:38 Finally, export the report as a CSV file and share it.";

describe("restoreCaptionLines", () => {
  it("puts YouTube's timestamps back on their own lines, from the middle of the video, keeping the times that are spoken", () => {
    // The reported problem: as one line, the timed parser finds no timestamps at all.
    expect(analyzeTranscriptTiming(YOUTUBE_FROM_MID_VIDEO)).toEqual({ kind: "none" });
    const result = restoreCaptionLines(YOUTUBE_FROM_MID_VIDEO);
    expect(result).toEqual({ kind: "restored", text: YOUTUBE_RESTORED });
    // The shared timed parser reads it: First/Last come from the first and last caption of the selection.
    expect(analyzeTranscriptTiming(YOUTUBE_RESTORED)).toEqual({ kind: "timed", captions: 6, first: 598, last: 606 });
  });

  it("reads YouTube captions one second apart", () => {
    const result = restoreCaptionLines(YOUTUBE_CLOSE);
    expect(result.kind).toBe("restored");
    const text = result.kind === "restored" ? result.text : "";
    expect(text.split("\n")).toEqual([
      "0:00",
      "Generally, if somebody's trying to",
      "0:01",
      "make a company work,",
      "0:03",
      "they should expect to",
      "0:04",
      "grind hard.",
    ]);
    expect(analyzeTranscriptTiming(text)).toEqual({ kind: "timed", captions: 4, first: 0, last: 4 });
  });

  it("reads Loom's MM:SS paragraphs, and an unpadded time in the words is not a timestamp", () => {
    const result = restoreCaptionLines(LOOM);
    expect(result.kind).toBe("restored");
    const text = result.kind === "restored" ? result.text : "";
    const lines = text.split("\n");
    expect(lines.filter((_, index) => index % 2 === 0)).toEqual(["00:00", "00:23", "00:38"]);
    expect(lines[3]).toContain("the date filter starts at 9:30 by default.");
    expect(analyzeTranscriptTiming(text)).toEqual({ kind: "timed", captions: 3, first: 0, last: 38 });
  });

  it("keeps punctuation, milliseconds, hours and partly kept line breaks", () => {
    expect(restoreCaptionLines("0:05 Welcome back, (really). 0:21 That's the whole tour!")).toEqual({
      kind: "restored",
      text: "0:05\nWelcome back, (really).\n0:21\nThat's the whole tour!",
    });
    expect(restoreCaptionLines("0:10.480 Welcome back. 0:12.960 Gradient descent.")).toEqual({
      kind: "restored",
      text: "0:10.480\nWelcome back.\n0:12.960\nGradient descent.",
    });
    expect(restoreCaptionLines("59:58 A long video. 1:00:03 Still here.")).toEqual({
      kind: "restored",
      text: "59:58\nA long video.\n1:00:03\nStill here.",
    });
    expect(restoreCaptionLines("0:05 First caption.\n0:21 Last caption.")).toEqual({
      kind: "restored",
      text: "0:05\nFirst caption.\n0:21\nLast caption.",
    });
  });

  it("leaves text without timestamps, or with a single time in the words, alone", () => {
    expect(restoreCaptionLines("Just a paragraph of notes.")).toEqual({ kind: "none" });
    expect(restoreCaptionLines("The meeting starts at 9:30 every day.")).toEqual({ kind: "none" });
  });

  it("leaves text the timed parser already reads (lines kept, SRT, or an error it reports) to the parser", () => {
    expect(restoreCaptionLines("0:05\nFirst caption.\n0:21\nLast caption.")).toEqual({ kind: "none" });
    expect(restoreCaptionLines("1\n00:00:01,000 --> 00:00:04,000\nHello 0:05 there 0:09 you")).toEqual({ kind: "none" });
    expect(restoreCaptionLines("0:00\nA.\n0:05\nB.\n0:03\nC.")).toEqual({ kind: "none" });
  });

  it.each([
    ["a single timestamp", "0:19 Hello there, everyone."],
    ["an invalid timestamp", "0:19 Hello 0:75 everyone, welcome."],
    ["a ratio among the words", "0:19 The aspect ratio is 16:9 here. 0:22 And that is all."],
    ["a time in the words that breaks the order", "0:24 The meeting starts at 9:30 sharp 0:27 so be on time."],
    ["a time in the words after the last caption, far too late for it", "1:20 We meet at 9:30 every day."],
    ["mixed notations after a first timestamp that fits both", "12:30 We start at 09:30 every day 12:33 and 9:45 too."],
    ["text before the first timestamp", "the settings 0:20 page and look 0:22 for the button."],
    ["a timestamp without text after it", "0:19 Open the settings 0:22"],
    ["no time span", "0:04 One caption. 0:04 Another one."],
    ["timestamps going backwards", "0:05 One. 0:03 Two. 0:07 Three."],
  ])("keeps %s as sent", (_, text) => {
    expect(restoreCaptionLines(text)).toEqual({ kind: "kept" });
  });

  it.each([
    // PR #55 review (P2): 9:20 and 9:40 are captions, 9:30 is when they meet. Nothing in one line of
    // text tells that apart from three captions, so the whole selection is kept, never re-timed.
    ["M:SS", "9:20 We meet at 9:30 every day. 9:40 Bring your notes."],
    ["MM:SS (Loom)", "09:20 We meet at 09:30 every day. 09:40 Bring your notes."],
    ["MM:SS (YouTube past ten minutes)", "10:20 We open at 10:30 every day. 10:40 Bring your notes."],
    ["a time followed by a.m.", "9:20 The bus leaves 9:30 a.m. daily. 9:40 Bring your notes."],
    ["a time followed by sharp", "09:20 Doors open 09:30 sharp, 09:40 so come early."],
    // The cost of the rule: a real caption that ends in "at" is kept too (Copy -> Paste still works).
    ["a caption ending in at", "0:04 Now look at 0:06 the dashboard."],
  ])("keeps a selection with a spoken time in the timestamps' notation as sent: %s", (_, text) => {
    expect(restoreCaptionLines(text)).toEqual({ kind: "kept" });
  });

  it("restores the captions and keeps a spoken time that cannot be a timestamp, in M:SS and MM:SS", () => {
    expect(restoreCaptionLines("9:20 We meet at 9:30. 9:40 Bring your notes.")).toEqual({
      kind: "restored",
      text: "9:20\nWe meet at 9:30.\n9:40\nBring your notes.",
    });
    expect(restoreCaptionLines("09:20 We meet at 09:30. 09:40 Bring your notes.")).toEqual({
      kind: "restored",
      text: "09:20\nWe meet at 09:30.\n09:40\nBring your notes.",
    });
  });

  it("refuses a caption far too short for the time until the next timestamp", () => {
    // Two words: at most 30 s + 2 x 2 s before the next timestamp.
    expect(restoreCaptionLines("0:00 one two 0:34 three")).toMatchObject({ kind: "restored" });
    expect(restoreCaptionLines("0:00 one two 0:35 three")).toEqual({ kind: "kept" });
  });
});
