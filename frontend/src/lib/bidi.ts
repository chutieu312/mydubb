/**
 * Runs of Latin text (English terms, code, paths, URLs) inside a right-to-left translation.
 *
 * In an Arabic paragraph the browser's bidirectional algorithm gives the neutral and weak
 * characters of a Latin token (the "/" of "/api/v1", the "?" and "&" of a query, a "\", digits
 * between slashes) the paragraph's direction, so "/api/v1" shows as "api/v1/" and a URL or a
 * Windows path is shuffled. Each Latin token is therefore shown whole in its own left-to-right
 * isolate:
 *
 * - A token is a maximal run of printable ASCII and Latin letters (no spaces), so a URL, a path or
 *   an identifier is never split; Arabic letters or punctuation glued to it (`وDocker`, `API،`)
 *   stay outside.
 * - Opening brackets/quotes at its start and sentence punctuation or closing brackets/quotes at its
 *   end stay outside too, so they follow the Arabic sentence (`/api/v1.` isolates `/api/v1`).
 * - Only a token holding a Latin letter is isolated; numbers such as "1,024" or "50%" are left to
 *   the browser. Tokens separated by single spaces form one isolate ("REST API").
 *
 * The text is never changed: the pieces joined are the input. Limit: a URL that really ends with
 * ")" or "." loses that character to the Arabic side.
 */

export interface BidiPiece {
  text: string;
  ltr: boolean;
}

const TOKEN = /[!-~À-ɏ]+/g;
const LEADING = /^[([{"'<]+/;
const TRAILING = /[.,:;!?)\]}"'>]+$/;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;

export function ltrRuns(text: string): BidiPiece[] {
  const runs: [number, number][] = [];
  for (const match of text.matchAll(TOKEN)) {
    const lead = LEADING.exec(match[0])?.[0].length ?? 0;
    const core = match[0].slice(lead).replace(TRAILING, "");
    if (!LATIN_LETTER.test(core)) continue;
    const start = match.index + lead;
    const end = start + core.length;
    const previous = runs.at(-1);
    if (previous && text.slice(previous[1], start) === " ") previous[1] = end;
    else runs.push([start, end]);
  }
  const pieces: BidiPiece[] = [];
  let position = 0;
  for (const [start, end] of runs) {
    if (start > position) pieces.push({ text: text.slice(position, start), ltr: false });
    pieces.push({ text: text.slice(start, end), ltr: true });
    position = end;
  }
  if (position < text.length) pieces.push({ text: text.slice(position), ltr: false });
  return pieces;
}
