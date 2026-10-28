import { useEffect, useRef, type KeyboardEvent } from "react";

import { formatClock } from "../../lib/speed";
import type { ImportStatus } from "./useYouTubeImport";

export type Source = "paste" | "youtube";

/** Guest mode: the import quota and the job limits an imported transcript may go over. */
export interface GuestImportInfo {
  // Imports left (the server's numbers), counted apart from audio jobs.
  left: number;
  // Why no import is left, or null.
  limitText: string | null;
  maxWords: number;
  maxOutputSeconds: number;
  // What the form's current content is over ("about 1,200 words (at most 1,000)"); empty if none.
  overLimits: string[];
}

interface Props {
  source: Source;
  onSourceChange: (source: Source) => void;
  url: string;
  onUrlChange: (url: string) => void;
  status: ImportStatus;
  onImport: () => void;
  onConfirm: () => void;
  onKeep: () => void;
  guest?: GuestImportInfo;
}

const SOURCES: { value: Source; label: string }[] = [
  { value: "paste", label: "Paste transcript" },
  { value: "youtube", label: "YouTube URL" },
];

/**
 * Where the transcript comes from. Importing only fills the form: the user reviews and edits the
 * text and the start times, then chooses Generate audio. Nothing is imported until the user asks
 * (button or Enter), never on paste or when the field appears.
 */
export function TranscriptSource({
  source,
  onSourceChange,
  url,
  onUrlChange,
  status,
  onImport,
  onConfirm,
  onKeep,
  guest,
}: Props) {
  const importing = status.kind === "loading";
  const urlError = status.kind === "error" && status.urlError;
  const urlInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);

  // The confirmation closes either way; focus goes back where the user was, not to the page.
  const confirm = () => {
    onConfirm();
    urlInput.current?.focus();
  };
  const keep = () => {
    onKeep();
    importButton.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter would otherwise submit the whole form (Generate audio).
    if (event.key === "Enter") {
      event.preventDefault();
      onImport();
    }
  };

  return (
    <div className="stack">
      <fieldset className="field">
        <legend className="sr-only">Transcript source</legend>
        <div className="source-group">
          {SOURCES.map((option) => (
            <label key={option.value} className="choice-option">
              <input
                type="radio"
                name="transcript-source"
                value={option.value}
                checked={source === option.value}
                onChange={() => onSourceChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {source === "youtube" && (
        <div className="field">
          <label htmlFor="youtube-url">YouTube video link</label>
          <div className="import-row">
            <input
              ref={urlInput}
              id="youtube-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-invalid={urlError}
              aria-describedby={urlError ? "youtube-disclosure import-error" : "youtube-disclosure"}
            />
            <button
              ref={importButton}
              type="button"
              className="button ghost"
              onClick={onImport}
              disabled={importing}
            >
              {importing ? "Importing…" : "Import transcript"}
            </button>
          </div>
          <p className="small muted" id="youtube-disclosure">
            The link is sent to Supadata to fetch the English captions the video already has. The
            audio is not transcribed.
          </p>
          {guest && (
            <p className="small muted" id="youtube-guest-limits">
              {guest.left} guest {guest.left === 1 ? "import" : "imports"} left, counted apart from
              your audio jobs; a successful import counts even if you do not generate audio. A long
              video can go over the guest limits of {guest.maxWords.toLocaleString("en-US")} words
              and {formatClock(guest.maxOutputSeconds)} of audio per job: the whole transcript is
              still imported, and you shorten it before generating.
            </p>
          )}
          {guest?.limitText && (
            <p className="callout warning small" role="status">
              {guest.limitText}
            </p>
          )}
          {status.kind === "confirm" && <ReplaceConfirm onConfirm={confirm} onKeep={keep} />}
          {status.kind === "error" && (
            <p className="error" id="import-error" role="alert">
              {status.message} Nothing in the form was changed.
            </p>
          )}
          <div aria-live="polite" className="small">
            {importing && <p className="muted">Importing captions… This can take up to a minute.</p>}
            {status.kind === "cancelled" && <p className="muted">{status.message}</p>}
            {status.kind === "done" && (
              <ImportSummary status={status} overLimits={guest?.overLimits ?? []} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReplaceConfirm({ onConfirm, onKeep }: { onConfirm: () => void; onKeep: () => void }) {
  const replace = useRef<HTMLButtonElement>(null);
  useEffect(() => replace.current?.focus(), []);
  return (
    <div
      className="callout warning confirm"
      role="group"
      aria-labelledby="import-confirm-text"
      onKeyDown={(event) => {
        if (event.key === "Escape") onKeep();
      }}
    >
      <p id="import-confirm-text">
        Importing replaces the transcript and both start times in the form. Replace them?
      </p>
      <div className="confirm-actions">
        <button ref={replace} type="button" className="button primary" onClick={onConfirm}>
          Replace and import
        </button>
        <button type="button" className="button ghost" onClick={onKeep}>
          Keep my text
        </button>
      </div>
    </div>
  );
}

function ImportSummary({
  status,
  overLimits,
}: {
  status: Extract<ImportStatus, { kind: "done" }>;
  overLimits: string[];
}) {
  const { result } = status;
  const captions = result.caption_count === 1 ? "caption" : "captions";
  const skipped = result.skipped_empty_captions;
  return (
    <div className="callout">
      <p>
        Imported {result.caption_count} English {captions}. Review and edit the transcript, then
        choose Generate audio.
      </p>
      {skipped > 0 && (
        <p>
          {skipped} empty {skipped === 1 ? "caption was" : "captions were"} left out.
        </p>
      )}
      {result.first_sentence_start && result.last_sentence_start ? (
        <p>
          The start times were filled from the first and last caption, in whole seconds. Check
          them before generating.
        </p>
      ) : (
        <p>
          <strong>Set both start times before generating:</strong> the captions do not start at
          two different seconds, so they cannot be filled in.
        </p>
      )}
      {overLimits.length > 0 && (
        <p className="error">
          <strong>Over the guest limits:</strong> {overLimits.join(" and ")}. Nothing was cut and
          no time was changed: shorten the transcript, choose a shorter stretch between the start
          times or a faster speed before generating, or sign in with your invitation.
        </p>
      )}
    </div>
  );
}
