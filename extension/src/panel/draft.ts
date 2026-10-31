// Decisions about the transcript draft, kept pure so they can be tested without Chrome.

import type { DraftRecord, PendingSelection } from "../shared/messages";

export type PendingDecision =
  | { action: "replace" }
  | { action: "confirm" }
  | { action: "reject"; reason: "empty" | "too-long" | "other-lesson" };

export function isEdited(draft: DraftRecord | null): boolean {
  return !!draft && draft.text.trim() !== "" && draft.text !== draft.baseline;
}

/** What to do with a selection sent from the page, given the draft and the lecture now shown. */
export function decidePending(
  draft: DraftRecord | null,
  pending: PendingSelection,
  currentLessonKey: string | null,
): PendingDecision {
  if (pending.problem === "too-long") return { action: "reject", reason: "too-long" };
  if (pending.problem === "empty" || pending.text.trim() === "") return { action: "reject", reason: "empty" };
  if (pending.lessonKey && currentLessonKey && pending.lessonKey !== currentLessonKey) {
    return { action: "reject", reason: "other-lesson" };
  }
  return isEdited(draft) ? { action: "confirm" } : { action: "replace" };
}

/** The draft to store when a selection is accepted. */
export function draftFromSelection(pending: PendingSelection, currentLessonKey: string | null): DraftRecord {
  return { lessonKey: pending.lessonKey ?? currentLessonKey, text: pending.text, baseline: pending.text };
}

/** True when a stored draft belongs to a different lecture than the one now linked. */
export function draftIsStale(draft: DraftRecord | null, currentLessonKey: string | null): boolean {
  return !!draft && !!draft.lessonKey && !!currentLessonKey && draft.lessonKey !== currentLessonKey;
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
