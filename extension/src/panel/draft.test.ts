import { describe, expect, it } from "vitest";
import type { PendingSelection } from "../shared/messages";
import { decidePending, draftFromSelection, draftIsStale, formatTime, isEdited } from "./draft";

const pending = (text: string, lessonKey: string | null = "c/1", problem: PendingSelection["problem"] = null) => ({
  id: "p",
  text,
  problem,
  lessonKey,
  at: 0,
});

describe("decidePending", () => {
  it("replaces an empty or unedited draft directly", () => {
    expect(decidePending(null, pending("new"), "c/1")).toEqual({ action: "replace" });
    expect(decidePending({ lessonKey: "c/1", text: "old", baseline: "old" }, pending("new"), "c/1")).toEqual({
      action: "replace",
    });
  });

  it("asks before replacing an edited draft", () => {
    expect(decidePending({ lessonKey: "c/1", text: "old, edited", baseline: "old" }, pending("new"), "c/1")).toEqual({
      action: "confirm",
    });
  });

  it("rejects empty, oversized and other-lecture selections", () => {
    expect(decidePending(null, pending(" \n"), "c/1")).toEqual({ action: "reject", reason: "empty" });
    expect(decidePending(null, pending("", "c/1", "too-long"), "c/1")).toEqual({ action: "reject", reason: "too-long" });
    expect(decidePending(null, pending("x", "c/2"), "c/1")).toEqual({ action: "reject", reason: "other-lesson" });
  });

  it("accepts when either lecture is still unknown", () => {
    expect(decidePending(null, pending("x", null), "c/1")).toEqual({ action: "replace" });
    expect(decidePending(null, pending("x"), undefined)).toEqual({ action: "replace" });
  });

  it("rejects a lecture's selection once the tab has left that lecture", () => {
    expect(decidePending(null, pending("x", "c/1"), null)).toEqual({ action: "reject", reason: "other-lesson" });
    expect(decidePending(null, pending("x", null), null)).toEqual({ action: "replace" });
  });
});

describe("draft helpers", () => {
  it("keeps the selection text exactly", () => {
    const text = "  a\n\tb <i>c</i>  ";
    expect(draftFromSelection(pending(text), null)).toEqual({ lessonKey: "c/1", text, baseline: text });
  });

  it("treats a blanked draft as not edited", () => {
    expect(isEdited({ lessonKey: null, text: "  ", baseline: "x" })).toBe(false);
  });

  it("detects a draft from another lecture", () => {
    expect(draftIsStale({ lessonKey: "c/1", text: "x", baseline: "x" }, "c/2")).toBe(true);
    expect(draftIsStale({ lessonKey: "c/1", text: "x", baseline: "x" }, "c/1")).toBe(false);
    expect(draftIsStale({ lessonKey: null, text: "x", baseline: "x" }, "c/2")).toBe(false);
    // Confirmed non-lecture page: the draft no longer belongs here. Unknown state: keep it.
    expect(draftIsStale({ lessonKey: "c/1", text: "x", baseline: "x" }, null)).toBe(true);
    expect(draftIsStale({ lessonKey: "c/1", text: "x", baseline: "x" }, undefined)).toBe(false);
  });

  it("formats times", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.9)).toBe("1:05");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(null)).toBe("--:--");
    expect(formatTime(NaN)).toBe("--:--");
  });
});
