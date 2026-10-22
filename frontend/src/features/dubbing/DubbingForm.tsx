import { useState, type FormEvent } from "react";

import { ApiError, api } from "../../api/client";
import type { Job, VoiceOption } from "../../api/types";
import { formatSeconds, previewTargetDuration } from "../../lib/timestamps";

interface Props {
  voices: VoiceOption[];
  // Submitting sends the transcript text to Azure for translation.
  sendsToAzure: boolean;
  onJobCreated: (job: Job) => void;
  onSessionExpired: () => void;
}

type FieldErrors = Partial<Record<string, string>>;

export function DubbingForm({ voices, sendsToAzure, onJobCreated, onSessionExpired }: Props) {
  const [transcript, setTranscript] = useState("");
  const [firstStart, setFirstStart] = useState("");
  const [lastStart, setLastStart] = useState("");
  const [voice, setVoice] = useState(voices[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

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
    <form className="card stack" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="transcript">English Transcript</label>
        <textarea
          id="transcript"
          rows={10}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste the English transcript (with or without timestamps)…"
          aria-invalid={Boolean(fieldErrors.transcript)}
        />
        <FieldMessage message={fieldErrors.transcript} />
      </div>

      <div className="row">
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

      <p className="muted">
        Target duration (Last Start − First Start):{" "}
        <strong>{preview === null ? "—" : `${formatSeconds(preview)} (${preview} s)`}</strong>
        <br />
        <small>Preview only; the server validates and calculates the final value.</small>
      </p>

      <fieldset className="field">
        <legend>Vietnamese voice</legend>
        <div className="row">
          {voices.map((v) => (
            <label key={v.id} className="choice">
              <input
                type="radio"
                name="voice"
                value={v.id}
                checked={voice === v.id}
                onChange={() => setVoice(v.id)}
              />
              {v.id} <span className="muted">({v.description})</span>
            </label>
          ))}
        </div>
        <FieldMessage message={fieldErrors.voice} />
      </fieldset>

      {formError && (
        <p className="error" role="alert">
          {formError}
        </p>
      )}
      {sendsToAzure && (
        <p className="privacy-notice" id="azure-disclosure">
          When you generate dubbing, the transcript text is sent to Microsoft Azure Translator
          to be translated.
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        aria-describedby={sendsToAzure ? "azure-disclosure" : undefined}
      >
        {submitting ? "Submitting…" : "Generate Dubbing"}
      </button>
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
        placeholder="HH:MM:SS"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={Boolean(props.error)}
      />
      <FieldMessage message={props.error} />
    </div>
  );
}

function FieldMessage({ message }: { message?: string }) {
  return message ? <p className="error">{message}</p> : null;
}
