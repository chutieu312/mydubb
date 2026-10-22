import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../../api/client";
import { TERMINAL_STATUSES, type Job } from "../../api/types";

const POLL_INTERVAL_MS = 1000;
const MAX_CONSECUTIVE_ERRORS = 5;

interface PollingState {
  job: Job | null;
  error: string | null;
}

/**
 * Polls job status until the job is terminal, the session expires, polling fails
 * repeatedly, or the component unmounts.
 */
export function useJobPolling(jobId: string, onSessionExpired: () => void): PollingState {
  const [state, setState] = useState<PollingState>({ job: null, error: null });
  const onExpiredRef = useRef(onSessionExpired);

  useEffect(() => {
    onExpiredRef.current = onSessionExpired;
  }, [onSessionExpired]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let consecutiveErrors = 0;

    const poll = async () => {
      try {
        const job = await api.getJob(jobId, controller.signal);
        consecutiveErrors = 0;
        setState({ job, error: null });
        if (TERMINAL_STATUSES.includes(job.status)) return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.isUnauthenticated) {
          onExpiredRef.current();
          return;
        }
        consecutiveErrors += 1;
        const message = error instanceof ApiError ? error.message : "Unexpected error.";
        const notFound = error instanceof ApiError && error.status === 404;
        if (notFound || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          setState((prev) => ({ ...prev, error: `Stopped checking status: ${message}` }));
          return;
        }
        setState((prev) => ({ ...prev, error: `${message} Retrying…` }));
      }
      timer = window.setTimeout(poll, POLL_INTERVAL_MS * (1 + consecutiveErrors));
    };

    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [jobId]);

  return state;
}
