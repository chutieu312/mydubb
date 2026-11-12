import type { GuestImportQuota, GuestQuota } from "../api/guestApi";
import { retryText } from "../features/auth/errors";

/**
 * Which limit stops this guest, in words; null while a job can still be started. `signup`: the
 * server offers Create account (GET /api/meta), so the guest is pointed there too, in the words of
 * the server's own 429 answer.
 */
export function guestLimitText(quota: GuestQuota, signup: boolean): string | null {
  const running = (count: number | null) =>
    count ? ` ${count} still processing; a job that fails gives its place back.` : "";
  const next = signup
    ? "Create a MyDubb account or sign in to continue."
    : "Sign in with an existing MyDubb account to continue.";
  if (quota.session_remaining === 0) {
    return `This guest session has used all ${quota.session_limit} of its jobs.${running(quota.session_in_progress)} ${next}`;
  }
  if (quota.ip_remaining === 0) {
    const hours = quota.ip_window_seconds / 3600;
    const when = quota.ip_retry_after_seconds
      ? ` One frees up in ${retryText(quota.ip_retry_after_seconds)}.`
      : "";
    return `Guests on your network have used all ${quota.ip_limit} guest jobs allowed in ${hours} hours; everyone on the same network shares this limit.${running(quota.ip_in_progress)}${when} ${next}`;
  }
  return null;
}

/** Which limit stops this guest's YouTube imports, in words; null while one can still be made. */
export function guestImportLimitText(imports: GuestImportQuota, windowSeconds: number): string | null {
  const running = (count: number | null) =>
    count ? ` ${count} still running; an import that fails gives its place back.` : "";
  if (imports.session_remaining === 0) {
    return `This guest session has used all ${imports.session_limit} of its YouTube imports.${running(imports.session_in_progress)} You can still paste a transcript, or sign in with your invitation.`;
  }
  if (imports.ip_remaining === 0) {
    const hours = windowSeconds / 3600;
    const when = imports.ip_retry_after_seconds
      ? ` One frees up in ${retryText(imports.ip_retry_after_seconds)}.`
      : "";
    return `Guests on your network have used all ${imports.ip_limit} YouTube imports allowed in ${hours} hours; everyone on the same network shares this limit.${running(imports.ip_in_progress)}${when} You can still paste a transcript, or sign in with your invitation.`;
  }
  return null;
}
