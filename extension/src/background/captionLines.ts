// Chrome hands the context menu's selection (selectionText) over with its whitespace collapsed, so
// a transcript selected in YouTube's or Loom's panel arrives as one line:
//
//   "0:19 The meeting starts at 9:30. 0:22 Please be on time."
//
// The timed parser (frontend/src/lib/transcriptTiming.ts, backend/app/transcript/timed.py) only
// reads a timestamp that stands on its own line. restoreCaptionLines puts each caption timestamp
// back on its own line, in exactly that format, but only when the whole text supports it; anything
// less certain is kept as Chrome sent it, so a time that is part of the spoken words is never
// removed and no timing is guessed. The parser itself is unchanged and decides as before.

import { LOOSE_STAMP, analyzeTranscriptTiming, parseStamp } from "../../../frontend/src/lib/transcriptTiming";

/**
 * The longest time a caption may cover before the next timestamp: this pause plus
 * MAX_SECONDS_PER_WORD for every word of its text. Speech runs at about 0.4 s a word, so only a
 * jump no caption could fill fails it, as when the next "timestamp" is a time someone said
 * ("we meet at 9:30"), far after the captions around it.
 */
export const MAX_CAPTION_PAUSE_SECONDS = 30;
export const MAX_SECONDS_PER_WORD = 2;

/**
 * Words that mark a time as said, not as a caption start: "at 9:30", "until 10:15", "9:30 am",
 * "9:30 sharp". Nothing else in a one-line text tells "9:20 We meet at 9:30 every day. 9:40 ..."
 * (9:30 spoken) from three captions, so such a selection is kept as sent instead of guessed. The
 * cost is that a caption ending in one of these words ("look at" / 0:05) is kept too; Copy -> Paste
 * still works there. Compared without case and punctuation.
 */
const CLOCK_BEFORE = new Set(["at", "by", "from", "until", "till", "til", "around", "since", "past"]);
const CLOCK_AFTER = new Set(["am", "pm", "oclock", "sharp"]);
const bare = (word: string | undefined): string => (word ?? "").toLowerCase().replace(/[^a-z]/g, "");

export type CaptionLines =
  /** The timestamps were put back on their own lines: `text` is what the timed parser reads. */
  | { kind: "restored"; text: string }
  /** The text has timestamp-like words that cannot be told apart from speech safely: kept as sent. */
  | { kind: "kept" }
  /** Nothing to restore: no timestamps, or the text already has a structure the parser reads. */
  | { kind: "none" };

/** "0:19" and "10:05" (YouTube) against "00:19" (Loom): one transcript writes one of them. */
function notation(stamp: string): "unpadded" | "padded" | "either" {
  const lead = stamp.split(":")[0] ?? "";
  if (lead.length === 1) return "unpadded";
  return lead.startsWith("0") ? "padded" : "either";
}

export function restoreCaptionLines(text: string): CaptionLines {
  // Line breaks the parser already reads (timed, SRT/WebVTT, or an error it reports) stay as they are.
  if (analyzeTranscriptTiming(text).kind !== "none") return { kind: "none" };
  const words = text.split(/\s+/).filter((word) => word !== "");
  const stamps = words.flatMap((word, index) => (LOOSE_STAMP.test(word) ? [index] : []));
  if (stamps.length === 0 || (stamps.length === 1 && stamps[0] !== 0)) return { kind: "none" };
  const restored = captionText(words, stamps);
  return restored === null ? { kind: "kept" } : { kind: "restored", text: restored };
}

/**
 * The transcript with one timestamp line before each caption's text, or null unless every
 * timestamp-shaped word reads as a caption start: the text starts with one, all are valid, each has
 * text after it, they never go back, and no caption is far too short for the time until the next
 * one, and none reads as a spoken time (CLOCK_BEFORE / CLOCK_AFTER). A transcript writes its
 * timestamps one way, so a word in the other notation than the first timestamp ("9:30" in Loom's
 * "00:23" captions, "09:30" in YouTube's "0:19") is spoken text. A word such as "9:30." or "(0:05)"
 * is not timestamp-shaped and stays in the text too.
 *
 * A limit that stays: a spoken time with none of these cues, written like the timestamps, between
 * two of them and at a plausible pace ("9:20 We meet 9:30 every day. 9:40 ...") cannot be told apart
 * from a caption start in one line of text; it is restored as one. Only the page's own selection
 * (line breaks kept) removes that doubt.
 */
function captionText(words: string[], shaped: number[]): string | null {
  if (shaped[0] !== 0) return null;
  const form = notation(words[0]!);
  const other = form === "padded" ? "unpadded" : form === "unpadded" ? "padded" : null;
  const stamps = shaped.filter((index) => notation(words[index]!) !== other);
  const forms = new Set(stamps.map((index) => notation(words[index]!)));
  if (stamps.length < 2 || (forms.has("unpadded") && forms.has("padded"))) return null;

  const lines: string[] = [];
  for (let n = 0; n < stamps.length; n += 1) {
    const at = stamps[n]!;
    const end = stamps[n + 1] ?? words.length;
    const caption = words.slice(at + 1, end);
    const start = parseStamp(words[at]!);
    if (start === null || caption.length === 0) return null;
    if (CLOCK_BEFORE.has(bare(words[at - 1])) || CLOCK_AFTER.has(bare(words[at + 1]))) return null;
    if (n + 1 < stamps.length) {
      const next = parseStamp(words[end]!);
      if (next === null || next < start) return null;
      if ((next - start) / 1000 > MAX_CAPTION_PAUSE_SECONDS + MAX_SECONDS_PER_WORD * caption.length) return null;
    }
    lines.push(words[at]!, caption.join(" "));
  }
  const restored = lines.join("\n");
  // The shared parser has the last word: the result must be a valid timed transcript.
  return analyzeTranscriptTiming(restored).kind === "timed" ? restored : null;
}
