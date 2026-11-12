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

export interface SignupOffer {
  recaptchaSiteKey: string;
  // One sentence about the Free plan, from the numbers the backend reports.
  freePlan: string;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Create account is offered only with email + password sign-in, when the backend says sign-up is
 * on and gives everything the screen needs. Anything missing means no Create account at all.
 */
export function signupOf(meta: AppMeta | null): SignupOffer | null {
  const signup = meta?.signup;
  const plan = signup?.free_plan;
  const siteKey = signup?.recaptcha_site_key;
  if (
    authModeOf(meta) !== "cognito" ||
    meta?.auth?.self_registration !== true ||
    signup?.enabled !== true ||
    typeof siteKey !== "string" ||
    siteKey === "" ||
    !isCount(plan?.generates_per_day) ||
    !isCount(plan?.youtube_imports_per_day) ||
    !isCount(plan?.max_words) ||
    !isCount(plan?.max_output_seconds)
  ) {
    return null;
  }
  const minutes = Math.round(plan.max_output_seconds / 60);
  return {
    recaptchaSiteKey: siteKey,
    freePlan:
      `New accounts get the Free plan: ${plan.generates_per_day} Generates and ` +
      `${plan.youtube_imports_per_day} YouTube imports a day (counts start again at 00:00 UTC), ` +
      `up to ${plan.max_words.toLocaleString("en-US")} words and ${minutes} minutes of audio per job.`,
  };
}

/** "Try as guest" is offered only with email + password sign-in and when the backend says so. */
export function guestAccessOf(meta: AppMeta | null): boolean {
  return authModeOf(meta) === "cognito" && meta?.guest_access?.enabled === true;
}

/** "Try as guest" in the Chrome extension: guest access on and the backend offering it there. */
export function extensionGuestOf(meta: AppMeta | null): boolean {
  return guestAccessOf(meta) && meta?.guest_access?.extension === true;
}
