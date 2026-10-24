import { useId } from "react";

import { describePolicy, unmetRules, type PasswordPolicy } from "../../lib/passwordPolicy";
import { PasswordField } from "./fields";
import type { NewPasswordErrors } from "./newPasswordValidation";

interface Props {
  policy: PasswordPolicy;
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  errors: NewPasswordErrors;
  disabled: boolean;
}

export function NewPasswordFields({
  policy,
  password,
  confirm,
  onPassword,
  onConfirm,
  errors,
  disabled,
}: Props) {
  const rulesId = useId();
  const unmet = new Set(unmetRules(policy, password));
  return (
    <>
      <PasswordField
        label="New password"
        value={password}
        onChange={onPassword}
        autoComplete="new-password"
        error={errors.password}
        disabled={disabled}
        describedBy={rulesId}
      />
      <ul id={rulesId} className="rules" aria-label="Password requirements">
        {describePolicy(policy).map((rule) => (
          <li key={rule} className={unmet.has(rule) ? "rule" : "rule met"}>
            <span aria-hidden="true">{unmet.has(rule) ? "○" : "✓"}</span> {rule}
            <span className="sr-only">{unmet.has(rule) ? " (not met)" : " (met)"}</span>
          </li>
        ))}
      </ul>
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
