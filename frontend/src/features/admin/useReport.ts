import { useEffect, useRef, useState } from "react";

import { ApiError } from "../../api/client";

export interface AccessHandlers {
  // 401: the session ended.
  onSessionExpired: () => void;
  // 403 admin_required: still signed in, no longer an administrator.
  onAccessEnded: () => void;
}

export type Report<T> =
  | { status: "loading"; retry: () => void }
  | { status: "ready"; data: T; retry: () => void }
  | { status: "error"; error: ApiError; retry: () => void };

type Settled<T> = { key: string; data: T; error?: never } | { key: string; error: ApiError };

const UNEXPECTED = "The usage report could not be loaded. Please try again.";

/**
 * One report request per `key`. An answer is kept with the key it was asked for and shown only
 * while that key is the current one, so figures of older filters are never shown under new ones;
 * a change of key or leaving the page also aborts the request. Reads only when the key changes or
 * on retry: never on a timer, focus or visibility.
 */
export function useReport<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  { onSessionExpired, onAccessEnded }: AccessHandlers,
): Report<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${key}#${attempt}`;
  const latest = useRef({ load, onSessionExpired, onAccessEnded });

  useEffect(() => {
    latest.current = { load, onSessionExpired, onAccessEnded };
  });

  useEffect(() => {
    const controller = new AbortController();
    latest.current
      .load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSettled({ key: requestKey, data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.isUnauthenticated) {
          latest.current.onSessionExpired();
        } else if (err instanceof ApiError && err.code === "admin_required") {
          latest.current.onAccessEnded();
        } else {
          setSettled({
            key: requestKey,
            error: err instanceof ApiError ? err : new ApiError(0, "unexpected", UNEXPECTED),
          });
        }
      });
    return () => controller.abort();
  }, [requestKey]);

  const retry = () => setAttempt((n) => n + 1);
  if (settled?.key !== requestKey) return { status: "loading", retry };
  return settled.error
    ? { status: "error", error: settled.error, retry }
    : { status: "ready", data: settled.data as T, retry };
}
