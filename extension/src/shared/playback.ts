// Playback of a MyDubb result. One session per tab, owned by the offscreen document
// (offscreen.html, src/offscreen): it holds the only <audio> element of that tab, so the side panel
// and the floating player on the Udemy page are two remote controls of the same audio and it keeps
// playing when the panel closes. Contracts and validators; every receiver checks shape and sender.
//
// - Panel <-> offscreen: runtime port PLAYER_PANEL_PORT, bound to the panel's own tab.
// - Udemy content script <-> offscreen: runtime port PLAYER_PAGE_PORT; Chrome sets sender.tab, so a
//   page can only reach its own tab's session. It receives display state only (PlayerView): no
//   token, account, job id or audio address.
// - The MP3 itself: a Blob posted by the panel on the BroadcastChannel AUDIO_CHANNEL, which only
//   pages of the extension's own origin can join (never a content script or a web page), and only
//   for a transfer the offscreen document asked for on the panel's port.
// - Service worker -> offscreen: runtime messages for account changes and closed tabs.

export const PLAYER_PANEL_PORT = "mydubb-player-panel";
export const PLAYER_PAGE_PORT = "mydubb-player-page";
export const AUDIO_CHANNEL = "mydubb-audio";
export const OFFSCREEN_PAGE = "offscreen.html";
export const PLAYER_SEEK_SECONDS = 5;
const MAX_AUDIO_SECONDS = 24 * 3600;
const MAX_SEEK_DELTA = 60;

/** What the job was made with, as shown with its audio (copied at Generate, never the form). */
export interface PlaybackChoices {
  languageLabel: string;
  voiceLabel: string;
  speed: number;
}

/** Who a session belongs to: only the tab's panel ever sees this. */
export interface PlaybackOwner {
  userId: string;
  connectionId: string;
  jobId: string;
  operationId: string;
}

export type PlaybackProblem = "play-blocked" | "play-failed" | "media-error" | "not-linked";

/** Display state of a session: all the floating player on the Udemy page may know. */
export interface PlayerView {
  sessionId: string;
  lessonKey: string;
  status: "loading" | "ready" | "error";
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number | null;
  problem: PlaybackProblem | null;
  choices: PlaybackChoices;
  /** The user chose Show floating player (and has not closed it). */
  floating: boolean;
}

export interface PanelPlayerView extends PlayerView {
  owner: PlaybackOwner;
  /** The tab's content script is linked: required before the session may play. */
  linked: boolean;
}

export type PlayerCommandName = "play" | "pause" | "seek-by" | "seek-to";

export interface PlayerCommand {
  command: PlayerCommandName;
  /** Seconds to move ("seek-by") or the position ("seek-to"). */
  value?: number;
}

// ---- Panel <-> offscreen ---------------------------------------------------------------------

export type PanelToPlayer =
  | { type: "watch"; tabId: number }
  | { type: "open"; tabId: number; transferId: string; lessonKey: string; owner: PlaybackOwner; choices: PlaybackChoices }
  | ({ type: "command"; tabId: number; sessionId: string } & PlayerCommand)
  | { type: "floating"; tabId: number; sessionId: string; visible: boolean }
  | { type: "end"; tabId: number; sessionId: string | null };

export type OpenFailure = "revoked" | "timeout" | "invalid-audio" | "busy";

export type PlayerToPanel =
  | { type: "state"; tabId: number; view: PanelPlayerView | null }
  | { type: "send-audio"; tabId: number; transferId: string }
  | { type: "opened"; tabId: number; transferId: string; sessionId: string }
  | { type: "open-failed"; tabId: number; transferId: string; reason: OpenFailure };

export interface AudioTransfer {
  transferId: string;
  blob: Blob;
}

// ---- Udemy content script <-> offscreen --------------------------------------------------------

export type PageToPlayer =
  | { type: "hello"; lessonKey: string }
  | ({ type: "command"; sessionId: string; lessonKey: string } & PlayerCommand)
  | { type: "close"; sessionId: string; lessonKey: string }
  | { type: "lesson"; lessonKey: string | null };

export type PlayerToPage = { type: "view"; view: PlayerView } | { type: "ended" };

// ---- Panel -> content script (the panel's existing tab port) -----------------------------------

/** Asks the content script to link its page to this tab's playback session. */
export interface PlaybackLinkMessage {
  type: "playback-link";
  lessonKey: string;
}

// ---- Service worker -> offscreen (runtime.sendMessage) ---------------------------------------

export type WorkerToPlayer =
  | { type: "mydubb:player-identity"; connectionId: string | null }
  | { type: "mydubb:player-tab-closed"; tabId: number };

// ---- Validators ------------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v !== "" && v.length <= max;
const isTabId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isLessonKey = (v: unknown): v is string => isText(v, 250);
const isId = (v: unknown): v is string => isText(v, 100);

function isChoices(value: unknown): value is PlaybackChoices {
  return isObject(value) && isText(value.languageLabel, 200) && isText(value.voiceLabel, 200) && isFiniteNumber(value.speed);
}

function isOwner(value: unknown): value is PlaybackOwner {
  return isObject(value) && isId(value.userId) && isId(value.connectionId) && isId(value.jobId) && isId(value.operationId);
}

/** The command part of a message: known name, and a bounded value only where it belongs. */
function isCommand(value: Record<string, unknown>): boolean {
  switch (value.command) {
    case "play":
    case "pause":
      return value.value === undefined;
    case "seek-by":
      return isFiniteNumber(value.value) && value.value !== 0 && Math.abs(value.value) <= MAX_SEEK_DELTA;
    case "seek-to":
      return isFiniteNumber(value.value) && value.value >= 0 && value.value <= MAX_AUDIO_SECONDS;
    default:
      return false;
  }
}

export function isPanelToPlayer(value: unknown): value is PanelToPlayer {
  if (!isObject(value) || !isTabId(value.tabId)) return false;
  switch (value.type) {
    case "watch":
      return true;
    case "open":
      return isId(value.transferId) && isLessonKey(value.lessonKey) && isOwner(value.owner) && isChoices(value.choices);
    case "command":
      return isId(value.sessionId) && isCommand(value);
    case "floating":
      return isId(value.sessionId) && typeof value.visible === "boolean";
    case "end":
      return value.sessionId === null || isId(value.sessionId);
    default:
      return false;
  }
}

export function isPageToPlayer(value: unknown): value is PageToPlayer {
  if (!isObject(value)) return false;
  switch (value.type) {
    case "hello":
      return isLessonKey(value.lessonKey);
    case "command":
      return isId(value.sessionId) && isLessonKey(value.lessonKey) && isCommand(value);
    case "close":
      return isId(value.sessionId) && isLessonKey(value.lessonKey);
    case "lesson":
      return value.lessonKey === null || isLessonKey(value.lessonKey);
    default:
      return false;
  }
}

export function isWorkerToPlayer(value: unknown): value is WorkerToPlayer {
  if (!isObject(value)) return false;
  if (value.type === "mydubb:player-identity") return value.connectionId === null || isId(value.connectionId);
  if (value.type === "mydubb:player-tab-closed") return isTabId(value.tabId);
  return false;
}

export function isPlaybackLinkMessage(value: unknown): value is PlaybackLinkMessage {
  return isObject(value) && value.type === "playback-link" && isLessonKey(value.lessonKey);
}

function isView(value: unknown): value is PlayerView {
  return (
    isObject(value) &&
    isId(value.sessionId) &&
    isLessonKey(value.lessonKey) &&
    (value.status === "loading" || value.status === "ready" || value.status === "error") &&
    typeof value.paused === "boolean" &&
    typeof value.ended === "boolean" &&
    isFiniteNumber(value.currentTime) &&
    (value.duration === null || isFiniteNumber(value.duration)) &&
    (value.problem === null ||
      value.problem === "play-blocked" ||
      value.problem === "play-failed" ||
      value.problem === "media-error" ||
      value.problem === "not-linked") &&
    isChoices(value.choices) &&
    typeof value.floating === "boolean"
  );
}

export function isPlayerToPage(value: unknown): value is PlayerToPage {
  if (!isObject(value)) return false;
  if (value.type === "ended") return true;
  return value.type === "view" && isView(value.view);
}

export function isPlayerToPanel(value: unknown): value is PlayerToPanel {
  if (!isObject(value) || !isTabId(value.tabId)) return false;
  switch (value.type) {
    case "state":
      return (
        value.view === null ||
        (isView(value.view) && isOwner((value.view as unknown as PanelPlayerView).owner) && typeof (value.view as unknown as PanelPlayerView).linked === "boolean")
      );
    case "send-audio":
      return isId(value.transferId);
    case "opened":
      return isId(value.transferId) && isId(value.sessionId);
    case "open-failed":
      return (
        isId(value.transferId) &&
        (value.reason === "revoked" || value.reason === "timeout" || value.reason === "invalid-audio" || value.reason === "busy")
      );
    default:
      return false;
  }
}

/** A Blob offered on AUDIO_CHANNEL: an id and an audio Blob, nothing else. */
export function isAudioTransfer(value: unknown, maxBytes: number): value is AudioTransfer {
  return (
    isObject(value) &&
    isId(value.transferId) &&
    value.blob instanceof Blob &&
    value.blob.type.startsWith("audio/") &&
    value.blob.size > 0 &&
    value.blob.size <= maxBytes
  );
}

/** `[0, duration]` when the duration is known; otherwise only not below 0. */
export function clampPosition(time: number, duration: number | null): number {
  const upper = duration !== null && Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(upper, Math.max(0, time));
}

/** "Vietnamese · Andrew Multilingual · 1.5x": the choices the file was made with. */
export function choicesLabel(choices: PlaybackChoices): string {
  return `${choices.languageLabel} · ${choices.voiceLabel} · ${choices.speed}x`;
}
