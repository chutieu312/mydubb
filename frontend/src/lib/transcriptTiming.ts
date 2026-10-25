// Recognizes a timed (YouTube-style) transcript for instant feedback and to fill the two start
// times. Mirrors backend/app/transcript/timed.py; the server is authoritative and validates the
// transcript again (a timed job with an invalid structure is rejected, never processed as plain).

export type TranscriptTiming =
  // No timestamps on their own lines: the current plain flow.
  | { kind: "none" }
  // SRT or WebVTT: accepted and cleaned, but their timing is not used yet (plain flow).
  | { kind: "cues" }
  | { kind: "timed"; captions: number; first: number; last: number }
  | { kind: "invalid"; message: string };

const LOOSE_STAMP = /^\d{1,2}(?::\d{1,2}){1,2}(?:[.,]\d+)?$/;
const M_SS = /^(\d{1,2}):([0-5]\d)$/;
const H_MM_SS = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;

function parseStamp(text: string): number | null {
  const long = H_MM_SS.exec(text);
  if (long) return Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]);
  const short = M_SS.exec(text);
  if (short) return Number(short[1]) * 60 + Number(short[2]);
  return null;
}

/** "0:05", "12:30", "1:02:03": how the transcript writes its times. */
export function captionClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
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
          message: `Line ${number} (${line}) is not a valid timestamp. Use M:SS or H:MM:SS with minutes and seconds from 00 to 59.`,
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
        message: `The timestamps go backwards (${captionClock(before)} is followed by ${captionClock(after)}).`,
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
  return { kind: "timed", captions: starts.length, first, last };
}
