// Decisions about the transcript draft, kept pure so they can be tested without Chrome.

import type { DraftRecord, PendingSelection } from "../shared/messages";

export type PendingDecision =
  | { action: "replace" }
  | { action: "confirm" }
  | { action: "reject"; reason: "empty" | "too-long" | "other-lesson" };

/**
 * The lecture the linked tab shows: a lecture key, null once the tab is confirmed to be on a page
 * that is not a lecture, or undefined while no page state has arrived yet (unknown).
 */
export type CurrentLesson = string | null | undefined;

/** True when something tied to `lessonKey` does not belong to the lecture now shown. */
export function belongsElsewhere(lessonKey: string | null, current: CurrentLesson): boolean {
  return lessonKey !== null && current !== undefined && lessonKey !== current;
}

export function isEdited(draft: DraftRecord | null): boolean {
  return !!draft && draft.text.trim() !== "" && draft.text !== draft.baseline;
}

/** What to do with a selection sent from the page, given the draft and the lecture now shown. */
export function decidePending(
  draft: DraftRecord | null,
  pending: PendingSelection,
  current: CurrentLesson,
): PendingDecision {
  if (pending.problem === "too-long") return { action: "reject", reason: "too-long" };
  if (pending.problem === "empty" || pending.text.trim() === "") return { action: "reject", reason: "empty" };
  if (belongsElsewhere(pending.lessonKey, current)) {
    return { action: "reject", reason: "other-lesson" };
  }
  return isEdited(draft) ? { action: "confirm" } : { action: "replace" };
}

/** The draft to store when a selection is accepted. */
export function draftFromSelection(pending: PendingSelection, currentLessonKey: string | null): DraftRecord {
  return { lessonKey: pending.lessonKey ?? currentLessonKey, text: pending.text, baseline: pending.text };
}

/**
 * True when a draft belongs to another lecture than the one now shown, including when the tab is
 * known to have left the lecture. Checked on every page state, not only the first.
 */
export function draftIsStale(draft: DraftRecord | null, current: CurrentLesson): boolean {
  return !!draft && belongsElsewhere(draft.lessonKey, current);
}

export function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
