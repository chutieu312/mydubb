import { describe, expect, it } from "vitest";
import { parseLecture } from "./lesson";
import { isCommandMessage, isContentToPanel, isOwnExtensionPage, isSelectionReply } from "./messages";

describe("parseLecture", () => {
  it("accepts only Udemy lecture URLs", () => {
    expect(parseLecture("https://www.udemy.com/course/react-x/learn/lecture/123#overview", "T")).toEqual({
      key: "react-x/123",
      courseSlug: "react-x",
      lectureId: "123",
      title: "T",
    });
    expect(parseLecture("https://www.udemy.com/course/react-x/learn/quiz/5")).toBeNull();
    expect(parseLecture("https://www.udemy.com/course/react-x/")).toBeNull();
    expect(parseLecture("https://udemy.com.evil.example/course/a/learn/lecture/1")).toBeNull();
    expect(parseLecture("http://www.udemy.com/course/a/learn/lecture/1")).toBeNull();
    expect(parseLecture("not a url")).toBeNull();
  });
});

describe("validators", () => {
  const base = { type: "command", requestId: 1, lessonKey: "c/1", videoId: 1 };

  it("accepts only the three known commands with sane deltas", () => {
    expect(isCommandMessage({ ...base, command: "play" })).toBe(true);
    expect(isCommandMessage({ ...base, command: "seek", delta: -5 })).toBe(true);
    expect(isCommandMessage({ ...base, command: "seek", delta: 61 })).toBe(false);
    expect(isCommandMessage({ ...base, command: "seek", delta: Number.NaN })).toBe(false);
    expect(isCommandMessage({ ...base, command: "seek" })).toBe(false);
    expect(isCommandMessage({ ...base, command: "play", delta: 5 })).toBe(false);
    expect(isCommandMessage({ ...base, command: "volume" })).toBe(false);
    expect(isCommandMessage({ ...base, command: "play", lessonKey: "" })).toBe(false);
    expect(isCommandMessage(null)).toBe(false);
  });

  it("validates selection replies and state messages", () => {
    expect(isSelectionReply({ type: "mydubb:selection", text: "a", tooLong: false, lesson: null })).toBe(true);
    expect(isSelectionReply({ type: "mydubb:selection", text: "a", tooLong: false, lesson: { key: "x" } })).toBe(false);
    const state = { lesson: null, online: true, video: { status: "none" } };
    expect(isContentToPanel({ type: "state", state })).toBe(true);
    expect(isContentToPanel({ type: "state", state: { ...state, video: { status: "ready", id: 1 } } })).toBe(false);
  });

  it("recognizes only this extension's panel page as a sender", () => {
    const id = "a".repeat(32);
    const page = `chrome-extension://${id}/sidepanel.html`;
    expect(isOwnExtensionPage({ id, url: `${page}?tabId=1` }, id, page)).toBe(true);
    expect(isOwnExtensionPage({ id: "b".repeat(32), url: page }, id, page)).toBe(false);
    expect(isOwnExtensionPage({ id, url: `chrome-extension://${id}/other.html` }, id, page)).toBe(false);
    expect(isOwnExtensionPage({ id }, id, page)).toBe(false);
    expect(isOwnExtensionPage(undefined, id, page)).toBe(false);
  });
});
