// Synchronizing the MyDubb audio with the Udemy video (story 4): the timeline mapping, the
// metadata a job keeps for it, and the texts both remote controls (side panel and floating player)
// show. Pure functions only.
//
// The MP3 already has the chosen speed in it, so the audio always plays at 1x and is the clock.
// The video runs at whatever rate makes it cover its source span in the same time:
//
//   V0, V1  start and end of the source span on the video (seconds)
//   D       the real MP3 duration (the audio element's)
//   A       the position in the MP3 (0..D)
//   R = (V1 - V0) / D,   V = V0 + A x R,   A = (V - V0) / R
//
// V1 is the START of the last sentence/caption (the job's contract): no tail is added.

/** What a job's Generate click fixed about its source span; copied at the click, never the form later. */
export interface SyncSource {
  /** "plain": the two start-time fields; "timed": the first and last caption of the transcript. */
  mode: "plain" | "timed";
  /** V0 and V1, seconds on the video (milliseconds kept for captions). */
  start: number;
  end: number;
  /** The baseline the job was made with (last - first start field) and its speed: D ≈ baseline / speed. */
  baseline: number;
  speed: number;
}

export interface SyncMapping {
  start: number;
  end: number;
  /** D: the real MP3 duration. */
  duration: number;
  /** R: the video playback rate. */
  rate: number;
}

export type SyncUnavailable = "no-metadata" | "loading" | "length-mismatch" | "rate-unsupported" | "not-linked";

// Chrome's playbackRate limits (outside them setting it throws NotSupportedError).
export const MIN_VIDEO_RATE = 0.0625;
export const MAX_VIDEO_RATE = 16;
// The MP3 may differ from baseline / speed by encoder padding (tens of ms); more means the audio was
// not fitted to the span (e.g. mock audio), and then no mapping is right.
export const LENGTH_TOLERANCE_SECONDS = 0.25;
export const LENGTH_TOLERANCE_RATIO = 0.01;
const MAX_SECONDS = 24 * 3600;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function isSyncSource(value: unknown): value is SyncSource {
  const v = value as Partial<SyncSource> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    (v.mode === "plain" || v.mode === "timed") &&
    finite(v.start) &&
    finite(v.end) &&
    v.start >= 0 &&
    v.end > v.start &&
    v.end <= MAX_SECONDS &&
    finite(v.baseline) &&
    v.baseline > 0 &&
    v.baseline <= MAX_SECONDS &&
    finite(v.speed) &&
    v.speed > 0 &&
    v.speed <= 10
  );
}

/** The mapping for this job and MP3, or why there is none. Never clamps anything into range. */
export function syncMapping(
  source: SyncSource | null,
  mp3Duration: number | null,
): { ok: true; mapping: SyncMapping } | { ok: false; reason: SyncUnavailable } {
  if (!source || !isSyncSource(source)) return { ok: false, reason: "no-metadata" };
  if (mp3Duration === null || !finite(mp3Duration) || mp3Duration <= 0) return { ok: false, reason: "loading" };
  const expected = source.baseline / source.speed;
  if (Math.abs(mp3Duration - expected) > Math.max(LENGTH_TOLERANCE_SECONDS, LENGTH_TOLERANCE_RATIO * expected)) {
    return { ok: false, reason: "length-mismatch" };
  }
  const rate = (source.end - source.start) / mp3Duration;
  if (!(rate >= MIN_VIDEO_RATE && rate <= MAX_VIDEO_RATE)) return { ok: false, reason: "rate-unsupported" };
  return { ok: true, mapping: { start: source.start, end: source.end, duration: mp3Duration, rate } };
}

/** V = V0 + A x R */
export const videoTime = (m: SyncMapping, audioSeconds: number): number => m.start + audioSeconds * m.rate;
/** A = (V - V0) / R */
export const audioTime = (m: SyncMapping, videoSeconds: number): number => (videoSeconds - m.start) / m.rate;

// ---- What the remote controls show -------------------------------------------------------------

export type SyncStatus = "unavailable" | "off" | "starting" | "paused" | "playing" | "buffering";

export type SyncNotice =
  | "rate-changed"
  | "rate-not-held"
  | "seek-outside"
  | "video-replaced"
  | "no-video"
  | "video-not-ready"
  | "range-outside-video"
  | "rate-unsupported"
  | "unstable"
  | "video-play-blocked"
  | "video-play-failed"
  | "audio-play-blocked"
  | "audio-play-failed"
  | "no-response"
  | "video-error"
  | "audio-error"
  | "ended"
  | "other-tab"
  | "unmuted"
  | "not-linked";

export const SYNC_NOTICES: readonly SyncNotice[] = [
  "rate-changed",
  "rate-not-held",
  "seek-outside",
  "video-replaced",
  "no-video",
  "video-not-ready",
  "range-outside-video",
  "rate-unsupported",
  "unstable",
  "video-play-blocked",
  "video-play-failed",
  "audio-play-blocked",
  "audio-play-failed",
  "no-response",
  "video-error",
  "audio-error",
  "ended",
  "other-tab",
  "unmuted",
  "not-linked",
];

/** The sync part of a session's display state (numbers only; no job, account or audio address). */
export interface SyncView {
  status: SyncStatus;
  unavailable: SyncUnavailable | null;
  /** V0, V1, D and R when a mapping exists. */
  start: number | null;
  end: number | null;
  duration: number | null;
  rate: number | null;
  /** Sync was turned on once for this session: the explanation is not asked for again. */
  confirmed: boolean;
  notice: SyncNotice | null;
}

/** "0:10", "1:02:03.250": a video or audio position, milliseconds only when there are some. */
export function clockLabel(seconds: number): string {
  const millis = Math.round(seconds * 1000);
  const whole = Math.floor(millis / 1000);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  const fraction = millis % 1000 ? `.${String(millis % 1000).padStart(3, "0")}` : "";
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${s}${fraction}`;
}

/** "1.5x", "1.333x", "0.875x": the video rate, three decimals at most. */
export function rateLabel(rate: number): string {
  return `${Number(rate.toFixed(3))}x`;
}

const seconds = (s: number) => `${Number(s.toFixed(3))} s`;

const UNAVAILABLE_TEXT: Record<SyncUnavailable, string> = {
  "no-metadata":
    "this result has no confirmed source times. You can still listen on its own; to sync, check the two start times and Generate it again.",
  loading: "the audio is still loading.",
  "length-mismatch":
    "the MP3 length does not match the job's start times (the audio was not fitted to them), so the video position cannot be worked out.",
  "rate-unsupported": "the video would have to run at a speed Chrome cannot play.",
  "not-linked": "the Udemy tab is not linked to the player. Reload the lecture tab.",
};

const STATUS_TEXT: Record<Exclude<SyncStatus, "unavailable" | "off">, string> = {
  starting: "Starting…",
  paused: "Paused",
  playing: "Playing",
  buffering: "Buffering…",
};

export function syncStatusText(sync: SyncView): string {
  if (sync.status === "unavailable") return `Sync unavailable: ${UNAVAILABLE_TEXT[sync.unavailable ?? "no-metadata"]}`;
  if (sync.status === "off") return "Sync with video: OFF";
  return `Sync with video: ON · ${STATUS_TEXT[sync.status]}`;
}

/** The floating player's one-line form: "Sync: OFF", "Sync: ON · Playing", "Sync unavailable". */
export function syncShortStatusText(sync: SyncView): string {
  if (sync.status === "unavailable") return "Sync unavailable";
  if (sync.status === "off") return "Sync: OFF";
  return `Sync: ON · ${STATUS_TEXT[sync.status]}`;
}

/** What turning Sync on will do, shown before the first time. */
export function syncPreviewText(sync: SyncView): string {
  if (sync.start === null || sync.end === null || sync.duration === null || sync.rate === null) return "";
  return (
    `Video ${clockLabel(sync.start)} → ${clockLabel(sync.end)} (${seconds(sync.end - sync.start)}), ` +
    `MP3 ${seconds(sync.duration)}, video speed ${rateLabel(sync.rate)}. ` +
    "The video is muted: the MyDubb audio replaces the spoken part. The timing is an estimate, not word by word."
  );
}

export function syncNoticeText(sync: SyncView): string {
  const range = sync.start !== null && sync.end !== null ? `${clockLabel(sync.start)}–${clockLabel(sync.end)}` : "the synced part";
  const need = sync.rate !== null ? rateLabel(sync.rate) : "the synced speed";
  switch (sync.notice) {
    case null:
      return "";
    case "rate-changed":
      return `Sync turned off: the video speed changed from ${need}, the speed Sync needs, while it played. Both are paused; the video keeps its new speed. Turn Sync on again to go back to ${need}.`;
    case "rate-not-held":
      return `Sync turned off: the video speed did not stay at ${need}, the speed Sync needs (the page kept setting another speed). Both are paused.`;
    case "seek-outside":
      return `Sync turned off: the video was moved outside ${range}, the part this audio covers. Both are paused.`;
    case "video-replaced":
      return "Sync turned off: the Udemy video player was replaced. Both are paused; turn Sync on again when the video is ready.";
    case "no-video":
      return "Sync could not start: no single lecture video is identified on the page.";
    case "video-not-ready":
      return "Sync could not start: the video is not ready yet. Try again when it has loaded.";
    case "range-outside-video":
      return `Sync could not start: ${range} is not inside this video's length.`;
    case "rate-unsupported":
      return "Sync could not start: Chrome refused the video speed it needs.";
    case "unstable":
      return "Paused: the video and the audio kept drifting apart. Press Play to try again.";
    case "video-play-blocked":
      return "Chrome blocked the video from playing. Press Play again (or play the video once in the Udemy player).";
    case "video-play-failed":
      return "The video could not start playing. Both are paused.";
    case "audio-play-blocked":
      return "Chrome blocked the MyDubb audio. Press Play again. Both are paused.";
    case "audio-play-failed":
      return "The MyDubb audio could not start. Both are paused.";
    case "no-response":
      return "The Udemy video did not respond in time. Both are paused.";
    case "video-error":
      return "Sync turned off: the video reported an error.";
    case "audio-error":
      return "Sync turned off: the MyDubb audio could not be played.";
    case "ended":
      return "End of the synced part. Press Play to start it again from the beginning.";
    case "other-tab":
      return "Paused: MyDubb audio started in another tab.";
    case "unmuted":
      return "You unmuted the video, so both voices may play together. MyDubb does not mute it again.";
    case "not-linked":
      return "Sync could not start: the Udemy tab is not linked to the player. Reload the lecture tab.";
  }
}
