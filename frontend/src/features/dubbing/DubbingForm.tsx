import { useState, type FormEvent } from "react";

import { ApiError, api } from "../../api/client";
import type { Job, VoiceOption } from "../../api/types";
import {
  AUDIO_SPEEDS,
  DEFAULT_SPEED,
  formatOutputDuration,
  previewOutputSeconds,
  speedLabel,
} from "../../lib/speed";
import { formatSeconds, previewTargetDuration } from "../../lib/timestamps";

interface Props {
  voices: VoiceOption[];
  // Says which text is sent to which Azure service on submit; null when nothing is.
  disclosure: string | null;
  onJobCreated: (job: Job) => void;
  onSessionExpired: () => void;
}

type FieldErrors = Partial<Record<string, string>>;

export function DubbingForm({ voices, disclosure, onJobCreated, onSessionExpired }: Props) {
  const [transcript, setTranscript] = useState("");
  const [firstStart, setFirstStart] = useState("");
  const [lastStart, setLastStart] = useState("");
  const [voice, setVoice] = useState(voices[0]?.id ?? "");
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
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

      <fieldset className="field" aria-describedby="speed-help">
        <legend>Audio speed</legend>
        <div className="speed-group">
          {AUDIO_SPEEDS.map((option) => (
            <label key={option} className="speed-option">
              <input
                type="radio"
                name="speed"
                value={option}
                checked={speed === option}
                onChange={() => setSpeed(option)}
              />
              <span>{speedLabel(option)}</span>
            </label>
          ))}
        </div>
        <p className="muted" id="speed-help">
          <small>
            1x fits the audio to the time between the two timestamps. Other speeds make the audio
            file shorter or longer than that time; the downloaded file itself changes.
          </small>
        </p>
        <FieldMessage message={fieldErrors.speed} />
      </fieldset>

      <div className="preview" aria-live="polite" aria-label="Audio length preview">
        <dl className="preview-list">
          <dt>Duration at 1x (Last Start − First Start)</dt>
          <dd>{preview === null ? "—" : `${formatSeconds(preview)} (${preview} s)`}</dd>
          <dt>Selected speed</dt>
          <dd>{speedLabel(speed)}</dd>
          <dt>Expected audio length</dt>
          <dd>
            <strong>
              {preview === null ? "—" : formatOutputDuration(previewOutputSeconds(preview, speed))}
            </strong>
          </dd>
        </dl>
        {preview !== null && speed !== DEFAULT_SPEED && (
          <p className="warning-inline">
            At {speedLabel(speed)} the audio will be {speed > DEFAULT_SPEED ? "shorter" : "longer"}{" "}
            than the time between the two timestamps, so it will not match the video&apos;s length
            for that stretch.
          </p>
        )}
        <small className="muted">
          Estimate only; the server validates the input and calculates the final length.
        </small>
      </div>

      <fieldset className="field">
        <legend>Voice</legend>
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
              {v.label} <span className="muted">({v.description})</span>
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
      {disclosure && (
        <p className="privacy-notice" id="azure-disclosure">
          {disclosure}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        aria-describedby={disclosure ? "azure-disclosure" : undefined}
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
