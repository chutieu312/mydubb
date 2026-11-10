import { useEffect, useRef, useState, type FormEvent } from "react";

import type { Outcome } from "./errors";
import { FormError, PasswordField, TextField } from "./fields";
import { RecaptchaCheckbox } from "./RecaptchaCheckbox";
import { useSubmit } from "./useSubmit";

interface Props {
  siteKey: string;
  freePlan: string;
  initialEmail: string;
  onSubmit: (email: string, password: string, captchaToken: string) => Promise<Outcome>;
  // The answer was lost: the account may exist, so the user can go on with a code.
  onHaveCode: (email: string) => void;
  onBackToSignIn: () => void;
}

interface FieldErrors {
  email?: string;
  password?: string;
  captcha?: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email, password and Google's checkbox. The password rules belong to the identity service: the
 * server's answer (`password_rejected`) decides, the browser only checks that something was typed.
 */
export function CreateAccountForm({
  siteKey,
  freePlan,
  initialEmail,
  onSubmit,
  onHaveCode,
  onBackToSignIn,
}: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [resetSignal, setResetSignal] = useState(0);
  // Bumped when focus should move to the first field with a message.
  const [refusals, setRefusals] = useState(0);
  const [outcomeUnknown, setOutcomeUnknown] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, failure, run } = useSubmit();

  useEffect(() => {
    if (refusals === 0) return;
    const form = formRef.current;
    const target =
      form?.querySelector<HTMLElement>('input[aria-invalid="true"]') ??
      form?.querySelector<HTMLElement>(".recaptcha-box.invalid iframe");
    target?.focus();
  }, [refusals]);

  const clear = (field: keyof FieldErrors) =>
    setErrors((previous) => ({ ...previous, [field]: undefined }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const address = email.trim();
    const found: FieldErrors = {};
    if (address === "") found.email = "Enter your email address.";
    else if (!EMAIL_SHAPE.test(address)) found.email = "Enter an email address like name@example.com.";
    if (password === "") found.password = "Enter a password.";
    if (token === null) found.captcha = "Tick the box to show you are not a robot.";
    setErrors(found);
    setOutcomeUnknown(null);
    if (found.email || found.password || found.captcha) {
      setRefusals((n) => n + 1);
      return;
    }
    const outcome = await run(() => onSubmit(address, password, token as string));
    if (outcome === undefined || outcome === null) return;
    // The token was used up by this attempt, whatever the answer.
    setToken(null);
    setResetSignal((n) => n + 1);
    if (outcome.code === "captcha_invalid") {
      setErrors({ captcha: outcome.message });
      setRefusals((n) => n + 1);
    } else if (outcome.code === "password_rejected") {
      setPassword("");
      setErrors({ password: outcome.message });
      setRefusals((n) => n + 1);
    } else if (outcome.code === "signup_rejected") {
      setErrors({ email: outcome.message });
      setRefusals((n) => n + 1);
    } else if (outcome.code === "signup_outcome_unknown") {
      setOutcomeUnknown(address);
    }
  };

  const formMessage =
    failure && !["captcha_invalid", "password_rejected", "signup_rejected"].includes(failure.code ?? "")
      ? failure.message
      : null;

  return (
    <form ref={formRef} onSubmit={submit} className="stack" noValidate>
      <p className="callout small">{freePlan}</p>
      <TextField
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={(value) => {
          setEmail(value);
          clear("email");
        }}
        error={errors.email}
      />
      <PasswordField
        label="Password"
        autoComplete="new-password"
        value={password}
        onChange={(value) => {
          setPassword(value);
          clear("password");
        }}
        error={errors.password}
      />
      <RecaptchaCheckbox
        siteKey={siteKey}
        resetSignal={resetSignal}
        error={errors.captcha}
        onToken={(value) => {
          setToken(value);
          if (value) clear("captcha");
        }}
      />
      <FormError message={formMessage} />
      {outcomeUnknown && (
        <button type="button" className="button ghost wide" onClick={() => onHaveCode(outcomeUnknown)}>
          I received a code
        </button>
      )}
      {/* aria-disabled, not disabled: a disabled button would drop the keyboard focus. */}
      <button type="submit" className="button primary wide" aria-disabled={pending || undefined}>
        {pending ? "Creating account…" : "Create account"}
      </button>
      {/* Usable while a request waits: its late answer is ignored (PasswordAuthFlow). */}
      <button type="button" className="link-button" onClick={onBackToSignIn}>
        Back to sign in
      </button>
    </form>
  );
}
