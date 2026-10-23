// Audio speed choices. The server is authoritative: it accepts exactly these seven numbers,
// treats a missing one as 1x, and computes the output length itself. The preview here only
// gives instant feedback.
export const AUDIO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type AudioSpeed = (typeof AUDIO_SPEEDS)[number];

export const DEFAULT_SPEED: AudioSpeed = 1;

/** "0.5x", "1x", "1.75x". */
export function speedLabel(speed: number): string {
  return `${speed}x`;
}

/** Planned output length in seconds: the 1x duration divided by the speed. */
export function previewOutputSeconds(baselineSeconds: number, speed: number): number {
  return baselineSeconds / speed;
}

/**
 * "00:00:26.67 (26.67 s)" for display. Rounded to hundredths of a second for reading only; the
 * file's length is fixed in samples by the server, and the result shows it unrounded.
 */
export function formatOutputDuration(seconds: number): string {
  const hundredths = Math.round(seconds * 100);
  const whole = Math.floor(hundredths / 100);
  const fraction = hundredths % 100;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const decimals = fraction === 0 ? "" : `.${pad(fraction)}`;
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(secs)}${decimals}`;
  const plain = fraction === 0 ? `${whole}` : `${whole}.${pad(fraction)}`;
  return `${clock} (${plain} s)`;
}
