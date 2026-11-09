import { useEffect, useRef, useState, type FormEvent } from "react";

import type { Outcome } from "./errors";
import { FormError, TextField } from "./fields";
import { CODE_FORMAT_TEXT, isValidCode, normalizeCode } from "./newPasswordValidation";
import { useSubmit } from "./useSubmit";

interface Props {
  // The address the code was sent to; null when the user came from Sign in and types it here.
  email: string | null;
  onConfirm: (email: string, code: string) => Promise<Outcome>;
  onResend: (email: string) => Promise<Outcome>;
  onChangeEmail: (email: string) => void;
  onBackToSignIn: () => void;
}

type Action = "verify" | "resend";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_ERRORS = new Set(["code_invalid", "code_expired"]);

/** Counts down a wait the server asked for (Retry-After); never one invented here. */
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
export function VerifySignupForm({
  email: knownEmail,
  onConfirm,
  onResend,
  onChangeEmail,
  onBackToSignIn,
}: Props) {
  const [typedEmail, setTypedEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [last, setLast] = useState<Action | null>(null);
  const [resent, setResent] = useState(false);
  const [wait, setWait] = useCountdown();
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, failure, run } = useSubmit();
  const email = knownEmail ?? typedEmail.trim();

  const verifying = pending && last === "verify";
  const sending = pending && last === "resend";
  // Nothing here is disabled while a request runs, so focus can always be put back.
  const focusInput = (name: "email" | "code") =>
    formRef.current
      ?.querySelector<HTMLElement>(name === "code" ? 'input[inputmode="numeric"]' : 'input[type="email"]')
      ?.focus();

  const emailOk = () => {
    if (knownEmail !== null) return true;
    const message =
      email === ""
        ? "Enter the email address you used to create your account."
        : EMAIL_SHAPE.test(email)
          ? null
          : "Enter an email address like name@example.com.";
    setEmailError(message);
    if (message) focusInput("email");
    return message === null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !emailOk()) return;
    const clean = normalizeCode(code);
    if (!isValidCode(clean)) {
      setCodeError(CODE_FORMAT_TEXT);
      focusInput("code");
      return;
    }
    setCodeError(null);
    setResent(false);
    setLast("verify");
    const outcome = await run(() => onConfirm(email, clean));
    if (outcome && CODE_ERRORS.has(outcome.code ?? "")) {
      setCode("");
      setCodeError(outcome.message);
      focusInput("code");
    }
  };

  const resend = async () => {
    if (pending || !emailOk()) return;
    setLast("resend");
    setCodeError(null);
    setResent(false);
    const outcome = await run(() => onResend(email));
    if (outcome === undefined) return;
    if (outcome === null) {
      setCode("");
      setResent(true);
      focusInput("code");
    } else if (outcome.retryAfterSeconds) {
      setWait(Math.ceil(outcome.retryAfterSeconds));
    }
  };

  const formMessage = failure && !CODE_ERRORS.has(failure.code ?? "") ? failure.message : null;

  return (
    <form ref={formRef} onSubmit={submit} className="stack" noValidate>
      {knownEmail === null && (
        <TextField
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={typedEmail}
          onChange={(value) => {
            setTypedEmail(value);
            setEmailError(null);
          }}
          error={emailError}
        />
      )}
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
      {last === "verify" && <FormError message={formMessage} />}
      {/* aria-disabled, not disabled: a disabled button would drop the keyboard focus. */}
      <button type="submit" className="button primary wide" aria-disabled={pending || undefined}>
        {verifying ? "Verifying…" : "Verify"}
      </button>

      <button
        type="button"
        className="button ghost wide"
        onClick={resend}
        disabled={sending || wait > 0}
      >
        {sending ? "Sending…" : wait > 0 ? `Resend available in ${wait}s` : "Resend code"}
      </button>
      {last === "resend" && <FormError message={formMessage} />}
      {resent && !pending && (
        <p className="callout" role="status">
          If this address is waiting for verification, a new code is on its way. Use the code
          from the newest email. It may take a minute to arrive.
        </p>
      )}

      <div className="link-row">
        {/* Usable while a request waits: its late answer is ignored (PasswordAuthFlow). */}
        <button type="button" className="link-button" onClick={() => onChangeEmail(email)}>
          Use a different email
        </button>
        <button type="button" className="link-button" onClick={onBackToSignIn}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}
