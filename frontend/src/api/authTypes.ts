// Types and response guards for the email + password sign-in API. The contract is
// docs/AUTH_API.md; every guard below mirrors the response models in backend/app/auth/router.py.

export interface AuthUser {
  id: string;
  email: string;
  // Null when the account has no name: show the email then.
  display_name: string | null;
}

export interface Session {
  user: AuthUser;
  // Required by the contract for POST /api/jobs and POST /api/auth/logout; kept in memory only.
  csrf_token: string;
  expires_at: string;
}

/** Answer of login, new-password and email-verification/confirm. */
export type AuthStep =
  | ({ status: "authenticated" } & Session)
  // `challenge_id` is an opaque MyDubb identifier, valid only with the browser's challenge cookie.
  | { status: "new_password_required"; challenge_id: string; challenge_expires_at: string }
  | { status: "email_verification_required"; challenge_id: string; challenge_expires_at: string };

export interface CodeSent {
  status: "code_sent";
  // The masked address the code went to; null when unknown.
  destination: string | null;
  challenge_expires_at: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));

const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

function isUser(value: unknown): value is AuthUser {
  return (
    isRecord(value) &&
    isNonEmpty(value.id) &&
    isNonEmpty(value.email) &&
    (value.display_name === null || typeof value.display_name === "string")
  );
}

export function isSession(value: unknown): value is Session {
  return (
    isRecord(value) &&
    isUser(value.user) &&
    isNonEmpty(value.csrf_token) &&
    isTimestamp(value.expires_at)
  );
}

/** A mismatch fails loudly instead of rendering a half signed-in UI. */
export function isAuthStep(value: unknown): value is AuthStep {
  if (!isRecord(value)) return false;
  if (value.status === "authenticated") return isSession(value);
  if (value.status === "new_password_required" || value.status === "email_verification_required") {
    return isNonEmpty(value.challenge_id) && isTimestamp(value.challenge_expires_at);
  }
  return false;
}

export function isCodeSent(value: unknown): value is CodeSent {
  return (
    isRecord(value) &&
    value.status === "code_sent" &&
    (value.destination === null || typeof value.destination === "string") &&
    isTimestamp(value.challenge_expires_at)
  );
}

export const hasStatus = (expected: string) => (value: unknown) =>
  isRecord(value) && value.status === expected;
