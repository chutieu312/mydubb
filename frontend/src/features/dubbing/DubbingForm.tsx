import { useEffect, useState, type FormEvent } from "react";

import { ApiError, api } from "../../api/client";
import type { Job, VoiceOption, YouTubeImport } from "../../api/types";
import { DEFAULT_SPEED } from "../../lib/speed";
import type { StudioDraft } from "../../lib/studioDraft";
import { previewTargetDuration } from "../../lib/timestamps";
import { FieldMessage } from "./FieldMessage";
import { LengthSummary } from "./LengthSummary";
import { SpeedField } from "./SpeedField";
import { TimestampInput } from "./TimestampInput";
import { TranscriptSource, type Source } from "./TranscriptSource";
import { useYouTubeImport } from "./useYouTubeImport";
import { VoiceField } from "./VoiceField";

const EDITED_DURING_IMPORT =
  "Import cancelled because you edited the form. Nothing was replaced.";
const LINK_CHANGED_DURING_IMPORT =
  "Import cancelled because the link changed. Choose Import transcript to import it.";

interface Props {
  voices: VoiceOption[];
  // One line saying that the text is sent to an outside service on submit; null when it is not.
  disclosure: string | null;
  // The server can import a YouTube video's captions (GET /api/meta); otherwise paste only.
  youtubeImport?: boolean;
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
  youtubeImport = false,
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
  const [source, setSource] = useState<Source>("paste");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const importer = useYouTubeImport(onSessionExpired);

  useEffect(() => {
    onDraftChange?.({ transcript, firstStart, lastStart, voice, speed });
  }, [onDraftChange, transcript, firstStart, lastStart, voice, speed]);

  const preview = previewTargetDuration(firstStart, lastStart);

  // An import still running must not overwrite what the user is typing.
  const editTranscript = (value: string) => {
    importer.cancel(EDITED_DURING_IMPORT);
    setTranscript(value);
  };
  const editFirstStart = (value: string) => {
    importer.cancel(EDITED_DURING_IMPORT);
    setFirstStart(value);
  };
  const editLastStart = (value: string) => {
    importer.cancel(EDITED_DURING_IMPORT);
    setLastStart(value);
  };

  const changeSource = (next: Source) => {
    setSource(next);
    if (next === "paste") importer.reset();
  };

  const changeUrl = (value: string) => {
    setYoutubeUrl(value);
    if (importer.importing) importer.cancel(LINK_CHANGED_DURING_IMPORT);
    else if (importer.status.kind === "error") importer.reset();
  };

  const applyImport = (result: YouTubeImport) => {
    // The form holds the imported text as plain text; what is submitted later is whatever the
    // form holds then, edits included. No other copy of the captions is kept.
    setTranscript(result.transcript);
    setFirstStart(result.first_sentence_start ?? "");
    setLastStart(result.last_sentence_start ?? "");
    setFieldErrors({});
    setFormError(null);
  };

  const requestImport = () => {
    if (importer.importing || importer.status.kind === "confirm") return;
    const link = youtubeUrl.trim();
    if (!link) {
      importer.setStatus({ kind: "error", message: "Enter a YouTube video link.", urlError: true });
      return;
    }
    if (transcript.trim() || firstStart || lastStart) {
      importer.setStatus({ kind: "confirm" });
      return;
    }
    importer.start(link, applyImport);
  };

  const confirmImport = () => {
    importer.setStatus({ kind: "idle" });
    importer.start(youtubeUrl.trim(), applyImport);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Enter in a time field submits the form too; wait until the import has filled it.
    if (importer.importing) return;
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
        {/* One grid row above the transcript box, so the box keeps the stretching row. */}
        <div className="stack">
          <div className="panel-head">
            <label htmlFor="transcript" className="panel-title">
              English Transcript
            </label>
            <span className="small muted">English → Vietnamese</span>
          </div>
          {youtubeImport && (
            <TranscriptSource
              source={source}
              onSourceChange={changeSource}
              url={youtubeUrl}
              onUrlChange={changeUrl}
              status={importer.status}
              onImport={requestImport}
              onConfirm={confirmImport}
              onKeep={() => importer.setStatus({ kind: "idle" })}
            />
          )}
        </div>
        <textarea
          id="transcript"
          rows={10}
          value={transcript}
          onChange={(e) => editTranscript(e.target.value)}
          placeholder="Paste the English transcript (with or without timestamps)…"
          aria-invalid={Boolean(fieldErrors.transcript)}
        />
        <FieldMessage message={fieldErrors.transcript} />

        <div className="times">
          <TimestampInput
            id="first-start"
            label="First Sentence Start Time"
            value={firstStart}
            onChange={editFirstStart}
            error={fieldErrors.first_sentence_start}
          />
          <TimestampInput
            id="last-start"
            label="Last Sentence Start Time"
            value={lastStart}
            onChange={editLastStart}
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
          disabled={submitting || importer.importing}
          aria-describedby={disclosure ? "azure-disclosure" : undefined}
        >
          {submitting ? "Submitting…" : "Generate audio"}
        </button>
      </aside>
    </form>
  );
}
