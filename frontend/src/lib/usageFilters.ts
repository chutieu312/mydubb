import type { UsageFilters } from "../api/usageApi";

// The filters of the Usage & Costs page live in the address, so a direct link, a reload and
// Back/Forward all mean the same thing. Times are UTC; the server does the real validation.

export const MAX_PERIOD_DAYS = 31;
const DEFAULT_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// No zone: UTC, as for the server. A date alone is midnight.
const NAIVE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

export interface UsageAddress {
  since?: string;
  until?: string;
  language?: string;
  jobId?: string;
  // The job whose usage is open.
  detail?: string;
}

export function parseAddress(search: string): UsageAddress {
  const params = new URLSearchParams(search);
  const value = (name: string) => params.get(name) ?? undefined;
  return {
    since: value("since"),
    until: value("until"),
    language: value("language"),
    jobId: value("job_id"),
    detail: value("job"),
  };
}

export function buildAddress(address: UsageAddress): string {
  const params = new URLSearchParams();
  if (address.since) params.set("since", address.since);
  if (address.until) params.set("until", address.until);
  if (address.language) params.set("language", address.language);
  if (address.jobId) params.set("job_id", address.jobId);
  if (address.detail) params.set("job", address.detail);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

function toMs(value: string): number {
  return Date.parse(NAIVE.test(value) ? `${value.length === 10 ? `${value}T00:00` : value}Z` : value);
}

/** The period of a request: what the address says, the last seven days for what it does not. */
export function resolveFilters(address: UsageAddress, now: number): UsageFilters {
  // Rounded up to the minute, so a job started this minute is inside and the value reads well.
  const endOfMinute = Math.ceil(now / 60_000) * 60_000;
  const until = address.until ?? iso(endOfMinute);
  const since =
    address.since ??
    (Number.isNaN(toMs(until)) ? iso(endOfMinute - DEFAULT_PERIOD_DAYS * DAY_MS) : iso(toMs(until) - DEFAULT_PERIOD_DAYS * DAY_MS));
  return { since, until, language: address.language, jobId: address.jobId };
}

/** The value of a `datetime-local` field holding this time in UTC ("" if it is not a time). */
export function toFieldValue(value: string): string {
  const ms = toMs(value);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString().slice(0, 19);
}

/** What a `datetime-local` field holds, as a UTC time. */
export function fromFieldValue(value: string): string {
  return value ? `${value.length === 16 ? `${value}:00` : value}Z` : "";
}

export interface FilterDraft {
  since: string;
  until: string;
  language: string;
  jobId: string;
}

export type FilterErrors = Partial<Record<keyof FilterDraft, string>>;

/** Mistakes the page can name before asking the server. */
export function validateDraft(draft: FilterDraft): FilterErrors {
  const errors: FilterErrors = {};
  if (!draft.since) errors.since = "Enter a start time.";
  if (!draft.until) errors.until = "Enter an end time.";
  if (draft.since && draft.until) {
    const span = toMs(fromFieldValue(draft.until)) - toMs(fromFieldValue(draft.since));
    if (Number.isNaN(span)) errors.until = "Enter valid times.";
    else if (span <= 0) errors.since = "The start must be earlier than the end.";
    else if (span > MAX_PERIOD_DAYS * DAY_MS)
      errors.until = `The period can be at most ${MAX_PERIOD_DAYS} days.`;
  }
  const job = draft.jobId.trim();
  if (job && !UUID.test(job)) errors.jobId = "Enter a full job ID.";
  return errors;
}
