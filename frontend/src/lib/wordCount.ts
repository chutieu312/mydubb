// A preview of the guest word limit. The server counts the text it would translate (timestamps and
// cue markup removed by its own cleaning; backend/app/transcript/words.py) and alone decides; this
// follows the same rule closely enough to warn before submitting, never to refuse.

// A line that is only a time ("0:05", "00:01:02.480", "[00:01]"), a cue timing line or a header.
const STAMP_LINE = /^[[(]?\d{1,2}(?::\d{1,2}){1,2}(?:[.,]\d+)?[\])]?$/;
const NOT_SPOKEN = (line: string) =>
  STAMP_LINE.test(line) || line.includes("-->") || line.startsWith("WEBVTT");
// A word has at least one letter or digit; a lone dash or bullet is not one.
const WORD = /[\p{L}\p{N}]/u;

export function previewWordCount(transcript: string): number {
  let count = 0;
  for (const raw of transcript.split(/\r\n?|\n/)) {
    const line = raw.trim();
    if (line === "" || NOT_SPOKEN(line)) continue;
    for (const token of line.split(/\s+/)) if (WORD.test(token)) count += 1;
  }
  return count;
}
