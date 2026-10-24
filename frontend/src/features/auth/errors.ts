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

// The UI never shows implementation details. Server messages are written for users, but one that
// names the identity service or token types is replaced rather than passed through.
const IMPLEMENTATION_DETAIL = /cognito|\baws\b|\bjwt\b|\btoken\b|\bboto/i;

export function retryText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.ceil(seconds))} seconds`;
  return `about ${Math.ceil(seconds / 60)} minutes`;
}

export function toFailure(err: unknown, fallback: string): Failure {
  if (!(err instanceof ApiError)) {
    return { message: fallback, keepInput: true, retryAfterSeconds: null };
  }
  if (err.status === 429 || err.code === "too_many_attempts") {
    const wait = err.retryAfterSeconds ? ` Try again in ${retryText(err.retryAfterSeconds)}.` : "";
    return {
      message: `Too many attempts.${wait}`,
      keepInput: true,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  // Network failure: the client's own message. Server error: generic. Rejected input (4xx): the
  // server's message, which says what to fix.
  if (err.status === 0) return { message: err.message, keepInput: true, retryAfterSeconds: null };
  if (err.status >= 500) return { message: fallback, keepInput: true, retryAfterSeconds: null };
  const message = IMPLEMENTATION_DETAIL.test(err.message) ? fallback : err.message;
  return { message, keepInput: false, retryAfterSeconds: null };
}

/** The sign-in attempt (challenge) is no longer valid on the server: start again. */
export function isChallengeGone(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || /challenge/i.test(err.code));
}
