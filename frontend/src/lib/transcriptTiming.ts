// Recognizes a timed (YouTube-style) transcript for instant feedback and to fill the two start
// times. Mirrors backend/app/transcript/timed.py; the server is authoritative and validates the
// transcript again (a timed job with an invalid structure is rejected, never processed as plain).

export type TranscriptTiming =
  // No timestamps on their own lines: the current plain flow.
  | { kind: "none" }
  // SRT or WebVTT: accepted and cleaned, but their timing is not used yet (plain flow).
  | { kind: "cues" }
  // `first` / `last`: the first and last caption start, in seconds with millisecond precision.
  | { kind: "timed"; captions: number; first: number; last: number }
  | { kind: "invalid"; message: string };

const LOOSE_STAMP = /^\d{1,2}(?::\d{1,2}){1,2}(?:[.,]\d+)?$/;
// Whole seconds as pasted from YouTube's panel, or ".mmm" as written by the caption import.
const M_SS = /^(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?$/;
const H_MM_SS = /^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/;

/** The time in whole milliseconds, or null when it is not a valid caption time. */
function parseStamp(text: string): number | null {
  const long = H_MM_SS.exec(text);
  const short = long ? null : M_SS.exec(text);
  const parts = long ?? (short ? [short[0], "0", short[1], short[2], short[3]] : null);
  if (!parts) return null;
  const [, hours, minutes, seconds, fraction] = parts;
  const millis = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + millis;
}

/** "0:05", "12:30", "1:02:03", "0:10.480": how the transcript writes its times. */
export function captionClock(seconds: number): string {
  const millis = Math.round(seconds * 1000);
  const whole = Math.floor(millis / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  const fraction = millis % 1000 ? `.${String(millis % 1000).padStart(3, "0")}` : "";
  const clock =
    hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
  return clock + fraction;
}

export function analyzeTranscriptTiming(raw: string): TranscriptTiming {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  const firstLine = lines.find((line) => line !== "") ?? "";
  if (firstLine.startsWith("WEBVTT") || lines.some((line) => line.includes("-->"))) {
    return { kind: "cues" };
  }
  if (lines.filter((line) => LOOSE_STAMP.test(line)).length < 2) return { kind: "none" };

  const starts: number[] = [];
  let pending: { line: number; seconds: number } | null = null;
  let hasText = false;
  const close = (): string | null => {
    if (pending === null) return null;
    if (!hasText) return `The timestamp on line ${pending.line} has no caption text after it.`;
    starts.push(pending.seconds);
    return null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "") continue;
    const number = index + 1;
    if (LOOSE_STAMP.test(line)) {
      const seconds = parseStamp(line);
      if (seconds === null) {
        return {
          kind: "invalid",
          message: `Line ${number} (${line}) is not a valid timestamp. Use M:SS or H:MM:SS with minutes and seconds from 00 to 59, optionally with milliseconds (0:05.480).`,
        };
      }
      const problem = close();
      if (problem) return { kind: "invalid", message: problem };
      pending = { line: number, seconds };
      hasText = false;
    } else if (pending === null) {
      return {
        kind: "invalid",
        message: `Line ${number} has text before the first timestamp, so its time is unknown.`,
      };
    } else {
      hasText = true;
    }
  }
  const problem = close();
  if (problem) return { kind: "invalid", message: problem };

  for (let index = 1; index < starts.length; index += 1) {
    const before = starts[index - 1] ?? 0;
    const after = starts[index] ?? 0;
    if (after < before) {
      return {
        kind: "invalid",
        message: `The timestamps go backwards (${captionClock(before / 1000)} is followed by ${captionClock(after / 1000)}).`,
      };
    }
  }
  const first = starts[0] ?? 0;
  const last = starts[starts.length - 1] ?? 0;
  if (last <= first) {
    return {
      kind: "invalid",
      message:
        "The last caption starts at the same time as the first one, so there is no time span to place the audio in.",
    };
  }
  return { kind: "timed", captions: starts.length, first: first / 1000, last: last / 1000 };
}
