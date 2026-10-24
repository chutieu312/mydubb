import { useEffect, useState, type FormEvent } from "react";

import type { Outcome } from "./errors";
import { FormError, TextField } from "./fields";
import { CODE_FORMAT_TEXT, isValidCode, normalizeCode } from "./newPasswordValidation";
import { useSubmit } from "./useSubmit";

interface Props {
  onConfirm: (code: string) => Promise<Outcome>;
  onResend: () => Promise<Outcome>;
  onCancel: () => void;
}

/** Counts a server-imposed wait down once per second. */
function useCountdown(): [number, (seconds: number) => void] {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds((left) => left - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds];
}

type Action = "verify" | "resend";

/**
 * A code is sent only when the user presses Send/Resend, never by the page itself. Verify and
 * Resend share one lock, so they can never run at the same time (also not via the Enter key).
 */
export function VerifyEmailForm({ onConfirm, onResend, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [sentOnce, setSentOnce] = useState(false);
  const [last, setLast] = useState<Action | null>(null);
  const [wait, setWait] = useCountdown();
  const { pending, failure, run } = useSubmit();

  const verifying = pending && last === "verify";
  const sending = pending && last === "resend";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const clean = normalizeCode(code);
    if (!isValidCode(clean)) {
      setCodeError(CODE_FORMAT_TEXT);
      return;
    }
    setCodeError(null);
    setLast("verify");
    const outcome = await run(() => onConfirm(clean));
    if (outcome && !outcome.keepInput) setCode("");
  };

  const sendCode = async () => {
    if (pending) return;
    setLast("resend");
    const outcome = await run(() => onResend());
    if (outcome === undefined) return;
    if (outcome === null) {
      setSentOnce(true);
      setWait(0);
    } else if (outcome.retryAfterSeconds) {
      // The server limits how often a code can be sent; honour its wait, never invent our own.
      setWait(Math.ceil(outcome.retryAfterSeconds));
    }
  };

  return (
    <form onSubmit={submit} className="stack">
      <TextField
        label="Verification code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={setCode}
        error={codeError}
        disabled={verifying}
      />
      {last === "verify" && <FormError message={failure?.message} />}
      <button
        type="submit"
        className="button primary wide"
        disabled={pending || code.trim() === ""}
      >
        {verifying ? "Verifying…" : "Verify email"}
      </button>

      <button
        type="button"
        className="button ghost wide"
        onClick={sendCode}
        disabled={pending || wait > 0}
      >
        {sending
          ? "Sending…"
          : wait > 0
            ? `Resend available in ${wait}s`
            : sentOnce
              ? "Resend code"
              : "Send code"}
      </button>
      {last === "resend" && <FormError message={failure?.message} />}
      {sentOnce && last === "resend" && !failure && !pending && (
        <p className="callout" role="status">
          A code is on its way. It may take a minute to arrive.
        </p>
      )}

      <button type="button" className="link-button" onClick={onCancel} disabled={pending}>
        Back to sign in
      </button>
    </form>
  );
}
