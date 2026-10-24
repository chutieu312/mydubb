import { useCallback, useRef, useState } from "react";

import type { Failure, Outcome } from "./errors";

/**
 * Runs one async form action at a time. A ref (not state) blocks a second submit before React
 * re-renders the disabled button, so a double click or Enter-then-click sends one request.
 */
export function useSubmit() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // Resolves to the action's outcome, or to undefined when it was ignored as a duplicate.
  const run = useCallback(async (action: () => Promise<Outcome>): Promise<Outcome | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      const outcome = await action();
      setFailure(outcome);
      return outcome;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  return { pending, failure, run, clearFailure: () => setFailure(null) };
}
