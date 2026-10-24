// Test-only fake of the sign-in API, used through a stubbed `fetch`. It is imported by tests and
// by nothing else: production code has no mock sign-in path (see authSafety.test.ts).
import { vi } from "vitest";

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
}

type Handler = () => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
export const noContent = () => new Response(null, { status: 204 });
export const apiError = (status: number, code: string, message: string, headers = {}) =>
  json(status, { error: { code, message } }, headers);

export const USER = { id: "u-1", email: "ada@example.com", display_name: "Ada" };
export const authenticated = (extra: Record<string, unknown> = {}) =>
  json(200, { status: "authenticated", user: USER, ...extra });
export const newPasswordRequired = () =>
  json(200, { status: "new_password_required", challenge_id: "chal-new" });
export const verificationRequired = () =>
  json(200, { status: "email_verification_required", challenge_id: "chal-verify" });

/**
 * Stubs `fetch`. `routes` maps "METHOD /path" to a queue of responses, one consumed per call.
 * A request nobody expected is recorded in `unexpected` so the test can fail on it (the app
 * itself would only see a network error).
 */
export function installAuthFetch(routes: Record<string, Handler[]>) {
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  const queues = new Map(Object.entries(routes).map(([key, list]) => [key, [...list]]));

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = String(input);
      const handler = queues.get(`${method} ${path}`)?.shift();
      if (!handler) {
        unexpected.push(`${method} ${path}`);
        throw new Error(`Unexpected request: ${method} ${path}`);
      }
      requests.push({
        method,
        path,
        body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        headers: (init.headers ?? {}) as Record<string, string>,
        credentials: init.credentials,
      });
      return handler();
    }),
  );
  return { requests, unexpected, to: (path: string) => requests.filter((r) => r.path === path) };
}
