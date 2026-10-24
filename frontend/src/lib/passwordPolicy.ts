// Early feedback only: the backend decides whether a password is accepted and its message is
// shown if it disagrees. The numbers are PROVISIONAL until docs/AUTH_API.md fixes the policy;
// the flow takes the policy as a prop so it can come from the backend later.

export interface PasswordPolicy {
  minLength: number;
  requireLower: boolean;
  requireUpper: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireLower: true,
  requireUpper: true,
  requireNumber: true,
  requireSymbol: false,
};

/** Human-readable requirements, in display order. */
export function describePolicy(policy: PasswordPolicy): string[] {
  const rules = [`At least ${policy.minLength} characters`];
  if (policy.requireLower) rules.push("A lowercase letter");
  if (policy.requireUpper) rules.push("An uppercase letter");
  if (policy.requireNumber) rules.push("A number");
  if (policy.requireSymbol) rules.push("A symbol");
  return rules;
}

/** The requirements `password` does not meet yet (empty when it meets all of them). */
export function unmetRules(policy: PasswordPolicy, password: string): string[] {
  const rules = describePolicy(policy);
  const met = [
    [...password].length >= policy.minLength,
    ...(policy.requireLower ? [/\p{Ll}/u.test(password)] : []),
    ...(policy.requireUpper ? [/\p{Lu}/u.test(password)] : []),
    ...(policy.requireNumber ? [/\p{N}/u.test(password)] : []),
    ...(policy.requireSymbol ? [/[^\p{L}\p{N}\s]/u.test(password)] : []),
  ];
  return rules.filter((_, index) => !met[index]);
}
