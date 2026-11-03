import type { TargetLanguageOption } from "../api/types";

// Display only. The figures come from the server: nothing here adds, prices or estimates.

const MONEY_PLACES = 4;

export const languageName = (id: string, languages: TargetLanguageOption[]): string =>
  languages.find((language) => language.id === id)?.label ?? id;

/** An exact decimal string rounded half up for display, on the digits (no floating point), the
 * same way as the command-line report. The full value stays available to show on demand. */
export function formatMoney(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const kept = BigInt(whole + fraction.padEnd(MONEY_PLACES, "0").slice(0, MONEY_PLACES));
  const roundUp = (fraction[MONEY_PLACES] ?? "0") >= "5";
  const digits = (kept + (roundUp ? 1n : 0n)).toString().padStart(MONEY_PLACES + 1, "0");
  const integer = digits.slice(0, -MONEY_PLACES).replace(/\B(?=(\d{3})+$)/g, ",");
  return `${integer}.${digits.slice(-MONEY_PLACES)}`;
}

export const formatCount = (value: number): string => value.toLocaleString("en-US");

/** `2026-10-10T12:00:00.123456Z` as `2026-10-10 12:00:00 UTC`. */
export function formatUtc(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return `${time.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${formatCount(value)} bytes`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

const REASONS: Record<string, string> = {
  no_ending_recorded: "No ending recorded yet (still running, a crash or a restart)",
  attempts_missing: "Requests missing from the record",
  write_errors: "Usage could not all be written",
  usage_unknown: "Requests with unknown usage",
  no_translator_attempt: "No Translator request recorded",
  no_speech_attempt: "No Speech request recorded",
};
export const reasonLabel = (reason: string): string => REASONS[reason] ?? reason;

const PARTIAL_REASONS: Record<string, string> = {
  unknown_usage: "requests with unknown usage",
  unpriced_usage: "usage with no reference price for its date",
  incomplete_jobs: "incomplete jobs",
  jobs_without_usage: "jobs without a usage record",
};
export const partialReasonLabel = (reason: string): string => PARTIAL_REASONS[reason] ?? reason;

const NO_COST_REASONS: Record<string, string> = {
  mock: "Mock: not billed",
  none: "No usage: not sent",
  unknown_usage: "Unknown usage: not assumed free",
  no_reference_price: "No reference price for this date",
};
export const noCostLabel = (reason: string | null): string =>
  reason ? (NO_COST_REASONS[reason] ?? reason) : "Unknown";

const SERVICES: Record<string, string> = { translator: "Translator", speech: "Speech" };
export const serviceLabel = (service: string): string => SERVICES[service] ?? service;

const BASES: Record<string, string> = {
  actual: "Actual",
  estimated: "Estimated",
  unknown: "Unknown",
  none: "None",
};
export const basisLabel = (basis: string): string => BASES[basis] ?? basis;

/** Fixed labels from the server (`http_error`) as words (`http error`). */
export const plainLabel = (label: string): string => label.replaceAll("_", " ");
