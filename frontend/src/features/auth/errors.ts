import { UNEXPECTED_RESPONSE } from "../../api/authApi";
import { ApiError } from "../../api/client";

/** What a form shows after a failed request, and whether to keep what the user typed. */
export interface Failure {
  message: string;
  // True for failures that say nothing about the input (network, server error, rate limit), so
  // the user can retry without retyping. False for rejected input: secrets are cleared.
  keepInput: boolean;
  retryAfterSeconds: number | null;
}

/** A form handler returns null on success, or the failure to show. */
export type Outcome = Failure | null;

// Logic below depends on HTTP status and error `code` only, never on the wording of a message.
// Messages are shown as plain text; one that names the identity service or token types is
// replaced by a generic one rather than passed through.
const IMPLEMENTATION_DETAIL = /cognito|\baws\b|\bjwt\b|\btoken\b|\bboto/i;

export const PASSWORD_CHANGED_TEXT =
  "Your password or account access changed while you were signing in. Please sign in again.";

export function retryText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} seconds`;
  return `about ${Math.ceil(seconds / 60)} minutes`;
}

const safeMessage = (err: ApiError, fallback: string) =>
  err.message === "" || IMPLEMENTATION_DETAIL.test(err.message) ? fallback : err.message;

export function toFailure(err: unknown, fallback: string): Failure {
  const keep = (message: string): Failure => ({ message, keepInput: true, retryAfterSeconds: null });
  const reject = (message: string): Failure => ({
    message,
    keepInput: false,
    retryAfterSeconds: null,
  });

  if (!(err instanceof ApiError)) return keep(fallback);
  if (err.status === 0) return keep(err.message); // the client's own "cannot reach the server"
  if (err.code === UNEXPECTED_RESPONSE) return keep(fallback);

  if (err.status === 429) {
    if (err.retryAfterSeconds) {
      return {
        message: `Too many attempts. Try again in ${retryText(err.retryAfterSeconds)}.`,
        keepInput: true,
        retryAfterSeconds: err.retryAfterSeconds,
      };
    }
    return keep(safeMessage(err, "Too many attempts. Please try again later."));
  }
  if (err.code === "password_changed") return reject(PASSWORD_CHANGED_TEXT);
  if (err.code === "validation_error") {
    return keep(err.fields[0]?.message || safeMessage(err, fallback));
  }
  // The sign-in service is down or timed out: nothing was accepted from the user's point of view.
  if (err.code === "auth_unavailable") return keep(safeMessage(err, fallback));
  if (err.status >= 500) return keep(fallback);
  return reject(safeMessage(err, fallback));
}

/**
 * reset-password: the password may have changed even though the answer was not a clear success
 * or refusal, so the UI must not say it did not. Documented refusals keep their normal message;
 * a 503 `auth_unavailable` shows the server's own text (it says which case applies); anything
 * else (network, other 5xx, an answer that does not match the contract) is "unknown".
 */
export const RESET_UNKNOWN_TEXT =
  "We could not confirm whether your password was changed. Wait a minute, then try signing in with your new password. If that does not work, request a new code.";

const RESET_DEFINITE = new Set([
  "code_invalid",
  "password_rejected",
  "too_many_attempts",
  "auth_rate_limited",
  "validation_error",
  "password_changed",
]);

export function toResetFailure(err: unknown): Failure {
  const unknown: Failure = { message: RESET_UNKNOWN_TEXT, keepInput: false, retryAfterSeconds: null };
  if (!(err instanceof ApiError)) return unknown;
  if (err.code === "auth_unavailable") {
    return { ...unknown, message: safeMessage(err, RESET_UNKNOWN_TEXT) };
  }
  if (RESET_DEFINITE.has(err.code)) return toFailure(err, RESET_UNKNOWN_TEXT);
  return unknown;
}

/**
 * A pending sign-in step (new password, email verification) that cannot continue. Returns the
 * sentence for the sign-in screen, or null if the error is an ordinary failure of the step
 * (wrong code, rejected password, network) that the form should show itself.
 */
export function endedStepNotice(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case "challenge_invalid":
      return "This step expired or was already completed. Please sign in again. If you just chose a new password or verified your email, that change may already be saved.";
    case "challenge_busy":
      return "This step is already being processed by another request. Please sign in again; if you just chose a new password, use it.";
    case "password_changed":
      return PASSWORD_CHANGED_TEXT;
    case "account_disabled":
      return "This account is disabled. Please contact the person who invited you.";
    case "account_setup_incomplete":
      return "Your account is not ready yet. Please contact the person who invited you.";
    default:
      return null;
  }
}
