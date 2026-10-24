import { useEffect, useState, type FormEvent } from "react";

import type { Outcome } from "./errors";
import { FormError, TextField } from "./fields";
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

export function VerifyEmailForm({ onConfirm, onResend, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [sentOnce, setSentOnce] = useState(false);
  const [wait, setWait] = useCountdown();
  const confirm = useSubmit();
  const resend = useSubmit();
  const busy = confirm.pending || resend.pending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    resend.clearFailure();
    const outcome = await confirm.run(() => onConfirm(code.replace(/\s+/g, "")));
    if (outcome && !outcome.keepInput) setCode("");
  };

  const sendCode = async () => {
    confirm.clearFailure();
    const outcome = await resend.run(() => onResend());
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
        disabled={confirm.pending}
      />
      <FormError message={confirm.failure?.message} />
      <button
        type="submit"
        className="button primary wide"
        disabled={busy || code.trim() === ""}
      >
        {confirm.pending ? "Verifying…" : "Verify email"}
      </button>

      <button
        type="button"
        className="button ghost wide"
        onClick={sendCode}
        disabled={busy || wait > 0}
      >
        {resend.pending
          ? "Sending…"
          : wait > 0
            ? `Resend available in ${wait}s`
            : sentOnce
              ? "Resend code"
              : "Send code"}
      </button>
      <FormError message={resend.failure?.message} />
      {sentOnce && !resend.failure && !resend.pending && (
        <p className="callout" role="status">
          A code is on its way. It may take a minute to arrive.
        </p>
      )}

      <button type="button" className="link-button" onClick={onCancel} disabled={busy}>
        Back to sign in
      </button>
    </form>
  );
}
