import type { JobResult } from "../../api/types";
import { formatOutputDuration, speedLabel } from "../../lib/speed";
import { DurationDetails } from "./DurationDetails";
import { TimingDetails } from "./TimingDetails";

interface Props {
  result: JobResult;
}

/**
 * Everything technical about the result, closed by default: the server's own notes (shown as
 * sent, never filtered), the components that produced it, and the measured durations.
 */
export function AudioDetails({ result }: Props) {
  const { duration } = result.audio;
  return (
    <details className="disclosure">
      <summary>Audio details</summary>
      <div className="disclosure-body stack">
        {result.notices.length > 0 && (
          <ul className="notes small">
            {result.notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        )}
        <dl className="facts-list small">
          <dt>Translation</dt>
          <dd>{result.translation.provider}</dd>
          <dt>Speech</dt>
          <dd>{result.audio.provider}</dd>
        </dl>
        {result.timing && <TimingDetails timing={result.timing} />}
        {duration ? (
          <DurationDetails duration={duration} />
        ) : (
          <p className="small muted">
            Duration was not measured: this audio was not adjusted (selected speed{" "}
            {speedLabel(result.speed)}, planned length{" "}
            {formatOutputDuration(result.output_duration_seconds)}).
          </p>
        )}
      </div>
    </details>
  );
}
