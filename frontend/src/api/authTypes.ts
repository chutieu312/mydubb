// PROVISIONAL types for the email + password sign-in API. The official contract is
// docs/AUTH_API.md (written with the backend change); until it is merged these types follow the
// temporary contract in docs/AUTH_UI.md and must be re-checked against it.

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
}

/** Result of login, new-password and email-verification confirm. */
export type AuthStep =
  | {
      status: "authenticated";
      user: AuthUser;
      // Present only if the backend keeps the CSRF convention of the Access Code session.
      csrf_token?: string;
    }
  // `challenge_id` is an opaque server identifier, never a credential. Keep it in memory only.
  | { status: "new_password_required"; challenge_id: string }
  | { status: "email_verification_required"; challenge_id: string };

export interface MeResponse {
  user: AuthUser;
  csrf_token?: string;
}

const STEP_STATUSES = ["authenticated", "new_password_required", "email_verification_required"];

function isUser(value: unknown): value is AuthUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "string" &&
    typeof user.email === "string" &&
    typeof user.display_name === "string"
  );
}

/** Runtime check so a contract mismatch fails loudly instead of rendering a half-signed-in UI. */
export function isAuthStep(value: unknown): value is AuthStep {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  if (typeof step.status !== "string" || !STEP_STATUSES.includes(step.status)) return false;
  if (step.status === "authenticated") return isUser(step.user);
  return typeof step.challenge_id === "string" && step.challenge_id.length > 0;
}

export function isMeResponse(value: unknown): value is MeResponse {
  return typeof value === "object" && value !== null && isUser((value as MeResponse).user);
}
