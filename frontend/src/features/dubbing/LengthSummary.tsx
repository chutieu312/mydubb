import { DEFAULT_SPEED, formatClock, previewOutputSeconds, speedLabel } from "../../lib/speed";
import { formatSeconds } from "../../lib/timestamps";

interface Props {
  // Seconds between the two timestamps (the length at 1x); null until both are valid.
  baselineSeconds: number | null;
  speed: number;
}

/** Instant estimate of the audio length; the server validates and calculates the real one. */
export function LengthSummary({ baselineSeconds, speed }: Props) {
  return (
    <div className="length" role="group" aria-label="Audio length preview" aria-live="polite">
      <div className="length-box">
        <span>
          Expected audio length
          <small className="muted block">
            {baselineSeconds === null
              ? "Enter both start times"
              : `${formatSeconds(baselineSeconds)} at 1x`}
          </small>
        </span>
        <strong className="length-value">
          {baselineSeconds === null ? "—" : formatClock(previewOutputSeconds(baselineSeconds, speed))}
        </strong>
      </div>
      {baselineSeconds !== null && speed === DEFAULT_SPEED && (
        <p className="small muted">Matches the time between your two start times.</p>
      )}
      {baselineSeconds !== null && speed !== DEFAULT_SPEED && (
        <p className="callout warning small">
          At {speedLabel(speed)} the audio will be {speed > DEFAULT_SPEED ? "shorter" : "longer"}{" "}
          than the time between the two timestamps, so it will not match the video&apos;s length
          for that stretch. The downloaded file itself changes.
        </p>
      )}
      <p className="small muted">
        Estimate only; the server validates the input and calculates the final length.
      </p>
    </div>
  );
}
