import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "../../api/client";
import type { YouTubeImport } from "../../api/types";

export type ImportStatus =
  | { kind: "idle" }
  // The form already has text or times: the user decides before anything is sent.
  | { kind: "confirm" }
  | { kind: "loading" }
  | { kind: "error"; message: string; urlError: boolean }
  | { kind: "cancelled"; message: string }
  | { kind: "done"; result: YouTubeImport };

/**
 * One YouTube caption import at a time. Only the latest import may write into the form: an
 * answer that arrives after it was cancelled (the form was edited, the source switched, another
 * import started) or after the form went away (sign out, session ended, another user) is dropped.
 * Nothing is kept outside React state, and nothing is written to browser storage.
 *
 * `onFinished` (guests: refresh the import quota) runs once an import has ended, or was cancelled
 * here (the server may still finish and count it); never after the form went away, and never by
 * itself: nothing is imported again on mount, restore or a quota refresh.
 */
export function useYouTubeImport(onSessionExpired: () => void, onFinished?: () => void) {
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle" });
  // Identifies the current import; any other answer is stale.
  const current = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(
    () => () => {
      current.current += 1;
      controller.current?.abort();
    },
    [],
  );

  const start = useCallback(
    (url: string, apply: (result: YouTubeImport) => void) => {
      if (controller.current) return; // already importing: a second click sends nothing
      const id = current.current + 1;
      current.current = id;
      const abort = new AbortController();
      controller.current = abort;
      setStatus({ kind: "loading" });
      api
        .importYouTube(url, abort.signal)
        .then((result) => {
          if (id !== current.current) return;
          controller.current = null;
          apply(result);
          setStatus({ kind: "done", result });
          finished.current?.();
        })
        .catch((err: unknown) => {
          if (id !== current.current) return;
          controller.current = null;
          if (err instanceof ApiError && err.isUnauthenticated) {
            onSessionExpired();
            return;
          }
          finished.current?.();
          setStatus({
            kind: "error",
            message: err instanceof ApiError ? err.message : "The import failed.",
            urlError: err instanceof ApiError && err.fields.some((f) => f.field === "url"),
          });
        });
    },
    [onSessionExpired],
  );

  /** Cancel a running import (its answer will be ignored); nothing in the form changes. */
  const cancel = useCallback((message: string) => {
    if (!controller.current) return;
    stop(current, controller);
    setStatus({ kind: "cancelled", message });
    finished.current?.();
  }, []);

  /** Forget any import state, e.g. when the user goes back to pasting. */
  const reset = useCallback(() => {
    const running = controller.current !== null;
    stop(current, controller);
    setStatus({ kind: "idle" });
    if (running) finished.current?.();
  }, []);

  return { status, setStatus, start, cancel, reset, importing: status.kind === "loading" };
}

function stop(current: { current: number }, controller: { current: AbortController | null }) {
  current.current += 1;
  controller.current?.abort();
  controller.current = null;
}
