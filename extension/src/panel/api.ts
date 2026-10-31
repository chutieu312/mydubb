// HTTP client for the MyDubb API, used by the side panel only. The bearer token comes from the
// caller and goes in the Authorization header; no cookie is ever sent (`credentials: "omit"`), so
// a MyDubb website session in this browser plays no part. The contracts are the website's:
// docs/API.md (jobs) and docs/EXTENSION_AUTH.md (token, session, logout).

import type { AppMeta, CreateJobInput, FieldError, Job, JobResult } from "../../../frontend/src/api/types";

export interface ExtensionUser {
  id: string;
  email: string;
  display_name: string | null;
}

export interface TokenGrant {
  access_token: string;
  token_type: "Bearer";
  expires_at: string;
  user: ExtensionUser;
}

export class MyDubbError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
    readonly jobErrorCode: string | null = null,
  ) {
    super(message);
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

/** The request never got an answer we can read: the server may or may not have acted on it. */
export const NO_ANSWER = new Set(["network_error", "timeout", "unreadable_response"]);

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiOptions {
  origin: string;
  fetch: Fetch;
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
  // Aborts the request after this long and reports `timeout`.
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isUser(value: unknown): value is ExtensionUser {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.email === "string" &&
    (value.display_name === null || typeof value.display_name === "string")
  );
}

export function isTokenGrant(value: unknown): value is TokenGrant {
  return (
    isRecord(value) &&
    typeof value.access_token === "string" &&
    value.access_token.length >= 20 &&
    value.access_token.length <= 100 &&
    value.token_type === "Bearer" &&
    typeof value.expires_at === "string" &&
    !Number.isNaN(Date.parse(value.expires_at)) &&
    isUser(value.user)
  );
}

export function isJob(value: unknown): value is Job {
  return isRecord(value) && typeof value.id === "string" && typeof value.status === "string";
}

function isResult(value: unknown): value is JobResult {
  return (
    isRecord(value) &&
    typeof value.job_id === "string" &&
    isRecord(value.translation) &&
    typeof value.translation.text === "string" &&
    isRecord(value.audio) &&
    typeof value.audio.url === "string"
  );
}

export const AUDIO_TIMEOUT_MS = 120_000;

/** Body read failed for a reason other than the deadline or the caller's cancellation. */
const UNREADABLE_BODY = Symbol("unreadable");

export function createApi({ origin, fetch }: ApiOptions) {
  /**
   * One request: the deadline and the caller's signal cover sending, the headers **and** reading
   * the body (`read`); cleanup happens only once the body has been read or abandoned. Failures are
   * told apart: `timeout` (our deadline), the caller's own AbortError (cancellation, rethrown as
   * is), `network_error` (no answer) and `unreadable_response` (an answer whose body could not be
   * read or understood).
   */
  async function exchange<T>(
    path: string,
    options: CallOptions,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, options.timeoutMs);
    const failure = (error: unknown, code: string, message: string, status = 0): unknown => {
      if (timedOut) return new MyDubbError(0, "timeout", "MyDubb did not answer in time.");
      if (options.signal?.aborted) return error;
      return new MyDubbError(status, code, message);
    };
    try {
      let response: Response;
      try {
        response = await fetch(`${origin}${path}`, {
          method: options.method ?? "GET",
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch (error) {
        throw failure(error, "network_error", "Cannot reach MyDubb. Check your connection.");
      }
      try {
        return await read(response, controller.signal);
      } catch (error) {
        if (error instanceof MyDubbError) throw error;
        throw failure(error, "unreadable_response", "The answer from MyDubb could not be read.", response.status);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /** The JSON body, or UNREADABLE_BODY when it is not JSON; an aborted read throws. */
  async function jsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      return UNREADABLE_BODY;
    }
  }

  async function call<T>(path: string, guard: (v: unknown) => v is T, options: CallOptions = {}): Promise<T> {
    return exchange(path, options, async (response, signal) => {
      const payload = await jsonBody(response, signal);
      if (!response.ok) throw errorOf(response, payload === UNREADABLE_BODY ? null : payload);
      if (payload === UNREADABLE_BODY || !guard(payload)) {
        throw new MyDubbError(response.status, "unreadable_response", "MyDubb sent an unexpected response.");
      }
      return payload;
    });
  }

  return {
    meta: () => call("/api/meta", (v): v is AppMeta => isRecord(v), { timeoutMs: 30_000 }),
    exchangeCode: (body: { client_id: string; redirect_uri: string; code: string; code_verifier: string }) =>
      call("/api/extension/token", isTokenGrant, {
        method: "POST",
        body: { grant_type: "authorization_code", ...body },
        timeoutMs: 30_000,
      }),
    session: (token: string, signal?: AbortSignal) =>
      call("/api/extension/session", (v): v is { user: ExtensionUser; expires_at: string } => isRecord(v) && isUser(v.user), {
        token,
        signal,
        timeoutMs: 30_000,
      }),
    logout: (token: string) =>
      exchange("/api/extension/logout", { method: "POST", token, timeoutMs: 10_000 }, async (response) => {
        if (!response.ok && response.status !== 401) throw errorOf(response, null);
      }),
    /** Sent once. A timeout or lost answer is reported, never retried: the job may exist. */
    createJob: (token: string, body: CreateJobInput, timeoutMs: number) =>
      call("/api/jobs", isJob, { method: "POST", token, body, timeoutMs }),
    getJob: (token: string, jobId: string, signal?: AbortSignal) =>
      call(`/api/jobs/${encodeURIComponent(jobId)}`, isJob, { token, signal, timeoutMs: 30_000 }),
    getResult: (token: string, jobId: string, signal?: AbortSignal) =>
      call(`/api/jobs/${encodeURIComponent(jobId)}/result`, isResult, { token, signal, timeoutMs: 30_000 }),
    /** The MP3 as a Blob: an <audio> element cannot send the Authorization header itself. */
    getAudio: async (token: string, path: string, signal?: AbortSignal): Promise<Blob> => {
      if (!path.startsWith("/api/jobs/")) {
        throw new MyDubbError(0, "unreadable_response", "MyDubb sent an unexpected audio address.");
      }
      return exchange(path, { token, signal, timeoutMs: AUDIO_TIMEOUT_MS }, async (response, readSignal) => {
        if (!response.ok) {
          const payload = await jsonBody(response, readSignal);
          throw errorOf(response, payload === UNREADABLE_BODY ? null : payload);
        }
        const blob = await response.blob();
        if (!blob.type.startsWith("audio/")) {
          throw new MyDubbError(response.status, "unreadable_response", "MyDubb sent something that is not audio.");
        }
        return blob;
      });
    },
  };
}

export type MyDubbApi = ReturnType<typeof createApi>;

function errorOf(response: Response, payload: unknown): MyDubbError {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  if (!error || typeof error.code !== "string") {
    // A proxy page or an empty body: the server's own answer is unknown.
    return new MyDubbError(response.status, "unreadable_response", `MyDubb answered with an error (${response.status}).`);
  }
  const fields = Array.isArray(error.fields)
    ? error.fields.filter(
        (f): f is FieldError => isRecord(f) && typeof f.field === "string" && typeof f.message === "string",
      )
    : [];
  return new MyDubbError(
    response.status,
    error.code,
    typeof error.message === "string" ? error.message : `Request failed (${response.status}).`,
    fields,
    typeof error.job_error_code === "string" ? error.job_error_code : null,
  );
}
