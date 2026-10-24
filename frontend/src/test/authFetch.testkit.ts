// Test-only fake of the backend, used through a stubbed `fetch`. It is imported by tests and by
// nothing else: production code has no mock sign-in path (see authSafety.test.ts). It answers
// with the shapes of docs/AUTH_API.md; it does not prove the real backend does.
import { vi } from "vitest";

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
}

type Handler = (() => Response | Promise<Response>) & { sticky?: boolean };

/** A handler that answers every call instead of being used up by the first one. */
export const always = (handler: () => Response | Promise<Response>): Handler => {
  const sticky: Handler = handler;
  sticky.sticky = true;
  return sticky;
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
export const noContent = () => new Response(null, { status: 204 });
export const apiError = (status: number, code: string, message: string, headers = {}) =>
  json(status, { error: { code, message } }, headers);

const LATER = "2030-01-01T00:00:00Z";
export interface TestUser {
  id: string;
  email: string;
  display_name: string | null;
}
export const USER: TestUser = { id: "u-1", email: "ada@example.com", display_name: "Ada" };
export const OTHER_USER: TestUser = { id: "u-2", email: "bao@example.com", display_name: "Bao" };

export const session = (user = USER, csrf = "csrf-1") => ({
  user,
  csrf_token: csrf,
  expires_at: LATER,
});
export const authenticated = (user = USER, csrf = "csrf-1") => () =>
  json(200, { status: "authenticated", ...session(user, csrf) });
export const newPasswordRequired = () =>
  json(200, {
    status: "new_password_required",
    challenge_id: "chal-new",
    challenge_expires_at: LATER,
  });
export const verificationRequired = () =>
  json(200, {
    status: "email_verification_required",
    challenge_id: "chal-verify",
    challenge_expires_at: LATER,
  });
export const codeSent = () =>
  json(200, { status: "code_sent", destination: "a***@e***", challenge_expires_at: LATER });
export const accepted = () => json(202, { status: "accepted" });
export const passwordReset = () => json(200, { status: "password_reset" });
export const meResponse = (user = USER, csrf = "csrf-1") => () => json(200, session(user, csrf));
export const notAuthenticated = () => apiError(401, "not_authenticated", "Sign in.");

export const META = {
  provider_mode: "mock",
  mock_mode: true,
  providers: { translation: "mock", speech: "mock", audio: "mock" },
  voices: [
    {
      id: "AndrewMultilingual",
      label: "Andrew Multilingual",
      provider_voice: "en-US-AndrewMultilingualNeural",
      description: "Male",
    },
    {
      id: "EmmaMultilingual",
      label: "Emma Multilingual",
      provider_voice: "en-US-EmmaMultilingualNeural",
      description: "Female",
    },
  ],
  timestamp_format: "HH:MM:SS",
  result_ttl_seconds: 3600,
  auth: { mode: "cognito", self_registration: false, password_reset: true },
};
export const metaWith = (auth: unknown) => () => json(200, { ...META, auth });
export const meta = () => json(200, META);

/**
 * Stubs `fetch`. `routes` maps "METHOD /path" to a queue of responses, one consumed per call
 * (or one `always(...)` handler). A request nobody expected is recorded in `unexpected` so the
 * test can fail on it (the app itself would only see a network error).
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
      const queue = queues.get(`${method} ${path}`);
      const first = queue?.[0];
      const handler = first?.sticky ? first : queue?.shift();
      if (!handler) {
        unexpected.push(`${method} ${path}`);
        throw new Error(`Unexpected request: ${method} ${path}`);
      }
      requests.push({
        method,
        path,
        body:
          typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
        headers: (init.headers ?? {}) as Record<string, string>,
        credentials: init.credentials,
      });
      return handler();
    }),
  );
  return { requests, unexpected, to: (path: string) => requests.filter((r) => r.path === path) };
}
