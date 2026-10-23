import type { AudioDuration } from "../../api/types";
import { speedLabel } from "../../lib/speed";

interface Props {
  duration: AudioDuration;
}

// Unrounded: one sample is 0.04 ms at 24 kHz, and a rounded figure could hide a mismatch.
const seconds = (value: number) => `${value.toFixed(6)} s`;
const samples = (value: number) => `${value.toLocaleString("en-US")} samples`;

function tempoText(duration: AudioDuration): string {
  const factor = duration.tempo_factor;
  if (factor === null) {
    return "none (the speech was already within the rounding of the target)";
  }
  const direction = factor > 1 ? "faster" : factor < 1 ? "slower" : "unchanged";
  return `×${factor.toFixed(5)} (${direction}, pitch preserved)`;
}

/** ffprobe's figure can include the MP3's encoder delay and padding (FFmpeg-version dependent). */
function containerNote(duration: AudioDuration): string {
  const extra = duration.mp3_container_seconds - duration.mp3_decoded_seconds;
  if (Math.abs(extra * duration.sample_rate) <= 1) return "";
  return ` (${(extra * 1000).toFixed(2)} ms more: encoder delay and padding, which players trim)`;
}

function adjustmentText(duration: AudioDuration): string {
  const rate = duration.sample_rate;
  const ms = (count: number) => `${((count / rate) * 1000).toFixed(2)} ms`;
  const parts = [];
  if (duration.padded_samples > 0) {
    parts.push(
      `${samples(duration.padded_samples)} (${ms(duration.padded_samples)}) of silence added at the end`,
    );
  }
  if (duration.trimmed_samples > 0) {
    parts.push(
      `${samples(duration.trimmed_samples)} (${ms(duration.trimmed_samples)}) of silence removed from the end`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

function paddingText(duration: AudioDuration): string {
  const count = duration.mp3_padding_adjusted_samples;
  if (count === 0) return "none (the encoder's header was already exact)";
  return `${samples(count)} added to the end padding so the header matches what was encoded`;
}

/** Baseline, speed, target and measured durations of the real audio, side by side, unrounded. */
export function DurationDetails({ duration }: Props) {
  return (
    <div className="duration" aria-label="Audio duration">
      <p>
        <strong>Baseline</strong> {seconds(duration.baseline_seconds)} · <strong>Speed</strong>{" "}
        {speedLabel(duration.speed)} · <strong>Target {seconds(duration.target_seconds)}</strong> ·{" "}
        <strong>Actual</strong> {seconds(duration.mp3_decoded_seconds)} (decoded from the final MP3)
      </p>
      <dl className="duration-list">
        <dt>Baseline at 1x (last − first sentence start)</dt>
        <dd>{seconds(duration.baseline_seconds)}</dd>
        <dt>Speed</dt>
        <dd>{speedLabel(duration.speed)}</dd>
        <dt>Target (baseline ÷ speed, to the sample)</dt>
        <dd>
          {seconds(duration.target_seconds)} · {samples(duration.target_samples)}
        </dd>
        <dt>Natural speech, before the change</dt>
        <dd>
          {seconds(duration.source_seconds)} · {samples(duration.source_samples)}
        </dd>
        <dt>Tempo change</dt>
        <dd>{tempoText(duration)}</dd>
        <dt>Processed PCM</dt>
        <dd>
          {seconds(duration.processed_seconds)} · {samples(duration.processed_samples)}
        </dd>
        <dt>Final MP3, decoded</dt>
        <dd>
          {seconds(duration.mp3_decoded_seconds)} · {samples(duration.mp3_decoded_samples)}
        </dd>
        <dt>Final MP3, gapless header</dt>
        <dd>
          {seconds(duration.mp3_header_seconds)} · {samples(duration.mp3_header_samples)}
        </dd>
        <dt>Final MP3, ffprobe container</dt>
        <dd>
          {seconds(duration.mp3_container_seconds)}
          {containerNote(duration)}
        </dd>
        <dt>Silence adjustment</dt>
        <dd>{adjustmentText(duration)}</dd>
        <dt>MP3 header correction</dt>
        <dd>{paddingText(duration)}</dd>
      </dl>
    </div>
  );
}
