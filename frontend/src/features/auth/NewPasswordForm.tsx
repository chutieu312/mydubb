import { useState, type FormEvent } from "react";

import type { Outcome } from "./errors";
import { FormError } from "./fields";
import { NewPasswordFields } from "./NewPasswordFields";
import { validateNewPassword, type NewPasswordErrors } from "./newPasswordValidation";
import { useSubmit } from "./useSubmit";

interface Props {
  onSubmit: (newPassword: string) => Promise<Outcome>;
  onCancel: () => void;
}

/** "Set your password": first sign-in with a temporary password. */
export function NewPasswordForm({ onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<NewPasswordErrors>({});
  const { pending, failure, run } = useSubmit();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateNewPassword(password, confirm);
    setErrors(found);
    if (found.confirm) return;

    const outcome = await run(() => onSubmit(password));
    if (outcome !== undefined && !outcome?.keepInput) {
      setPassword("");
      setConfirm("");
    }
  };

  return (
    <form onSubmit={submit} className="stack">
      <NewPasswordFields
        password={password}
        confirm={confirm}
        onPassword={setPassword}
        onConfirm={setConfirm}
        errors={errors}
        disabled={pending}
      />
      <FormError message={failure?.message} />
      <button type="submit" className="button primary wide" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </button>
      <button type="button" className="link-button" onClick={onCancel} disabled={pending}>
        Back to sign in
      </button>
    </form>
  );
}
