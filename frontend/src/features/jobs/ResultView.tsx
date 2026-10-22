import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../../api/client";
import type { JobResult } from "../../api/types";

type ResultState =
  | { kind: "loading" }
  | { kind: "ready"; result: JobResult }
  | { kind: "expired"; message: string }
  | { kind: "error"; message: string };

interface Props {
  jobId: string;
  onSessionExpired: () => void;
}

export function ResultView({ jobId, onSessionExpired }: Props) {
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

  if (state.kind === "loading") return <p>Loading result…</p>;
  if (state.kind === "expired") {
    return (
      <div className="notice expired" role="status">
        <strong>Result expired.</strong> {state.message}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="error" role="alert">
        {state.message}
      </p>
    );
  }

  const { result } = state;
  return (
    <div className="stack">
      {result.notices.length > 0 && (
        <ul className="notice">
          {result.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}

      <h3>
        Vietnamese translation
        {result.translation.is_illustrative ? (
          <span className="badge">Illustrative mock</span>
        ) : (
          result.translation.provider === "azure-translator" && (
            <span className="badge">Azure Translator</span>
          )
        )}
      </h3>
      {/* Rendered as text: React escapes it, never interpreted as HTML. */}
      <div className="translation">{result.translation.text}</div>

      <h3>
        Audio
        {result.audio.is_fixture && <span className="badge">Mock fixture</span>}
        {!result.audio.is_fixture && result.audio.provider === "azure-speech" && (
          <span className="badge">Azure Speech</span>
        )}
        {!result.audio.duration_adjusted && <span className="badge">Duration not adjusted</span>}
      </h3>
      <audio controls preload="metadata" src={result.audio.url} className="player">
        Your browser does not support audio playback.
      </audio>
      <a className="button" href={result.audio.download_url} download>
        Download MP3
      </a>
      <p className="muted">
        <small>
          Temporary result, available until {new Date(result.expires_at).toLocaleString()}.
        </small>
      </p>
    </div>
  );
}
