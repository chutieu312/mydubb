// Sync prototype: what the measurements say. Pure functions over the lab's samples.
//
// A sample pairs the video position V (read by the probe when it answers) with the audio position A
// (read in the lab when the answer arrives): d = (V - V0) / R - A, in MP3 seconds, the same drift the
// SyncController corrects (src/offscreen/sync.ts). The message delay (a few ms) adds R x delay of
// error to each sample.

export const ALIGNED_SECONDS = 0.3;
// Samples this long after an operation belong to that operation's settling, not to steady play.
export const SETTLE_WINDOW_MS = 2000;

export interface DriftSample {
  /** performance.now() in the lab when the answer arrived. */
  t: number;
  audio: number;
  video: number;
  drift: number;
  audioPaused: boolean;
  videoPaused: boolean;
  videoWaiting: boolean;
  videoRate: number;
}

export interface Operation {
  t: number;
  label: string;
}

export interface Recovery {
  label: string;
  /** ms from the operation to the first sample with both playing and |d| <= ALIGNED_SECONDS; null: never (within the samples). */
  alignedAfterMs: number | null;
  /** The largest |d| while both played between the operation and that sample (or the next operation). */
  maxAbsDrift: number | null;
  /** How the two were seen right after: both playing, both paused, or one of each. */
  endState: "both-playing" | "both-paused" | "mixed" | "no-sample";
}

export interface SteadyStats {
  samples: number;
  medianAbs: number | null;
  p95Abs: number | null;
  maxAbs: number | null;
}

const bothPlaying = (s: DriftSample) => !s.audioPaused && !s.videoPaused && !s.videoWaiting;

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

/** |d| while both play steadily: not within SETTLE_WINDOW_MS after any operation. */
export function steadyStats(samples: DriftSample[], operations: Operation[]): SteadyStats {
  const values = samples
    .filter((s) => bothPlaying(s) && !operations.some((op) => s.t >= op.t && s.t - op.t < SETTLE_WINDOW_MS))
    .map((s) => Math.abs(s.drift))
    .sort((a, b) => a - b);
  return { samples: values.length, medianAbs: quantile(values, 0.5), p95Abs: quantile(values, 0.95), maxAbs: values.at(-1) ?? null };
}

/** For each operation: how long until the two were aligned again, and how far apart they got. */
export function recoveries(samples: DriftSample[], operations: Operation[]): Recovery[] {
  return operations.map((op, i) => {
    const until = operations[i + 1]?.t ?? Number.POSITIVE_INFINITY;
    const after = samples.filter((s) => s.t >= op.t && s.t < until);
    const first = after[0];
    if (!first) return { label: op.label, alignedAfterMs: null, maxAbsDrift: null, endState: "no-sample" };
    const aligned = after.find((s) => bothPlaying(s) && Math.abs(s.drift) <= ALIGNED_SECONDS);
    const window = aligned ? after.filter((s) => s.t <= aligned.t) : after;
    const playing = window.filter(bothPlaying).map((s) => Math.abs(s.drift));
    const last = after.at(-1)!;
    const endState =
      bothPlaying(last) ? "both-playing" : last.audioPaused && last.videoPaused ? "both-paused" : "mixed";
    return {
      label: op.label,
      alignedAfterMs: aligned ? Math.round(aligned.t - op.t) : null,
      maxAbsDrift: playing.length > 0 ? Math.max(...playing) : null,
      endState,
    };
  });
}

/** V0 and V1 for a test span of the MP3's length at rate R, starting where the video is. */
export function testSpan(
  videoTime: number,
  seekStart: number,
  seekEnd: number,
  mp3Duration: number,
  rate: number,
): { start: number; end: number } | { error: "too-short" } {
  const length = mp3Duration * rate;
  // Milliseconds, as a caption span keeps them; moved back when the video ends before V0 + length.
  let start = Math.floor(Math.max(seekStart, videoTime) * 1000) / 1000;
  if (start + length > seekEnd) start = Math.floor((seekEnd - length) * 1000) / 1000;
  if (start < seekStart) return { error: "too-short" };
  return { start, end: start + length };
}
