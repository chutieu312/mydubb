import { useRef, useState } from "react";

interface Props {
  // Starts (or resumes) a guest session; resolves to an error message, or null on success.
  onTry: () => Promise<string | null>;
  jobsPerSession: number;
  maxWords: number;
  disabled?: boolean;
}

/** "Try as guest" under the sign-in form: no account, a few short jobs. */
export function GuestEntry({ onTry, jobsPerSession, maxWords, disabled = false }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref (not state) blocks a second click before React re-renders the disabled button.
  const busy = useRef(false);

  const start = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const failure = await onTry();
      // On success this screen is replaced by the Studio; only a failure is shown here.
      if (failure !== null) setError(failure);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <div className="guest-entry stack">
      <p className="muted small">
        No invitation yet? Try MyDubb as a guest: up to {jobsPerSession} audio jobs of up to{" "}
        {maxWords.toLocaleString("en-US")} words each, without an account.
      </p>
      {error && (
        <p className="callout error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button ghost wide"
        onClick={start}
        disabled={pending || disabled}
      >
        {pending ? "Starting guest session…" : "Try as guest"}
      </button>
    </div>
  );
}
