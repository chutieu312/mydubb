import type { Timing } from "../../api/types";
import { formatClock } from "../../lib/speed";
import { captionClock } from "../../lib/transcriptTiming";

/** How a timed job used the caption times (inside "Audio details"). */
export function TimingDetails({ timing }: { timing: Timing }) {
  return (
    <dl className="facts-list small" aria-label="Caption timing">
      <dt>Captions</dt>
      <dd>
        {timing.captions} ({captionClock(timing.source_first_seconds)} to{" "}
        {captionClock(timing.source_last_seconds)})
      </dd>
      <dt>Baseline used</dt>
      <dd>
        {formatClock(timing.selected_baseline_seconds)}
        {timing.selected_baseline_seconds !== timing.source_baseline_seconds &&
          ` (captions span ${formatClock(timing.source_baseline_seconds)}, scaled)`}
      </dd>
      <dt>Sentence blocks</dt>
      <dd>{timing.blocks}</dd>
      <dt>Speech requests</dt>
      <dd>{timing.speech_requests}</dd>
      {timing.frames !== null && (
        <>
          <dt>Parts on the timeline</dt>
          <dd>
            {timing.frames} ({timing.removed_boundaries} block boundaries merged)
          </dd>
          <dt>Fastest tempo</dt>
          <dd>
            {timing.max_tempo_factor === null ? "1x" : `${timing.max_tempo_factor.toFixed(2)}x`}
            {timing.frames_over_warning_level
              ? ` (${timing.frames_over_warning_level} above ${timing.tempo_warning_level}x)`
              : ""}
          </dd>
          <dt>Estimated largest shift</dt>
          <dd>
            {(timing.estimated_max_displacement_seconds ?? 0).toFixed(2)} s (estimated, not
            measured)
          </dd>
        </>
      )}
    </dl>
  );
}
