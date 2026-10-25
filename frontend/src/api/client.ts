import type {
  AppMeta,
  CreateJobInput,
  FieldError,
  Job,
  JobResult,
  SessionInfo,
  YouTubeImport,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[];
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    fields: FieldError[] = [],
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

// The CSRF token lives in memory only. The session itself is an HttpOnly cookie that
// JavaScript cannot read; nothing sensitive is written to localStorage.
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function request<T>(
  method: string,
  path: string,
  options: {
    body?: unknown;
    signal?: AbortSignal;
    // Success statuses the contract allows. Any other 2xx is treated as an unexpected answer
    // instead of being trusted (used by the sign-in API, where a wrong guess matters).
    accept?: readonly number[];
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE_METHODS.has(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection.");
  }

  if (response.ok && options.accept && !options.accept.includes(response.status)) {
    throw new ApiError(502, "unexpected_response", "The server sent an unexpected response.");
  }
  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page); handled below.
  }

  if (!response.ok) {
    const error = (payload as { error?: Record<string, unknown> } | null)?.error;
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApiError(
      response.status,
      typeof error?.code === "string" ? error.code : "http_error",
      typeof error?.message === "string" ? error.message : `Request failed (${response.status}).`,
      Array.isArray(error?.fields) ? (error.fields as FieldError[]) : [],
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  return payload as T;
}

export const api = {
  meta: () => request<AppMeta>("GET", "/api/meta"),
  getSession: () => request<SessionInfo>("GET", "/api/session"),
  login: (accessCode: string) =>
    request<SessionInfo>("POST", "/api/session", { body: { access_code: accessCode } }),
  logout: () => request<void>("DELETE", "/api/session"),
  createJob: (input: CreateJobInput) => request<Job>("POST", "/api/jobs", { body: input }),
  getJob: (id: string, signal?: AbortSignal) =>
    request<Job>("GET", `/api/jobs/${encodeURIComponent(id)}`, { signal }),
  getResult: (id: string, signal?: AbortSignal) =>
    request<JobResult>("GET", `/api/jobs/${encodeURIComponent(id)}/result`, { signal }),
  importYouTube: (url: string, signal?: AbortSignal) =>
    request<YouTubeImport>("POST", "/api/transcripts/youtube", { body: { url }, signal }),
};
