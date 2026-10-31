import { describe, expect, it, vi } from "vitest";

import { MyDubbError, createApi } from "./api";

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
