import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { ApiError, api } from "../../api/client";
import type { Job, VoiceOption, YouTubeImport } from "../../api/types";
import { DEFAULT_SPEED } from "../../lib/speed";
import type { StudioDraft } from "../../lib/studioDraft";
import { formatSeconds, previewTargetDuration } from "../../lib/timestamps";
import { analyzeTranscriptTiming, type TranscriptTiming } from "../../lib/transcriptTiming";
import { FieldMessage } from "./FieldMessage";
import { LengthSummary } from "./LengthSummary";
import { SpeedField } from "./SpeedField";
import { TimestampInput } from "./TimestampInput";
import { TranscriptSource, type Source } from "./TranscriptSource";
import { TranscriptTimingPanel } from "./TranscriptTimingPanel";
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

// The caption pair the two time fields were last filled from.
function captionKey(timing: TranscriptTiming): string | null {
  return timing.kind === "timed" ? `${timing.first}-${timing.last}` : null;
}

// The two fields for the first and last caption: their starts truncated to whole seconds (the
// fields' HH:MM:SS contract, as the import suggests them). Null when both fall in the same second.
function fieldsFromCaptions(timing: { first: number; last: number }) {
  const first = Math.floor(timing.first);
  const last = Math.floor(timing.last);
  return last > first ? { first: formatSeconds(first), last: formatSeconds(last) } : null;
}

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
  const [ignoreTimestamps, setIgnoreTimestamps] = useState(initialDraft?.ignoreTimestamps ?? false);
  // A restored draft keeps its own field values: its captions count as already filled.
  const filledFrom = useRef<string | null>(
    captionKey(analyzeTranscriptTiming(initialDraft?.transcript ?? "")),
  );
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("paste");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const importer = useYouTubeImport(onSessionExpired);

  useEffect(() => {
    onDraftChange?.({ transcript, firstStart, lastStart, voice, speed, ignoreTimestamps });
  }, [onDraftChange, transcript, firstStart, lastStart, voice, speed, ignoreTimestamps]);

  const timing = useMemo(() => analyzeTranscriptTiming(transcript), [transcript]);
  const preview = previewTargetDuration(firstStart, lastStart);
  const usesTimestamps =
    (timing.kind === "timed" || timing.kind === "invalid") && !ignoreTimestamps;
  const captionFields = timing.kind === "timed" ? fieldsFromCaptions(timing) : null;
  const overridden =
    captionFields !== null &&
    (firstStart !== captionFields.first || lastStart !== captionFields.last);

  // Fill the two fields from the first and last caption once per detected pair (a new
  // transcript, pasted or imported), never on later renders, so the user's own edits stay.
  const fillFromCaptions = (next: TranscriptTiming, force = false) => {
    const key = captionKey(next);
    if (next.kind !== "timed" || key === null || (!force && filledFrom.current === key)) return;
    filledFrom.current = key;
    // First and last caption in the same whole second: no baseline to suggest, the user sets it.
    const fields = fieldsFromCaptions(next) ?? { first: "", last: "" };
    setFirstStart(fields.first);
    setLastStart(fields.last);
  };

  const changeTranscript = (value: string) => {
    setTranscript(value);
    if (!ignoreTimestamps) fillFromCaptions(analyzeTranscriptTiming(value));
  };

  const changeIgnore = (ignore: boolean) => {
    setIgnoreTimestamps(ignore);
    if (!ignore) fillFromCaptions(timing);
  };

  // An import still running must not overwrite what the user is typing. Timing is always read
  // from what the box holds, so an edited import is timed by its edited captions.
  const editTranscript = (value: string) => {
    importer.cancel(EDITED_DURING_IMPORT);
    changeTranscript(value);
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
    // form holds then, edits included. No other copy of the captions is kept: the imported
    // transcript goes through the same timing detection as a pasted one.
    setTranscript(result.transcript);
    const next = analyzeTranscriptTiming(result.transcript);
    if (next.kind === "timed") {
      // Gives the server's suggestions (whole seconds of the first and last caption, or empty
      // when both start in the same second), from the same rule as for a pasted transcript.
      fillFromCaptions(next, true);
    } else {
      setFirstStart(result.first_sentence_start ?? "");
      setLastStart(result.last_sentence_start ?? "");
    }
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
        <TranscriptTimingPanel
          timing={timing}
          ignore={ignoreTimestamps}
          onIgnoreChange={changeIgnore}
          overridden={overridden}
          selectedBaseline={preview}
          onUseTranscriptTimes={() => fillFromCaptions(timing, true)}
          needsTimes={timing.kind === "timed" && captionFields === null}
        />

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
          disabled={submitting || importer.importing}
          aria-describedby={disclosure ? "azure-disclosure" : undefined}
        >
          {submitting ? "Submitting…" : "Generate audio"}
        </button>
      </aside>
    </form>
  );
}
