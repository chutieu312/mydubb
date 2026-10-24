import { useState, type FormEvent } from "react";

import type { Outcome } from "./errors";
import { FormError, TextField } from "./fields";
import { NewPasswordFields } from "./NewPasswordFields";
import {
  CODE_FORMAT_TEXT,
  isValidCode,
  normalizeCode,
  validateNewPassword,
  type NewPasswordErrors,
} from "./newPasswordValidation";
import { useSubmit } from "./useSubmit";

interface RequestProps {
  initialEmail: string;
  onSubmit: (email: string) => Promise<Outcome>;
  onBack: () => void;
}

/** Step 1: ask for the email. The next screen says the same thing whether or not it exists. */
export function ForgotPasswordForm({ initialEmail, onSubmit, onBack }: RequestProps) {
  const [email, setEmail] = useState(initialEmail);
  const { pending, failure, run } = useSubmit();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await run(() => onSubmit(email.trim()));
  };

  return (
    <form onSubmit={submit} className="stack">
      <TextField
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="username"
        value={email}
        onChange={setEmail}
        disabled={pending}
      />
      <FormError message={failure?.message} />
      <button
        type="submit"
        className="button primary wide"
        disabled={pending || email.trim() === ""}
      >
        {pending ? "Sending…" : "Send code"}
      </button>
      <button type="button" className="link-button" onClick={onBack} disabled={pending}>
        Back to sign in
      </button>
    </form>
  );
}

interface ResetProps {
  onSubmit: (code: string, newPassword: string) => Promise<Outcome>;
  onRequestNewCode: () => void;
  onBack: () => void;
}

/** Step 2: the emailed code and the new password. */
export function ResetPasswordForm({ onSubmit, onRequestNewCode, onBack }: ResetProps) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<NewPasswordErrors>({});
  const [codeError, setCodeError] = useState<string | null>(null);
  const { pending, failure, run } = useSubmit();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateNewPassword(password, confirm);
    const clean = normalizeCode(code);
    setErrors(found);
    setCodeError(isValidCode(clean) ? null : CODE_FORMAT_TEXT);
    if (found.confirm || !isValidCode(clean)) return;

    const outcome = await run(() => onSubmit(clean, password));
    if (outcome !== undefined && !outcome?.keepInput) {
      setPassword("");
      setConfirm("");
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
        disabled={pending}
      />
      <NewPasswordFields
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
        errors={errors}
        disabled={pending}
      />
      <FormError message={failure?.message} />
      <button
        type="submit"
        className="button primary wide"
        disabled={pending || code.trim() === ""}
      >
        {pending ? "Saving…" : "Reset password"}
      </button>
      <button type="button" className="link-button" onClick={onRequestNewCode} disabled={pending}>
        Didn't get a code? Start again
      </button>
      <button type="button" className="link-button" onClick={onBack} disabled={pending}>
        Back to sign in
      </button>
    </form>
  );
}
