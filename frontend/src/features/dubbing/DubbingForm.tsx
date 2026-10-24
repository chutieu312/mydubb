import { useEffect, useState, type FormEvent } from "react";

import { ApiError, api } from "../../api/client";
import type { Job, VoiceOption } from "../../api/types";
import { DEFAULT_SPEED } from "../../lib/speed";
import type { StudioDraft } from "../../lib/studioDraft";
import { previewTargetDuration } from "../../lib/timestamps";
import { FieldMessage } from "./FieldMessage";
import { LengthSummary } from "./LengthSummary";
import { SpeedField } from "./SpeedField";
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
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    onDraftChange?.({ transcript, firstStart, lastStart, voice, speed });
  }, [onDraftChange, transcript, firstStart, lastStart, voice, speed]);

  const preview = previewTargetDuration(firstStart, lastStart);

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
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste the English transcript (with or without timestamps)…"
          aria-invalid={Boolean(fieldErrors.transcript)}
        />
        <FieldMessage message={fieldErrors.transcript} />

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

function TimestampInput(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="HH:MM:SS"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={Boolean(props.error)}
      />
      <FieldMessage message={props.error} />
    </div>
  );
}
