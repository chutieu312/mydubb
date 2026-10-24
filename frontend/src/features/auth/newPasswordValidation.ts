import { unmetRules, type PasswordPolicy } from "../../lib/passwordPolicy";

export interface NewPasswordErrors {
  password?: string;
  confirm?: string;
}

/** Early feedback before sending; the backend still decides and its message wins. */
export function validateNewPassword(
  policy: PasswordPolicy,
  password: string,
  confirm: string,
): NewPasswordErrors {
  const errors: NewPasswordErrors = {};
  if (unmetRules(policy, password).length > 0) {
    errors.password = "This password does not meet the requirements listed below.";
  }
  if (confirm !== password) errors.confirm = "The two passwords do not match.";
  return errors;
}
