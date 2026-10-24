import { PasswordField } from "./fields";
import type { NewPasswordErrors } from "./newPasswordValidation";

interface Props {
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  errors: NewPasswordErrors;
  disabled: boolean;
}

export function NewPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  errors,
  disabled,
}: Props) {
  return (
    <>
      <PasswordField
        label="New password"
        value={password}
        onChange={onPassword}
        autoComplete="new-password"
        error={errors.password}
        disabled={disabled}
      />
      <PasswordField
        label="Confirm password"
        value={confirm}
        onChange={onConfirm}
        autoComplete="new-password"
        error={errors.confirm}
        disabled={disabled}
      />
    </>
  );
}
