import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../../api/client";
import type { JobResult } from "../../api/types";
import { VIETNAMESE, type JobLanguage } from "../../lib/languages";
import { formatClock, speedLabel } from "../../lib/speed";
import { AudioDetails } from "./AudioDetails";

type ResultState =
  | { kind: "loading" }
  | { kind: "ready"; result: JobResult }
  | { kind: "expired"; message: string }
  | { kind: "error"; message: string };

interface Props {
  jobId: string;
  // The voice of this job, as the server stored it (not the voice picked on the form now).
  voiceLabel: string;
  // The language of this job, as the server stored it (Vietnamese for jobs without one).
  language?: JobLanguage;
  onSessionExpired: () => void;
}

const OLD_JOB_LANGUAGE: JobLanguage = {
  label: VIETNAMESE.label,
  noun: VIETNAMESE.noun,
  tag: VIETNAMESE.translator_language,
};

export function ResultView({
  jobId,
  voiceLabel,
  language = OLD_JOB_LANGUAGE,
  onSessionExpired,
}: Props) {
  const [state, setState] = useState<ResultState>({ kind: "loading" });
  const onExpiredRef = useRef(onSessionExpired);

  useEffect(() => {
    onExpiredRef.current = onSessionExpired;
  }, [onSessionExpired]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getResult(jobId, controller.signal)
      .then((result) => setState({ kind: "ready", result }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.isUnauthenticated) {
          onExpiredRef.current();
        } else if (err instanceof ApiError && err.code === "result_expired") {
          setState({ kind: "expired", message: err.message });
        } else {
          setState({
            kind: "error",
            message: err instanceof ApiError ? err.message : "Could not load the result.",
          });
        }
      });
    return () => controller.abort();
  }, [jobId]);

  if (state.kind === "loading") return <p className="muted">Loading result…</p>;
  if (state.kind === "expired") {
    return (
      <div className="callout warning" role="status">
        <strong>Result expired.</strong> {state.message} You can generate the audio again from the
        form above.
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="callout error" role="alert">
        {state.message}
      </p>
    );
  }

  const { result } = state;
  const { audio, translation } = result;
  const duration = audio.duration;
  const relation = result.speed > 1 ? "shorter" : "longer";

  return (
    <div className="result stack">
      <p className="success">
        <span aria-hidden="true">✓ </span>
        {audio.is_fixture ? "Mock sample ready" : "Audio ready"}
        {!audio.duration_adjusted && <span className="chip">Duration not adjusted</span>}
      </p>

      {audio.is_fixture && (
        <div className="callout warning">
          <strong>Sample audio, not your dubbing.</strong> This audio is a fixed development sample.
          It was NOT generated from your transcript and does NOT match the target duration.
        </div>
      )}

      {/* The file is already processed at the chosen speed, so the player stays at 1x. */}
      <audio controls preload="metadata" src={audio.url} className="player">
        Your browser does not support audio playback.
      </audio>

      <div className="result-actions">
        <dl className="facts">
          <div>
            <dt>Language</dt>
            <dd>{language.label}</dd>
          </div>
          <div>
            <dt>Voice</dt>
            <dd>{voiceLabel}</dd>
          </div>
          <div>
            <dt>Speed</dt>
            <dd>{speedLabel(result.speed)}</dd>
          </div>
          {duration ? (
            <>
              <div>
                <dt>Target length</dt>
                <dd>{formatClock(duration.target_seconds)}</dd>
              </div>
              <div>
                <dt>Actual length</dt>
                <dd>{formatClock(duration.mp3_decoded_seconds)}</dd>
              </div>
            </>
          ) : (
            <div>
              <dt>Planned length</dt>
              <dd>{formatClock(result.output_duration_seconds)}</dd>
            </div>
          )}
        </dl>
        <a className="button primary" href={audio.download_url} download>
          Download MP3
        </a>
      </div>

      {!audio.duration_adjusted && (
        <p className="callout warning small" aria-label="Audio speed">
          Selected speed {speedLabel(result.speed)} · baseline{" "}
          {formatClock(result.baseline_duration_seconds)} · planned length{" "}
          {formatClock(result.output_duration_seconds)}. This audio was not adjusted, so it does not
          have that length.
        </p>
      )}
      {audio.duration_adjusted && result.speed !== 1 && (
        <p className="callout warning small">
          At {speedLabel(result.speed)} this audio is {relation} than the time between your two
          timestamps, so it will not match the video&apos;s length for that stretch.
        </p>
      )}
      {result.timing && (
        <p className="callout small" aria-label="Transcript timing">
          Placed on the caption times ({result.timing.blocks} sentence blocks{result.timing.frames !== null && ` in ${result.timing.frames} parts`}). Caption timing is
          estimated: some sentences may be grouped together or start slightly off their caption
          time.
        </p>
      )}
      {!audio.is_fixture && (
        <p className="small muted">
          English terms outside our glossary can occasionally be pronounced imperfectly.
        </p>
      )}

      <details className="disclosure" open>
        <summary>
          {language.noun} translation
          {translation.is_illustrative && <span className="chip">Illustrative mock</span>}
        </summary>
        <div className="disclosure-body">
          {translation.is_illustrative && (
            <p className="small muted">This is placeholder text, not a real translation.</p>
          )}
          {/* Rendered as text: React escapes it, never interpreted as HTML. The language tag lets
              the browser choose suitable fonts and screen readers the right voice. */}
          <div className="translation" lang={translation.is_illustrative ? undefined : language.tag}>
            {translation.text}
          </div>
        </div>
      </details>

      <AudioDetails result={result} />

      <p className="small muted">
        Available until{" "}
        {new Date(result.expires_at).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
        . Download a copy to keep it.
      </p>
    </div>
  );
}
