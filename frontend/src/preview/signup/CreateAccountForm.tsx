import { useEffect, useRef, useState, type FormEvent } from "react";

import { FormError, PasswordField, TextField } from "../../features/auth/fields";
import type { Failure } from "../../features/auth/errors";
import { useSubmit } from "../../features/auth/useSubmit";
import { CaptchaPlaceholder } from "./CaptchaPlaceholder";
import { validateCreate, type CreateErrors, type MockSignup } from "./mockSignup";

interface Props {
  service: MockSignup;
  initialEmail: string;
  onCreated: (email: string) => void;
  onBackToSignIn: () => void;
}

const UNAVAILABLE: Failure = {
  message: "We can't create accounts right now. Please try again in a moment.",
  keepInput: true,
  retryAfterSeconds: null,
};

export function CreateAccountForm({ service, initialEmail, onCreated, onBackToSignIn }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState(false);
  const [errors, setErrors] = useState<CreateErrors>({});
  // Bumped on each refused submit so focus moves to the first field that needs attention.
  const [refusals, setRefusals] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, failure, run } = useSubmit();

  useEffect(() => {
    if (refusals > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);

  // Editing a field withdraws the message that was about it.
  const clear = (field: keyof CreateErrors) =>
    setErrors((previous) => ({ ...previous, [field]: undefined }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const found = validateCreate(email, password, captcha);
    setErrors(found);
    if (found.email || found.password || found.captcha) {
      setRefusals((count) => count + 1);
      return;
    }
    await run(async () => {
      const address = email.trim();
      if ((await service.createAccount(address)) === "created") {
        onCreated(address);
        return null;
      }
      return UNAVAILABLE;
    });
  };

  return (
    <form ref={formRef} onSubmit={submit} className="stack" noValidate>
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
      <CaptchaPlaceholder
        checked={captcha}
        onChange={(checked) => {
          setCaptcha(checked);
          clear("captcha");
        }}
        error={errors.captcha}
      />
      <FormError message={failure?.message} />
      {/* aria-disabled, not disabled: a disabled button or field would drop the keyboard focus. */}
      <button type="submit" className="button primary wide" aria-disabled={pending || undefined}>
        {pending ? "Creating account…" : "Create account"}
      </button>
      <button type="button" className="link-button" onClick={onBackToSignIn} disabled={pending}>
        Back to sign in
      </button>
    </form>
  );
}
