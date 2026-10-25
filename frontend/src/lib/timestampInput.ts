// Typing support for the two timestamp fields. The user types digits only and the colons of
// HH:MM:SS appear by themselves ("000001" -> "00:00:01"). Nothing is padded, completed, clamped
// or reordered: "00000" is shown as "00:00:0" and stays invalid until the user finishes it.
//
// Two shapes of text exist:
//  - auto form: up to six digits grouped in pairs ("", "00", "00:0", "01:05:30"). The user edits a
//    stream of digits and the colons are recomputed after every edit.
//  - literal text: anything else, e.g. a pasted "100:05:30" (hours may have more than two digits,
//    see the API contract) or a pasted "abc". It is kept exactly as it is, so nothing is silently
//    cut or reinterpreted; validation then accepts or rejects it as usual.

const MAX_AUTO_DIGITS = 6;
const LONG_HOURS_RE = /^\d{3,}:\d{2}:\d{2}$/;
const ALLOWED_CHARS_RE = /^[\d:]*$/;
const BULK_INPUT_TYPES = new Set(["insertFromPaste", "insertFromDrop", "insertFromYank"]);

export interface TimestampEdit {
  /** The field text before the edit. */
  previous: string;
  /** The field text the browser produced. */
  next: string;
  /** Caret (selectionStart) in `next` after the edit. */
  caret: number;
  /** `InputEvent.inputType`; empty when the event has none (a programmatic change). */
  inputType: string;
  /** `InputEvent.data`: the text that was inserted, if any. */
  data: string | null;
}

export interface TimestampEditResult {
  value: string;
  caret: number;
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** Group up to six digits in pairs: "000001" -> "00:00:01", "000" -> "00:0". */
export function formatTimestampDigits(digits: string): string {
  return digits.match(/.{1,2}/g)?.join(":") ?? "";
}

function isAutoForm(text: string): boolean {
  if (!ALLOWED_CHARS_RE.test(text)) return false;
  const digits = digitsOf(text);
  return digits.length <= MAX_AUTO_DIGITS && text === formatTimestampDigits(digits);
}

function digitsBefore(text: string, caret: number): number {
  return digitsOf(text.slice(0, Math.max(0, caret))).length;
}

/** Caret position right after the `count`-th digit of an auto-form text. */
function caretAfterDigits(formatted: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (formatted[i] !== ":") seen += 1;
    if (seen === count) return i + 1;
  }
  return formatted.length;
}

function fromDigits(digits: string, digitsBeforeCaret: number): TimestampEditResult {
  const value = formatTimestampDigits(digits);
  return { value, caret: caretAfterDigits(value, digitsBeforeCaret) };
}

function keep(edit: TimestampEdit): TimestampEditResult {
  return { value: edit.next, caret: edit.caret };
}

/** A typed key the field does not accept: the text and caret stay as they were. */
function reject(edit: TimestampEdit): TimestampEditResult {
  const insertedLength = edit.data?.length ?? Math.max(0, edit.next.length - edit.previous.length);
  const caret = Math.min(edit.previous.length, Math.max(0, edit.caret - insertedLength));
  return { value: edit.previous, caret };
}

function isBulkInput(edit: TimestampEdit): boolean {
  if (edit.inputType === "") return true;
  if (BULK_INPUT_TYPES.has(edit.inputType)) return true;
  return edit.inputType.startsWith("insert") && (edit.data?.length ?? 0) > 1;
}

function bulk(edit: TimestampEdit): TimestampEditResult {
  const text = edit.next.trim();
  if (ALLOWED_CHARS_RE.test(text)) {
    const digits = digitsOf(text);
    // Only digits, or colons already where the format puts them, are reformatted.
    if (digits.length <= MAX_AUTO_DIGITS && (text === digits || text === formatTimestampDigits(digits))) {
      const value = formatTimestampDigits(digits);
      return { value, caret: value.length };
    }
  }
  return { value: text, caret: text.length };
}

/** Backspace or Delete removed only a colon: remove the neighbouring digit instead. */
function isColonOnlyDeletion(edit: TimestampEdit): boolean {
  return (
    (edit.inputType === "deleteContentBackward" || edit.inputType === "deleteContentForward") &&
    edit.next.length < edit.previous.length &&
    digitsOf(edit.next) === digitsOf(edit.previous)
  );
}

export function editTimestamp(edit: TimestampEdit): TimestampEditResult {
  const { previous, next, caret, inputType } = edit;

  if (isBulkInput(edit)) return bulk(edit);

  // A single typed character that is not a digit or a colon (a colon is accepted and ignored,
  // because colons are automatic).
  if (inputType.startsWith("insert") && edit.data !== null && !ALLOWED_CHARS_RE.test(edit.data)) {
    return reject(edit);
  }

  if (!isAutoForm(previous)) {
    // Literal text is edited as it is. Once only digits remain, auto formatting takes over again.
    if (/^\d*$/.test(next) && next.length <= MAX_AUTO_DIGITS) {
      return fromDigits(next, digitsBefore(next, caret));
    }
    return keep(edit);
  }

  let digits = digitsOf(next);
  let before = digitsBefore(next, caret);

  if (isColonOnlyDeletion(edit)) {
    const index = inputType === "deleteContentBackward" ? before - 1 : before;
    if (index < 0 || index >= digits.length) return { value: previous, caret };
    digits = digits.slice(0, index) + digits.slice(index + 1);
    before = index;
  }

  if (digits.length > MAX_AUTO_DIGITS) {
    // A digit typed into the hours of a complete value makes them longer ("100:00:01").
    // Anywhere else the field is full.
    return LONG_HOURS_RE.test(next) ? keep(edit) : reject(edit);
  }
  return fromDigits(digits, before);
}
