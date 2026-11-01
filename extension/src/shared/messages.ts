// Message contracts between the service worker, the side panel and the content script, with
// validators. Every receiver validates shape and sender before acting; nothing here trusts the page.

import type { LessonInfo } from "./lesson";

export const PANEL_PORT_NAME = "mydubb-panel";
export const MAX_SELECTION_CHARS = 100_000;
export const MAX_SEEK_DELTA_SECONDS = 60;

// ---- Service worker -> content script (chrome.tabs.sendMessage) ----------------------------

export interface GetSelectionRequest {
  type: "mydubb:get-selection";
}

export interface SelectionReply {
  type: "mydubb:selection";
  /** Exactly what the user selected, as plain text (no HTML). Empty when nothing is selected. */
  text: string;
  /** True when the selection exceeded MAX_SELECTION_CHARS; text is then empty (never cut). */
  tooLong: boolean;
  lesson: LessonInfo | null;
}

// ---- Side panel <-> content script (chrome.tabs.connect port) ------------------------------

export type CommandName = "play" | "pause" | "seek";

export interface CommandMessage {
  type: "command";
  requestId: number;
  command: CommandName;
  /** Seconds to move, only for "seek". */
  delta?: number;
  /** The lecture and video the panel was showing when the user clicked. */
  lessonKey: string;
  videoId: number;
}

export type CommandError =
  | "no-video"
  | "stale"
  | "not-ready"
  | "not-seekable"
  | "play-blocked"
  | "play-interrupted"
  | "play-failed"
  | "invalid";

export interface CommandResult {
  type: "result";
  requestId: number;
  ok: boolean;
  error?: CommandError;
}

export type VideoState =
  | { status: "none" }
  | { status: "ambiguous"; candidates: number }
  | {
      status: "ready";
      /** Increments whenever a different <video> element is attached. */
      id: number;
      paused: boolean;
      ended: boolean;
      currentTime: number;
      /** Null while unknown or not finite (e.g. live). */
      duration: number | null;
      seekStart: number | null;
      seekEnd: number | null;
      readyState: number;
      waiting: boolean;
      error: string | null;
    };

export interface PageState {
  lesson: LessonInfo | null;
  online: boolean;
  video: VideoState;
}

export interface StateMessage {
  type: "state";
  state: PageState;
}

export type ContentToPanel = StateMessage | CommandResult;

// ---- Session storage records (chrome.storage.session, trusted contexts only) ---------------

/** A selection delivered by "Send to MyDubb", waiting for the panel to accept it. */
export interface PendingSelection {
  id: string;
  text: string;
  /** Why no text arrived, when text is empty. */
  problem: "empty" | "too-long" | null;
  /** Lecture the selection came from; null when the content script could not be reached. */
  lessonKey: string | null;
  at: number;
}

export interface DraftRecord {
  lessonKey: string | null;
  text: string;
  /** The last selection inserted unchanged; the draft counts as edited when text differs. */
  baseline: string;
}

export const pendingKey = (tabId: number): string => `pending:${tabId}`;
export const draftKey = (tabId: number): string => `draft:${tabId}`;
/** The dubbing settings and start times of the tab's panel (panel/dubbing.ts). */
export const formKey = (tabId: number): string => `form:${tabId}`;
/** The MyDubb job the tab's panel follows (panel/jobs.ts). */
export const jobKey = (tabId: number): string => `job:${tabId}`;
/** The translation of the audio last loaded into the tab's player (panel/dubbing.ts). */
export const loadedKey = (tabId: number): string => `loaded:${tabId}`;
/** Everything the extension keeps for one tab; removed when the tab closes. */
export const tabKeys = (tabId: number): string[] => [
  pendingKey(tabId),
  draftKey(tabId),
  formKey(tabId),
  jobKey(tabId),
  loadedKey(tabId),
];

// ---- Validators ------------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNullableNumber = (v: unknown): v is number | null => v === null || isFiniteNumber(v);
const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

export function isGetSelectionRequest(value: unknown): value is GetSelectionRequest {
  return isObject(value) && value.type === "mydubb:get-selection" && Object.keys(value).length === 1;
}

export function isLessonInfo(value: unknown): value is LessonInfo {
  return (
    isObject(value) &&
    isString(value.key, 250) &&
    isString(value.courseSlug, 200) &&
    isString(value.lectureId, 20) &&
    isString(value.title, 300) &&
    value.key === `${value.courseSlug}/${value.lectureId}`
  );
}

export function isSelectionReply(value: unknown): value is SelectionReply {
  return (
    isObject(value) &&
    value.type === "mydubb:selection" &&
    isString(value.text, MAX_SELECTION_CHARS) &&
    typeof value.tooLong === "boolean" &&
    (value.lesson === null || isLessonInfo(value.lesson))
  );
}

export function isCommandMessage(value: unknown): value is CommandMessage {
  if (!isObject(value) || value.type !== "command") return false;
  if (!Number.isSafeInteger(value.requestId) || !Number.isSafeInteger(value.videoId)) return false;
  if (!isString(value.lessonKey, 250) || value.lessonKey === "") return false;
  if (value.command === "play" || value.command === "pause") return value.delta === undefined;
  if (value.command === "seek") {
    return isFiniteNumber(value.delta) && Math.abs(value.delta) <= MAX_SEEK_DELTA_SECONDS && value.delta !== 0;
  }
  return false;
}

function isVideoState(value: unknown): value is VideoState {
  if (!isObject(value)) return false;
  if (value.status === "none") return true;
  if (value.status === "ambiguous") return Number.isSafeInteger(value.candidates);
  return (
    value.status === "ready" &&
    Number.isSafeInteger(value.id) &&
    typeof value.paused === "boolean" &&
    typeof value.ended === "boolean" &&
    isFiniteNumber(value.currentTime) &&
    isNullableNumber(value.duration) &&
    isNullableNumber(value.seekStart) &&
    isNullableNumber(value.seekEnd) &&
    Number.isSafeInteger(value.readyState) &&
    typeof value.waiting === "boolean" &&
    (value.error === null || isString(value.error, 300))
  );
}

export function isContentToPanel(value: unknown): value is ContentToPanel {
  if (!isObject(value)) return false;
  if (value.type === "result") {
    return Number.isSafeInteger(value.requestId) && typeof value.ok === "boolean";
  }
  if (value.type !== "state" || !isObject(value.state)) return false;
  const state = value.state;
  return (
    (state.lesson === null || isLessonInfo(state.lesson)) &&
    typeof state.online === "boolean" &&
    isVideoState(state.video)
  );
}

export function isPendingSelection(value: unknown): value is PendingSelection {
  return (
    isObject(value) &&
    isString(value.id, 100) &&
    isString(value.text, MAX_SELECTION_CHARS) &&
    (value.problem === null || value.problem === "empty" || value.problem === "too-long") &&
    (value.lessonKey === null || isString(value.lessonKey, 250)) &&
    isFiniteNumber(value.at)
  );
}

export function isDraftRecord(value: unknown): value is DraftRecord {
  return (
    isObject(value) &&
    (value.lessonKey === null || isString(value.lessonKey, 250)) &&
    isString(value.text, MAX_SELECTION_CHARS) &&
    isString(value.baseline, MAX_SELECTION_CHARS)
  );
}

/** A message from one of this extension's own pages (the side panel), never from a web page. */
export function isOwnExtensionPage(
  sender: chrome.runtime.MessageSender | undefined,
  extensionId: string,
  pageUrl: string,
): boolean {
  if (!sender || sender.id !== extensionId || typeof sender.url !== "string") return false;
  try {
    const url = new URL(sender.url);
    const expected = new URL(pageUrl);
    return url.origin === expected.origin && url.pathname === expected.pathname;
  } catch {
    return false;
  }
}
