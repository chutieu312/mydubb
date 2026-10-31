import { describe, expect, it, vi } from "vitest";

import { AUDIO_TIMEOUT_MS, MyDubbError, NO_ANSWER, createApi } from "./api";

const ORIGIN = "https://mydubb.test";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const JOB = { id: "j1", status: "queued" };
const BODY = { transcript: "x", first_sentence_start: "00:00:01", last_sentence_start: "00:00:09", voice: "v", speed: 1 };

describe("MyDubb API client", () => {
  it("sends the bearer token and never cookies", async () => {
    const fetch = vi.fn(async () => json(202, JOB));
    const api = createApi({ origin: ORIGIN, fetch });
    await api.createJob("tok", BODY, 1000);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/jobs`);
    expect(init.credentials).toBe("omit");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual(BODY);
    expect(init.referrerPolicy).toBe("no-referrer");
  });

  it("reports a timed-out job request once and never sends it again", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      const api = createApi({ origin: ORIGIN, fetch });
      const caught = api.createJob("tok", BODY, 5000).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5000);
      const error = (await caught) as MyDubbError;
      expect(error.code).toBe("timeout");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns server errors into codes and field errors", async () => {
    const api = createApi({
      origin: ORIGIN,
      fetch: async () =>
        json(422, { error: { code: "validation_error", message: "Bad.", fields: [{ field: "voice", message: "No." }] } }),
    });
    await expect(api.createJob("tok", BODY, 1000)).rejects.toMatchObject({
      status: 422,
      code: "validation_error",
      fields: [{ field: "voice", message: "No." }],
    });
  });

  it("treats a lost or unreadable answer as unknown, not as a refusal", async () => {
    const offline = createApi({ origin: ORIGIN, fetch: async () => Promise.reject(new TypeError("Failed to fetch")) });
    await expect(offline.createJob("tok", BODY, 1000)).rejects.toMatchObject({ code: "network_error" });
    const proxy = createApi({
      origin: ORIGIN,
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    await expect(proxy.createJob("tok", BODY, 1000)).rejects.toMatchObject({ code: "unreadable_response", status: 502 });
  });

  it("fetches the audio as a Blob with the token, from the API only", async () => {
    const fetch = vi.fn(async () => new Response("mp3", { status: 200, headers: { "Content-Type": "audio/mpeg" } }));
    const api = createApi({ origin: ORIGIN, fetch });
    const blob = await api.getAudio("tok", "/api/jobs/j1/result/audio");
    expect(blob.type).toBe("audio/mpeg");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/jobs/j1/result/audio`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    await expect(api.getAudio("tok", "https://evil.example/a.mp3")).rejects.toMatchObject({
      code: "unreadable_response",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a token grant of the wrong shape", async () => {
    const api = createApi({
      origin: ORIGIN,
      fetch: async () => json(200, { access_token: "short", token_type: "Bearer" }),
    });
    await expect(
      api.exchangeCode({ client_id: "c", redirect_uri: "r", code: "x", code_verifier: "v" }),
    ).rejects.toMatchObject({ code: "unreadable_response" });
  });
});

/** Headers arrive at once; the body never does, and errors when the request is aborted (as in Chrome). */
function stalledBody(contentType: string) {
  return vi.fn(
    async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(stream) {
            init.signal?.addEventListener("abort", () => stream.error(new DOMException("aborted", "AbortError")));
          },
        }),
        { status: 200, headers: { "Content-Type": contentType } },
      ),
  );
}

describe("deadline and cancellation cover the response body", () => {
  it("times out a job answer whose JSON body never arrives, and does not resend", async () => {
    vi.useFakeTimers();
    try {
      const fetch = stalledBody("application/json");
      const api = createApi({ origin: ORIGIN, fetch });
      const caught = api.createJob("tok", BODY, 5000).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5000);
      const error = (await caught) as MyDubbError;
      expect(error).toBeInstanceOf(MyDubbError);
      expect(error.code).toBe("timeout");
      expect(NO_ANSWER.has(error.code)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the caller's cancellation through while the body is read", async () => {
    const api = createApi({ origin: ORIGIN, fetch: stalledBody("application/json") });
    const controller = new AbortController();
    const pending = api.getJob("tok", "j1", controller.signal).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const error = (await pending) as DOMException;
    expect(error).not.toBeInstanceOf(MyDubbError);
    expect(error.name).toBe("AbortError");
  });

  it("times out or cancels an MP3 body that stalls", async () => {
    vi.useFakeTimers();
    try {
      const api = createApi({ origin: ORIGIN, fetch: stalledBody("audio/mpeg") });
      const caught = api.getAudio("tok", "/api/jobs/j1/result/audio").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(AUDIO_TIMEOUT_MS);
      expect(((await caught) as MyDubbError).code).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
    const api = createApi({ origin: ORIGIN, fetch: stalledBody("audio/mpeg") });
    const controller = new AbortController();
    const pending = api.getAudio("tok", "/api/jobs/j1/result/audio", controller.signal).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(((await pending) as DOMException).name).toBe("AbortError");
  });

  it("reports a body that is not JSON as unreadable, not as a timeout or a refusal", async () => {
    const api = createApi({
      origin: ORIGIN,
      fetch: async () => new Response("{not json", { status: 202, headers: { "Content-Type": "application/json" } }),
    });
    await expect(api.createJob("tok", BODY, 5000)).rejects.toMatchObject({ code: "unreadable_response", status: 202 });
  });
});
