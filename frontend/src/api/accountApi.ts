import { ApiError, request } from "./client";

// The signed-in account's usage limits for today (docs/API.md, "Usage limits"). A preview only:
// the server decides every Generate and import. Nothing here is stored.

export interface KindUsage {
  // Accepted today (UTC); a failed job or import still counts.
  used: number;
  // Null when the account is not limited (an administrator).
  limit: number | null;
  remaining: number | null;
}

export interface AccountUsage {
  plan: string;
  exempt: boolean;
  day: string;
  // 00:00 UTC of the next day.
  resets_at: string;
  generate: KindUsage;
  youtube_import: KindUsage;
  // Per job; null when the account is exempt.
  max_words: number | null;
  max_output_seconds: number | null;
}

// An account's daily quota refused the request (429): the numbers on screen are out of date.
export const ACCOUNT_QUOTA_CODES = new Set([
  "daily_generate_quota_exhausted",
  "daily_import_quota_exhausted",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isCountOrNull = (value: unknown) => value === null || isCount(value);

const isKindUsage = (value: unknown): value is KindUsage =>
  isRecord(value) && isCount(value.used) && isCountOrNull(value.limit) && isCountOrNull(value.remaining);

export function isAccountUsage(value: unknown): value is AccountUsage {
  return (
    isRecord(value) &&
    typeof value.plan === "string" &&
    typeof value.exempt === "boolean" &&
    typeof value.day === "string" &&
    typeof value.resets_at === "string" &&
    !Number.isNaN(Date.parse(value.resets_at)) &&
    isKindUsage(value.generate) &&
    isKindUsage(value.youtube_import) &&
    isCountOrNull(value.max_words) &&
    isCountOrNull(value.max_output_seconds)
  );
}

/** "free" -> "Free". */
export const planName = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

export const accountApi = {
  usage: async (): Promise<AccountUsage> => {
    const payload = await request<unknown>("GET", "/api/account/usage", { accept: [200] });
    if (!isAccountUsage(payload)) {
      throw new ApiError(502, "unexpected_response", "The server sent an unexpected response.");
    }
    return payload;
  },
};
