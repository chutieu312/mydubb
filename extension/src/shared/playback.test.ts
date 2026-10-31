import { describe, expect, it } from "vitest";

import {
  choicesLabel,
  clampPosition,
  isAudioTransfer,
  isPageToPlayer,
  isPanelToPlayer,
  isPlaybackLinkMessage,
  isPlayerToPage,
  isVideoCommand,
  isWorkerToPlayer,
} from "./playback";

const OWNER = { userId: "u1", connectionId: "c1", jobId: "j1", operationId: "o1" };
const CHOICES = { languageLabel: "Vietnamese", voiceLabel: "Andrew", speed: 1.5 };

describe("message validators", () => {
  it("accepts the panel's messages and bounded commands only", () => {
    expect(isPanelToPlayer({ type: "watch", tabId: 3 })).toBe(true);
    expect(isPanelToPlayer({ type: "open", tabId: 3, transferId: "t", lessonKey: "c/1", owner: OWNER, choices: CHOICES, sync: null })).toBe(true);
    expect(isPanelToPlayer({ type: "open", tabId: 3, transferId: "t", lessonKey: "c/1", owner: { ...OWNER, jobId: "" }, choices: CHOICES, sync: null })).toBe(false);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "play" })).toBe(true);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "play", value: 1 })).toBe(false);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "seek-by", value: 5 })).toBe(true);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "seek-by", value: 0 })).toBe(false);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "seek-by", value: 61 })).toBe(false);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "seek-to", value: -1 })).toBe(false);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "seek-to", value: Number.NaN })).toBe(false);
    expect(isPanelToPlayer({ type: "command", tabId: 3, sessionId: "s", command: "volume", value: 0 })).toBe(false);
    expect(isPanelToPlayer({ type: "command", tabId: -1, sessionId: "s", command: "play" })).toBe(false);
    expect(isPanelToPlayer({ type: "end", tabId: 3, sessionId: null })).toBe(true);
    expect(isPanelToPlayer({ type: "floating", tabId: 3, sessionId: "s", visible: "yes" })).toBe(false);
  });

  it("accepts the page's messages only with a session and lecture", () => {
    expect(isPageToPlayer({ type: "hello", lessonKey: "c/1" })).toBe(true);
    expect(isPageToPlayer({ type: "hello", lessonKey: "" })).toBe(false);
    expect(isPageToPlayer({ type: "command", sessionId: "s", lessonKey: "c/1", command: "pause" })).toBe(true);
    expect(isPageToPlayer({ type: "command", lessonKey: "c/1", command: "pause" })).toBe(false);
    expect(isPageToPlayer({ type: "close", sessionId: "s", lessonKey: "c/1" })).toBe(true);
    expect(isPageToPlayer({ type: "lesson", lessonKey: null })).toBe(true);
    expect(isPageToPlayer({ type: "open", tabId: 3 })).toBe(false);
    expect(isPlaybackLinkMessage({ type: "playback-link", lessonKey: "c/1" })).toBe(true);
    expect(isPlaybackLinkMessage({ type: "playback-link" })).toBe(false);
  });

  it("checks the worker's and the document's messages", () => {
    expect(isWorkerToPlayer({ type: "mydubb:player-identity", connectionId: null })).toBe(true);
    expect(isWorkerToPlayer({ type: "mydubb:player-tab-closed", tabId: 2 })).toBe(true);
    expect(isWorkerToPlayer({ type: "mydubb:player-tab-closed", tabId: "2" })).toBe(false);
    expect(isPlayerToPage({ type: "ended" })).toBe(true);
    expect(isPlayerToPage({ type: "view", view: { sessionId: "s" } })).toBe(false);
  });

  it("accepts an audio Blob within the size limit only", () => {
    expect(isAudioTransfer({ transferId: "t", blob: new Blob(["x"], { type: "audio/mpeg" }) }, 10)).toBe(true);
    expect(isAudioTransfer({ transferId: "t", blob: new Blob(["x"], { type: "text/html" }) }, 10)).toBe(false);
    expect(isAudioTransfer({ transferId: "t", blob: new Blob(["too long"], { type: "audio/mpeg" }) }, 4)).toBe(false);
    expect(isAudioTransfer({ transferId: "t", blob: "data:audio/mpeg;base64,AAAA" }, 10)).toBe(false);
  });
});

describe("helpers", () => {
  it("clamps a position to the audio", () => {
    expect(clampPosition(-3, 30)).toBe(0);
    expect(clampPosition(35, 30)).toBe(30);
    expect(clampPosition(35, null)).toBe(35);
  });

  it("labels the file's choices", () => {
    expect(choicesLabel(CHOICES)).toBe("Vietnamese · Andrew · 1.5x");
    expect(choicesLabel({ ...CHOICES, sourceRange: "00:00:00 → 00:00:23" })).toBe("Vietnamese · Andrew · 1.5x · 00:00:00 → 00:00:23");
  });

  it("the source span is optional in a session's choices (older audio) but bounded text when present", () => {
    const open = (choices: unknown) =>
      isPanelToPlayer({ type: "open", tabId: 3, transferId: "t", lessonKey: "c/1", owner: OWNER, choices, sync: null });
    expect(open({ ...CHOICES, sourceRange: "00:00:00 → 00:00:23" })).toBe(true);
    expect(open(CHOICES)).toBe(true);
    expect(open({ ...CHOICES, sourceRange: "" })).toBe(false);
    expect(open({ ...CHOICES, sourceRange: 5 })).toBe(false);
  });

  it("Sync with video: bounded video operations, replies and events; a span only as numbers", () => {
    const sample = { currentTime: 12.5, paused: false, waiting: false, rate: 1.5, hidden: false };
    const span = { mode: "plain", start: 10, end: 56, baseline: 46, speed: 1.5 };
    expect(isPanelToPlayer({ type: "open", tabId: 3, transferId: "t", lessonKey: "c/1", owner: OWNER, choices: CHOICES, sync: span })).toBe(true);
    expect(isPanelToPlayer({ type: "open", tabId: 3, transferId: "t", lessonKey: "c/1", owner: OWNER, choices: CHOICES, sync: { ...span, end: 5 } })).toBe(false);
    expect(isPanelToPlayer({ type: "open", tabId: 3, transferId: "t", lessonKey: "c/1", owner: OWNER, choices: CHOICES })).toBe(false);
    expect(isPanelToPlayer({ type: "sync", tabId: 3, sessionId: "s", on: true })).toBe(true);
    expect(isPanelToPlayer({ type: "sync", tabId: 3, sessionId: "s", on: "yes" })).toBe(false);
    expect(isPageToPlayer({ type: "sync", sessionId: "s", lessonKey: "c/1", on: false })).toBe(true);
    expect(isPageToPlayer({ type: "sync", sessionId: "s", on: false })).toBe(false);
    expect(isPageToPlayer({ type: "video-reply", syncId: "x", cmdId: 1, ok: true, error: null, video: sample })).toBe(true);
    expect(isPageToPlayer({ type: "video-reply", syncId: "x", cmdId: 1, ok: false, error: "rm -rf", video: null })).toBe(false);
    expect(isPageToPlayer({ type: "video-event", syncId: "x", event: "user-seek", video: sample })).toBe(true);
    expect(isPageToPlayer({ type: "video-event", syncId: "x", event: "anything", video: sample })).toBe(false);
    expect(isPageToPlayer({ type: "video-event", syncId: "x", event: "user-seek", video: { ...sample, currentTime: Number.NaN } })).toBe(false);
    expect(isVideoCommand({ type: "video", syncId: "x", cmdId: 2, op: "attach", start: 10, end: 56, rate: 1.5, time: 10 })).toBe(true);
    expect(isVideoCommand({ type: "video", syncId: "x", cmdId: 2, op: "attach", start: 56, end: 10, rate: 1.5, time: 10 })).toBe(false);
    expect(isVideoCommand({ type: "video", syncId: "x", cmdId: 2, op: "seek", time: -1 })).toBe(false);
    expect(isVideoCommand({ type: "video", syncId: "x", cmdId: 2, op: "eval" })).toBe(false);
    expect(isPlayerToPage({ type: "video", syncId: "x", cmdId: 3, op: "release" })).toBe(true);
  });
});
