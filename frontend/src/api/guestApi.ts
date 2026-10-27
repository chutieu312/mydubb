import { ApiError, request } from "./client";

// Adapter for the guest session API (docs/API.md, "Guest access"). The guest session itself is an
// HttpOnly cookie; the CSRF token is kept in memory by the caller. Nothing here is stored.

export interface GuestQuota {
  // Completed jobs over the guest session's lifetime; jobs still processing hold a place.
  session_limit: number;
  session_used: number;
  session_in_progress: number;
  session_remaining: number;
  // Shared by every guest on the same network in a sliding window; null when the server cannot
  // tell the network of this request.
  ip_limit: number;
  ip_used: number | null;
  ip_in_progress: number | null;
  ip_remaining: number | null;
  ip_window_seconds: number;
  ip_retry_after_seconds: number | null;
  max_words: number;
}

export interface GuestSession {
  status: "guest";
  guest: { id: string };
  csrf_token: string;
  expires_at: string;
  quota: GuestQuota;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isCountOrNull = (value: unknown) => value === null || isCount(value);

function isQuota(value: unknown): value is GuestQuota {
  return (
    isRecord(value) &&
    ["session_limit", "session_used", "session_in_progress", "session_remaining"].every((key) =>
      isCount(value[key]),
    ) &&
    isCount(value.ip_limit) &&
    ["ip_used", "ip_in_progress", "ip_remaining", "ip_retry_after_seconds"].every((key) =>
      isCountOrNull(value[key]),
    ) &&
    isCount(value.ip_window_seconds) &&
    isCount(value.max_words)
  );
}

export function isGuestSession(value: unknown): value is GuestSession {
  return (
    isRecord(value) &&
    value.status === "guest" &&
    isRecord(value.guest) &&
    typeof value.guest.id === "string" &&
    value.guest.id !== "" &&
    typeof value.csrf_token === "string" &&
    value.csrf_token !== "" &&
    typeof value.expires_at === "string" &&
    !Number.isNaN(Date.parse(value.expires_at)) &&
    isQuota(value.quota)
  );
}

function checked(payload: unknown): GuestSession {
  if (!isGuestSession(payload)) {
    throw new ApiError(502, "unexpected_response", "The server sent an unexpected response.");
  }
  return payload;
}

/** Jobs this guest can still start: the smaller of the session's and the network's. */
export function guestJobsLeft(quota: GuestQuota): number {
  return quota.ip_remaining === null
    ? quota.session_remaining
    : Math.min(quota.session_remaining, quota.ip_remaining);
}

export const GUEST_QUOTA_CODES = new Set(["guest_session_quota_exhausted", "guest_ip_quota_exhausted"]);

export const guestApi = {
  // 201 for a new guest session; 200 returns the browser's current one, unchanged.
  start: async (): Promise<GuestSession> =>
    checked(await request<unknown>("POST", "/api/guest/session", { accept: [200, 201] })),
  get: async (): Promise<GuestSession> =>
    checked(await request<unknown>("GET", "/api/guest/session", { accept: [200] })),
  end: () => request<void>("DELETE", "/api/guest/session", { accept: [204] }),
};
