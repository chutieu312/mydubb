import { useState, type FormEvent } from "react";

import { FormError, PasswordField, TextField } from "./fields";
import type { Outcome } from "./errors";
import { useSubmit } from "./useSubmit";

interface Props {
  initialEmail: string;
  onSubmit: (email: string, password: string) => Promise<Outcome>;
  onForgotPassword: (email: string) => void;
}

export function SignInForm({ initialEmail, onSubmit, onForgotPassword }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const { pending, failure, run } = useSubmit();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const outcome = await run(() => onSubmit(email.trim(), password));
    // The password is not needed once the attempt ended, except to retry after a failure that
    // says nothing about it (network, server error).
    if (outcome !== undefined && !outcome?.keepInput) setPassword("");
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
      <PasswordField
        label="Password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        disabled={pending}
      />
      <FormError message={failure?.message} />
      <button
        type="submit"
        className="button primary wide"
        disabled={pending || email.trim() === "" || password === ""}
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <button
        type="button"
        className="link-button"
        onClick={() => onForgotPassword(email.trim())}
        disabled={pending}
      >
        Forgot password?
      </button>
      <p className="muted small">Access is currently by invitation only.</p>
    </form>
  );
}
