import { useEffect, useRef, useState, type FormEvent } from "react";

import type { Failure } from "../../features/auth/errors";
import { FormError, TextField } from "../../features/auth/fields";
import {
  CODE_FORMAT_TEXT,
  isValidCode,
  normalizeCode,
} from "../../features/auth/newPasswordValidation";
import { useSubmit } from "../../features/auth/useSubmit";
import { RESEND_WAIT_SECONDS, type MockSignup } from "./mockSignup";

interface Props {
  service: MockSignup;
  email: string;
  onVerified: () => void;
  onChangeEmail: () => void;
  onBackToSignIn: () => void;
}

type Action = "verify" | "resend";

const WRONG = "That code isn't right. Check the email and try again.";
const EXPIRED = "This code has expired. Choose Resend code to get a new one.";
const UNAVAILABLE: Failure = {
  message: "We can't verify codes right now. Please try again in a moment.",
  keepInput: true,
  retryAfterSeconds: null,
};

/** Counts down once per second, like the wait the real service will impose between codes. */
function useCountdown(): [number, (seconds: number) => void] {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds((left) => left - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds];
}

/** Verify and Resend share one lock, so they never run together (also not via Enter). */
export function VerifyCodeForm({ service, email, onVerified, onChangeEmail, onBackToSignIn }: Props) {
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [last, setLast] = useState<Action | null>(null);
  const [wait, setWait] = useCountdown();
  const { pending, failure, run } = useSubmit();
  const formRef = useRef<HTMLFormElement>(null);

  const verifying = pending && last === "verify";
  const sending = pending && last === "resend";

  // The box that the message is about gets the keyboard focus back (nothing here is disabled
  // while a request runs, so focus is not lost on the way).
  const focusCode = () => formRef.current?.querySelector<HTMLElement>("input")?.focus();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const clean = normalizeCode(code);
    if (!isValidCode(clean)) {
      setCodeError(CODE_FORMAT_TEXT);
      focusCode();
      return;
    }
    setCodeError(null);
    setResent(false);
    setLast("verify");
    await run(async () => {
      const result = await service.verify(clean);
      if (result === "verified") {
        onVerified();
        return null;
      }
      if (result === "unavailable") return UNAVAILABLE;
      // A refused code is shown beside the box it was typed in.
      setCodeError(result === "expired" ? EXPIRED : WRONG);
      focusCode();
      return null;
    });
  };

  const resend = async () => {
    if (pending) return;
    setLast("resend");
    setCodeError(null);
    await run(async () => {
      await service.resend();
      setCode("");
      setResent(true);
      setWait(RESEND_WAIT_SECONDS);
      focusCode();
      return null;
    });
  };

  return (
    <form ref={formRef} onSubmit={submit} className="stack" noValidate>
      <TextField
        label="Verification code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(value) => {
          setCode(value);
          setCodeError(null);
        }}
        error={codeError}
      />
      {last === "verify" && <FormError message={failure?.message} />}
      <button type="submit" className="button primary wide" aria-disabled={pending || undefined}>
        {verifying ? "Verifying…" : "Verify"}
      </button>

      <button type="button" className="button ghost wide" onClick={resend} disabled={pending || wait > 0}>
        {sending ? "Sending…" : wait > 0 ? `Resend available in ${wait}s` : "Resend code"}
      </button>
      {resent && !pending && (
        <p className="callout" role="status">
          We sent a new code to {email}. Earlier codes no longer work.
        </p>
      )}

      <div className="link-row">
        <button type="button" className="link-button" onClick={onChangeEmail} disabled={pending}>
          Use a different email
        </button>
        <button type="button" className="link-button" onClick={onBackToSignIn} disabled={pending}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}
