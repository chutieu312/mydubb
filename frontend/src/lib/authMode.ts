import type { AppMeta } from "../api/types";

export type AuthMode = "access_code" | "cognito";

/**
 * The sign-in mode the backend reports in GET /api/meta, or null when it is missing or not one
 * the UI knows. Null must never be turned into a guess: the caller shows no sign-in at all.
 */
export function authModeOf(meta: AppMeta | null): AuthMode | null {
  const mode = meta?.auth?.mode;
  return mode === "access_code" || mode === "cognito" ? mode : null;
}

/** Forgot/reset password is offered only when the backend says it exists. */
export function passwordResetOf(meta: AppMeta | null): boolean {
  return meta?.auth?.password_reset === true;
}
