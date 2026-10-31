// The job a tab's panel follows, and how it is watched. Kept free of DOM and Chrome APIs so the
// rules can be tested: one record per tab in chrome.storage.session, tied to the account, the
// lecture and the operation that created it; polling with backoff and a time limit.

import type { Job } from "../../../frontend/src/api/types";
import { isSyncSource, type SyncSource } from "../shared/sync";
import { MyDubbError, NO_ANSWER } from "./api";

/** What the user chose for this job, as shown with its result (not re-read from the form). */
export interface JobChoices {
  languageLabel: string;
  voiceLabel: string;
  speed: number;
  timed: boolean;
  firstStart: string;
  lastStart: string;
  /** The source span for Sync with video, fixed at the click (absent in older records: no Sync). */
  sync?: SyncSource;
}

export interface JobRecord {
  // One Generate click.
  operationId: string;
  // The account and connection that sent it: another one never sees or follows it.
  userId: string;
  connectionId: string;
  // The lecture the transcript was taken from.
  lessonKey: string | null;
  // "sending": the request left and no answer was read (yet). "created": the server answered.
  state: "sending" | "created";
  jobId: string | null;
  sentAt: number;
  choices: JobChoices;
}

const isString = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;

export function isJobRecord(value: unknown): value is JobRecord {
  const v = value as Partial<JobRecord> | null;
  const c = v?.choices as Partial<JobChoices> | undefined;
  return (
    typeof v === "object" &&
    v !== null &&
    isString(v.operationId, 100) &&
    isString(v.userId, 100) &&
    isString(v.connectionId, 100) &&
    (v.lessonKey === null || isString(v.lessonKey, 250)) &&
    (v.state === "sending" || v.state === "created") &&
    (v.jobId === null || isString(v.jobId, 100)) &&
    (v.state === "sending" || typeof v.jobId === "string") &&
    typeof v.sentAt === "number" &&
    typeof c === "object" &&
    c !== null &&
    isString(c.languageLabel) &&
    isString(c.voiceLabel) &&
    typeof c.speed === "number" &&
    typeof c.timed === "boolean" &&
    isString(c.firstStart, 50) &&
    isString(c.lastStart, 50) &&
    (c.sync === undefined || isSyncSource(c.sync))
  );
}

/** Whether a stored record may be shown in this panel for this account and lecture. */
export function recordBelongs(
  record: JobRecord,
  account: { userId: string; connectionId: string } | null,
  lessonKey: string | null | undefined,
): boolean {
  if (!account || record.userId !== account.userId || record.connectionId !== account.connectionId) {
    return false;
  }
  // Unknown lecture (no page state yet): decided again when the state arrives.
  return lessonKey === undefined || record.lessonKey === null || record.lessonKey === lessonKey;
}

export const STATUS_TEXT: Record<string, string> = {
  queued: "Queued…",
  translating: "Translating…",
  synthesizing: "Generating speech…",
  processing: "Processing audio…",
  completed: "Completed.",
  failed: "Failed.",
};

export const SEND_TIMEOUT_MS = 60_000;
export const UNKNOWN_OUTCOME =
  "MyDubb did not answer, so it is not known whether the job was created. It may still be " +
  "processing on MyDubb, and this panel cannot find it. Generate again only if a second job is acceptable.";

/** The user-facing text for an error of a job request. */
export function jobErrorMessage(error: unknown): string {
  if (!(error instanceof MyDubbError)) return "Something went wrong. Please try again.";
  switch (error.code) {
    case "not_authenticated":
      return "Your MyDubb connection ended. Connect again to continue.";
    case "server_at_capacity":
      return "MyDubb is busy with the maximum number of jobs it can run. Try again in a minute.";
    case "result_expired":
    case "job_failed":
    case "timing_mode_unavailable":
    case "validation_error":
      return error.message;
    case "timeout":
    case "network_error":
      return error.message;
    default:
      return error.status >= 400 && error.status < 500 && !NO_ANSWER.has(error.code)
        ? error.message
        : `MyDubb could not complete the request (${error.status || "no answer"}). Please try again.`;
  }
}

/** Text of a failed job: the server's message, which names provider quota, capacity, etc. */
export function failedJobMessage(job: Job): string {
  const message = job.error?.message;
  return message ? `The job failed: ${message}` : "The job failed.";
}

export interface PollOptions {
  getJob(signal: AbortSignal): Promise<Job>;
  onUpdate(job: Job): void;
  signal: AbortSignal;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  firstDelayMs?: number;
  maxDelayMs?: number;
  maxDurationMs?: number;
  maxConsecutiveErrors?: number;
}

export type PollOutcome =
  | { kind: "terminal"; job: Job }
  | { kind: "aborted" }
  | { kind: "unauthenticated" }
  | { kind: "gone"; error: MyDubbError }
  | { kind: "gave-up"; reason: "time" | "errors"; error?: unknown };

/**
 * Polls until the job is completed or failed, the signal aborts (panel closed, account or lecture
 * changed), the token is refused, the job is not found, too many requests in a row fail, or the
 * time limit passes. Delays grow by 1.5x from `firstDelayMs` to `maxDelayMs`.
 */
export async function pollJob(options: PollOptions): Promise<PollOutcome> {
  const first = options.firstDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 10_000;
  const deadline = options.now() + (options.maxDurationMs ?? 30 * 60_000);
  const maxErrors = options.maxConsecutiveErrors ?? 5;
  let delay = first;
  let errors = 0;
  for (;;) {
    if (options.signal.aborted) return { kind: "aborted" };
    try {
      const job = await options.getJob(options.signal);
      if (options.signal.aborted) return { kind: "aborted" };
      errors = 0;
      options.onUpdate(job);
      if (job.status === "completed" || job.status === "failed") return { kind: "terminal", job };
    } catch (error) {
      if (options.signal.aborted) return { kind: "aborted" };
      if (error instanceof MyDubbError && error.isUnauthenticated) return { kind: "unauthenticated" };
      if (error instanceof MyDubbError && error.status === 404) return { kind: "gone", error };
      errors += 1;
      if (errors >= maxErrors) return { kind: "gave-up", reason: "errors", error };
    }
    if (options.now() + delay > deadline) return { kind: "gave-up", reason: "time" };
    try {
      await options.sleep(delay, options.signal);
    } catch {
      return { kind: "aborted" };
    }
    delay = Math.min(max, Math.round(delay * 1.5));
  }
}

/** setTimeout-based sleep that rejects when the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
