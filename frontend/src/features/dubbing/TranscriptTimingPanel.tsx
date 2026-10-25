import type { TranscriptTiming } from "../../lib/transcriptTiming";
import { captionClock } from "../../lib/transcriptTiming";
import { formatSeconds } from "../../lib/timestamps";

interface Props {
  timing: TranscriptTiming;
  ignore: boolean;
  onIgnoreChange: (ignore: boolean) => void;
  // The two fields differ from the caption times they were filled with.
  overridden: boolean;
  // Seconds between the two fields, when both are valid.
  selectedBaseline: number | null;
  onUseTranscriptTimes: () => void;
}

/** What the transcript's timestamps will be used for; nothing for a plain transcript. */
export function TranscriptTimingPanel({
  timing,
  ignore,
  onIgnoreChange,
  overridden,
  selectedBaseline,
  onUseTranscriptTimes,
}: Props) {
  if (timing.kind === "none") return null;
  if (timing.kind === "cues") {
    return (
      <p className="small muted" role="status">
        SRT/WebVTT timing is not used yet: this transcript is processed as plain text with the two
        start times below.
      </p>
    );
  }

  const toggle = (
    <label className="check small">
      <input
        type="checkbox"
        checked={ignore}
        onChange={(event) => onIgnoreChange(event.currentTarget.checked)}
      />{" "}
      Ignore the timestamps (process as plain text)
    </label>
  );

  if (timing.kind === "invalid") {
    return (
      <div className={ignore ? "timing small" : "callout error small timing"} role="status">
        {!ignore && (
          <p>
            <strong>The timestamps cannot be used.</strong> {timing.message} Fix them, or process
            the transcript as plain text.
          </p>
        )}
        {toggle}
      </div>
    );
  }

  return (
    <div className="callout small timing" role="status" aria-label="Transcript timing">
      {ignore ? (
        <p>Timestamps detected but ignored: the whole audio is fitted to the two start times.</p>
      ) : (
        <>
          <p>
            <strong>Timestamps detected:</strong> {timing.captions} captions from{" "}
            {captionClock(timing.first)} to {captionClock(timing.last)}. The start times below
            are filled from the first and last caption.
          </p>
          <p>
            Timing follows the captions and is estimated: some sentences may be grouped together
            or start slightly off their caption time.
          </p>
          {overridden && (
            <p>
              You changed the start times
              {selectedBaseline !== null
                ? `: the caption timing is scaled to ${formatSeconds(selectedBaseline)}`
                : ""}
              .{" "}
              <button type="button" className="link-button" onClick={onUseTranscriptTimes}>
                Use the transcript times
              </button>
            </p>
          )}
        </>
      )}
      {toggle}
    </div>
  );
}
