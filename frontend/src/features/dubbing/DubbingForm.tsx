import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { ApiError, api } from "../../api/client";
import type { Job, VoiceOption } from "../../api/types";
import { DEFAULT_SPEED } from "../../lib/speed";
import type { StudioDraft } from "../../lib/studioDraft";
import { formatSeconds, previewTargetDuration } from "../../lib/timestamps";
import { analyzeTranscriptTiming, type TranscriptTiming } from "../../lib/transcriptTiming";
import { FieldMessage } from "./FieldMessage";
import { LengthSummary } from "./LengthSummary";
import { SpeedField } from "./SpeedField";
import { TimestampInput } from "./TimestampInput";
import { TranscriptTimingPanel } from "./TranscriptTimingPanel";
import { VoiceField } from "./VoiceField";

interface Props {
  voices: VoiceOption[];
  // One line saying that the text is sent to an outside service on submit; null when it is not.
  disclosure: string | null;
  onJobCreated: (job: Job) => void;
  onSessionExpired: () => void;
  // An unsent draft of the same signed-in user, kept in page memory by the caller.
  initialDraft?: StudioDraft;
  onDraftChange?: (draft: StudioDraft) => void;
}

type FieldErrors = Partial<Record<string, string>>;

// The caption pair the two time fields were last filled from.
function captionKey(timing: TranscriptTiming): string | null {
  return timing.kind === "timed" ? `${timing.first}-${timing.last}` : null;
}

export function DubbingForm({
  voices,
  disclosure,
  onJobCreated,
  onSessionExpired,
  initialDraft,
  onDraftChange,
}: Props) {
  const [transcript, setTranscript] = useState(initialDraft?.transcript ?? "");
  const [firstStart, setFirstStart] = useState(initialDraft?.firstStart ?? "");
  const [lastStart, setLastStart] = useState(initialDraft?.lastStart ?? "");
  const [voice, setVoice] = useState(() => {
    const drafted = initialDraft?.voice;
    return drafted !== undefined && voices.some((v) => v.id === drafted)
      ? drafted
      : (voices[0]?.id ?? "");
  });
  const [speed, setSpeed] = useState<number>(initialDraft?.speed ?? DEFAULT_SPEED);
  const [ignoreTimestamps, setIgnoreTimestamps] = useState(initialDraft?.ignoreTimestamps ?? false);
  // A restored draft keeps its own field values: its captions count as already filled.
  const filledFrom = useRef<string | null>(
    captionKey(analyzeTranscriptTiming(initialDraft?.transcript ?? "")),
  );
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    onDraftChange?.({ transcript, firstStart, lastStart, voice, speed, ignoreTimestamps });
  }, [onDraftChange, transcript, firstStart, lastStart, voice, speed, ignoreTimestamps]);

  const timing = useMemo(() => analyzeTranscriptTiming(transcript), [transcript]);
  const preview = previewTargetDuration(firstStart, lastStart);
  const usesTimestamps =
    (timing.kind === "timed" || timing.kind === "invalid") && !ignoreTimestamps;
  const overridden =
    timing.kind === "timed" &&
    (firstStart !== formatSeconds(timing.first) || lastStart !== formatSeconds(timing.last));

  // Fill the two fields from the first and last caption once per detected pair (a new
  // transcript), never on later renders, so the user's own edits stay.
  const fillFromCaptions = (next: TranscriptTiming, force = false) => {
    const key = captionKey(next);
    if (next.kind !== "timed" || key === null || (!force && filledFrom.current === key)) return;
    filledFrom.current = key;
    setFirstStart(formatSeconds(next.first));
    setLastStart(formatSeconds(next.last));
  };

  const changeTranscript = (value: string) => {
    setTranscript(value);
    if (!ignoreTimestamps) fillFromCaptions(analyzeTranscriptTiming(value));
  };

  const changeIgnore = (ignore: boolean) => {
    setIgnoreTimestamps(ignore);
    if (!ignore) fillFromCaptions(timing);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const job = await api.createJob({
        transcript,
        first_sentence_start: firstStart,
        last_sentence_start: lastStart,
        voice,
        speed,
        // Only sent for timed transcripts; a plain request is unchanged (the server's default).
        ...(usesTimestamps ? { timing_mode: "timed" as const } : {}),
      });
      onJobCreated(job);
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) {
        onSessionExpired();
        return;
      }
      if (err instanceof ApiError && err.fields.length > 0) {
        setFieldErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.message])));
      }
      setFormError(err instanceof ApiError ? err.message : "Could not start dubbing.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="studio" onSubmit={submit} noValidate>
      <section className="panel panel-sky" aria-label="Transcript and timing">
        <div className="panel-head">
          <label htmlFor="transcript" className="panel-title">
            English Transcript
          </label>
          <span className="small muted">English → Vietnamese</span>
        </div>
        <textarea
          id="transcript"
          rows={10}
          value={transcript}
          onChange={(e) => changeTranscript(e.target.value)}
          placeholder="Paste the English transcript (with or without timestamps)…"
          aria-invalid={Boolean(fieldErrors.transcript)}
        />
        <FieldMessage message={fieldErrors.transcript} />
        <TranscriptTimingPanel
          timing={timing}
          ignore={ignoreTimestamps}
          onIgnoreChange={changeIgnore}
          overridden={overridden}
          selectedBaseline={preview}
          onUseTranscriptTimes={() => fillFromCaptions(timing, true)}
        />

        <div className="times">
          <TimestampInput
            id="first-start"
            label="First Sentence Start Time"
            value={firstStart}
            onChange={setFirstStart}
            error={fieldErrors.first_sentence_start}
          />
          <TimestampInput
            id="last-start"
            label="Last Sentence Start Time"
            value={lastStart}
            onChange={setLastStart}
            error={fieldErrors.last_sentence_start}
          />
        </div>
        <p className="small muted">Use the start times from your original transcript.</p>
        <details className="disclosure plain">
          <summary>How timing works</summary>
          <p className="small muted">
            The audio length is the time between the two start times. At 1x the audio fits that
            time; another speed makes the audio file shorter or longer.
          </p>
          <p className="small muted">
            With a timestamped transcript (a time such as 0:05 above each caption), each sentence
            is placed near its caption time. Times inside a caption are estimated from word
            counts, and sentences whose speech is too long for their time are grouped with a
            neighbour, so the timing is approximate, not exact per sentence.
          </p>
        </details>
      </section>

      <aside className="panel panel-sand" aria-label="Voice and speed settings">
        <VoiceField voices={voices} value={voice} onChange={setVoice} error={fieldErrors.voice} />
        <SpeedField value={speed} onChange={setSpeed} error={fieldErrors.speed} />
        <LengthSummary baselineSeconds={preview} speed={speed} />

        {formError && (
          <p className="error" role="alert">
            {formError}
          </p>
        )}
        {disclosure && (
          <p className="small muted" id="azure-disclosure">
            {disclosure} See Privacy below.
          </p>
        )}
        <button
          type="submit"
          className="button primary wide"
          disabled={submitting}
          aria-describedby={disclosure ? "azure-disclosure" : undefined}
        >
          {submitting ? "Submitting…" : "Generate audio"}
        </button>
      </aside>
    </form>
  );
}
