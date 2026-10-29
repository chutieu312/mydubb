/**
 * Runs of Latin text (English terms, code, paths) inside a right-to-left translation.
 *
 * In an Arabic paragraph the browser's bidirectional algorithm orders Latin letters correctly but
 * gives the neutral characters at the edge of a run (the "/" of "/api/v1", a "+" or "#") the
 * paragraph's direction, so "/api/v1" shows as "api/v1/". Each run is therefore shown in its own
 * left-to-right isolate. A run starts with a Latin letter, or with the start of a path just
 * before one (/ ~/ ./ ../ ~/. and a leading dot), continues over Latin letters, digits and code
 * punctuation, and over single spaces between such words ("REST API"); punctuation that ends the
 * sentence is left to the Arabic text. The text is never changed: the pieces joined are the input.
 */

export interface BidiPiece {
  text: string;
  ltr: boolean;
}

const START = String.raw`(?:~|\.{1,2})?\/?\.?[A-Za-z]`;
const WORD = String.raw`${START}[\w./:@~+#%-]*`;
const RUN = new RegExp(`${WORD}(?: ${WORD})*`, "g");
const TRAILING = /[.,:;!?]+$/;

export function ltrRuns(text: string): BidiPiece[] {
  const pieces: BidiPiece[] = [];
  let position = 0;
  for (const match of text.matchAll(RUN)) {
    const start = match.index;
    const run = match[0].replace(TRAILING, "");
    if (start > position) pieces.push({ text: text.slice(position, start), ltr: false });
    pieces.push({ text: run, ltr: true });
    position = start + run.length;
  }
  if (position < text.length) pieces.push({ text: text.slice(position), ltr: false });
  return pieces;
}
