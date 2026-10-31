import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MyDubbError, type MyDubbApi } from "./api";
import { AUTH_KEY, type StoredAuth } from "./auth";
import { Dubbing, type DubbingDeps } from "./dubbing";
import type { JobRecord } from "./jobs";

const html = readFileSync(join(__dirname, "../../static/sidepanel.html"), "utf8");
const TAB = 7;
const LESSON = "demo-course/1";
const AUTH: StoredAuth = {
  token: "token-a".padEnd(43, "a"),
  user: { id: "u1", email: "lan@example.com", display_name: "Lan" },
  expiresAt: "2099-01-01T00:00:00Z",
  connectionId: "conn-a",
};
const OTHER: StoredAuth = { ...AUTH, token: "token-b".padEnd(43, "b"), user: { id: "u2", email: "minh@example.com", display_name: null }, connectionId: "conn-b" };
const META = {
  providers: { translation: "mock", speech: "mock", audio: "mock" },
  voices: [
    { id: "AndrewMultilingual", label: "Andrew Multilingual", provider_voice: "x", description: "" },
    { id: "EmmaMultilingual", label: "Emma Multilingual", provider_voice: "y", description: "" },
  ],
  target_languages: [
    { id: "vietnamese", label: "Vietnamese", noun: "Vietnamese", translator_language: "vi" },
    { id: "arabic", label: "Arabic", noun: "Arabic", translator_language: "ar", text_direction: "rtl" },
  ],
  default_target_language: "vietnamese",
};
const job = (status: string) => ({ id: "job-1", status });
const RESULT = {
  job_id: "job-1",
  target_language: "arabic",
  target_language_label: "Arabic",
  baseline_duration_seconds: 360,
  speed: 1.5,
  output_duration_seconds: 240,
  translation: { text: "<b>نص</b>", is_illustrative: true, provider: "mock" },
  audio: { url: "/api/jobs/job-1/result/audio", download_url: "", content_type: "audio/mpeg", provider: "mock", is_fixture: true, duration_adjusted: false, duration: null },
  expires_at: "2099-01-01T01:00:00Z",
  notices: ["Mock notice."],
};

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const keysOf = (keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]);
  return {
    data,
    get: vi.fn(async (keys: string | string[]) =>
      Object.fromEntries(keysOf(keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, structuredClone(items));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of keysOf(keys)) delete data[k];
    }),
  };
}

function fakeApi(overrides: Partial<Record<keyof MyDubbApi, unknown>> = {}) {
  return {
    meta: vi.fn(async () => META),
    session: vi.fn(async () => ({ user: AUTH.user, expires_at: AUTH.expiresAt })),
    exchangeCode: vi.fn(),
    logout: vi.fn(async () => undefined),
    createJob: vi.fn(async () => job("queued")),
    getJob: vi.fn(async () => job("completed")),
    getResult: vi.fn(async () => RESULT),
    getAudio: vi.fn(async () => new Blob(["mp3"], { type: "audio/mpeg" })),
    ...overrides,
  } as unknown as FakeApi;
}

type FakeApi = { [K in keyof MyDubbApi]: ReturnType<typeof vi.fn> };

let transcript = "";
let lesson: string | null | undefined = LESSON;
let urls: { created: string[]; revoked: string[] };

function make(storage = fakeStorage({ [AUTH_KEY]: AUTH }), api = fakeApi()) {
  const deps: DubbingDeps = {
    tabId: TAB,
    origin: "https://mydubb.test",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    api: api as unknown as MyDubbApi,
    storage: storage as unknown as DubbingDeps["storage"],
    launchWebAuthFlow: vi.fn(),
    randomId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    now: () => Date.parse("2030-01-01T00:00:00Z"),
    createObjectURL: () => {
      const url = `blob:test/${urls.created.length + 1}`;
      urls.created.push(url);
      return url;
    },
    revokeObjectURL: (url) => urls.revoked.push(url),
  };
  const dubbing = new Dubbing(deps, { currentLesson: () => lesson, transcript: () => transcript });
  return { dubbing, storage, api };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await flush();
}

function typeTime(id: string, value: string) {
  const input = $<HTMLInputElement>(id);
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: value }));
}

function choose(id: string, value: string) {
  const select = $<HTMLSelectElement>(id);
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  transcript = "Spring Boot uses Dependency Injection.";
  lesson = LESSON;
  urls = { created: [], revoked: [] };
});

afterEach(() => {
  document.body.replaceChildren();
});

async function started(storage?: ReturnType<typeof fakeStorage>, api?: ReturnType<typeof fakeApi>) {
  const made = make(storage, api);
  await made.dubbing.start();
  made.dubbing.lessonState(lesson ?? null);
  return made;
}

describe("form and request", () => {
  it("sends the edited text with the chosen language, voice and speed, from the server's lists", async () => {
    const { api } = await started();
    expect([...$<HTMLSelectElement>("target-language").options].map((o) => o.value)).toEqual(["vietnamese", "arabic"]);
    expect($<HTMLSelectElement>("target-language").value).toBe("vietnamese");
    expect([...$<HTMLSelectElement>("speed").options].map((o) => o.value)).toEqual(["0.5", "0.75", "1", "1.25", "1.5", "1.75", "2"]);
    typeTime("first-start", "000010");
    typeTime("last-start", "000610");
    choose("target-language", "arabic");
    choose("voice", "EmmaMultilingual");
    choose("speed", "1.5");
    expect($("length-summary").textContent).toContain("00:04:00");
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(api.createJob).toHaveBeenCalledTimes(1);
    const [token, body] = api.createJob.mock.calls[0] as [string, unknown];
    expect(token).toBe(AUTH.token);
    expect(body).toEqual({
      transcript,
      first_sentence_start: "00:00:10",
      last_sentence_start: "00:06:10",
      voice: "EmmaMultilingual",
      speed: 1.5,
      target_language: "arabic",
    });
  });

  it("fills the start times from a timestamped transcript and asks for timed mode, unless ignored", async () => {
    const { dubbing, api } = await started();
    transcript = "0:05.480\nFirst caption.\n0:12\nSecond caption.";
    dubbing.transcriptChanged();
    expect($<HTMLInputElement>("first-start").value).toBe("00:00:05");
    expect($<HTMLInputElement>("last-start").value).toBe("00:00:12");
    expect($("timing-text").textContent).toContain("2 captions from 0:05.480 to 0:12");
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect((api.createJob.mock.calls[0] as [string, { timing_mode?: string }])[1].timing_mode).toBe("timed");
    $<HTMLInputElement>("ignore-timestamps").click();
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(api.createJob.mock.calls[1]?.[1]).not.toHaveProperty("timing_mode");
  });

  it("sends one request for a double click, and later edits do not change it", async () => {
    let answer!: (value: unknown) => void;
    const api = fakeApi({ createJob: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
    await started(undefined, api);
    typeTime("first-start", "000010");
    typeTime("last-start", "000610");
    $<HTMLButtonElement>("generate").click();
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect($<HTMLButtonElement>("generate").disabled).toBe(true);
    const sent = structuredClone((api.createJob.mock.calls[0] as [string, unknown])[1]);
    transcript = "Edited later.";
    choose("speed", "2");
    answer(job("queued"));
    await settle();
    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({ transcript: "Spring Boot uses Dependency Injection.", speed: 1 });
    expect($("job-choices").textContent).toContain("1x");
  });

  it("shows the server's field errors and creates nothing", async () => {
    const refusal = new MyDubbError(422, "validation_error", "Fix the times.", [
      { field: "last_sentence_start", message: "Must be after the first." },
    ]);
    const { storage } = await started(undefined, fakeApi({ createJob: vi.fn(async () => Promise.reject(refusal)) }));
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect($("last-start-error").textContent).toBe("Must be after the first.");
    expect($("form-error").textContent).toBe("Fix the times.");
    expect(storage.data[`job:${TAB}`]).toBeUndefined();
  });
});

describe("job and result", () => {
  it("plays the real MP3 through an object URL at 1x, never by itself, and releases it", async () => {
    const { dubbing, api } = await started();
    choose("target-language", "arabic");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect(api.getAudio).toHaveBeenCalledWith(AUTH.token, "/api/jobs/job-1/result/audio", expect.any(AbortSignal));
    const audio = $<HTMLAudioElement>("result-audio");
    expect(audio.getAttribute("src")).toBe("blob:test/1");
    expect(audio.playbackRate).toBe(1);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    const translation = $("translation");
    expect(translation.textContent).toBe("<b>نص</b>");
    expect(translation.children).toHaveLength(0); // shown as text, never as HTML
    expect(translation.dir).toBe("rtl");
    expect($("result-durations").textContent).toContain("00:06:00");
    dubbing.dispose();
    expect(urls.revoked).toEqual(["blob:test/1"]);
    expect(audio.hasAttribute("src")).toBe(false);
  });

  it("keeps an unanswered request as unknown and never sends it again", async () => {
    const timeout = new MyDubbError(0, "timeout", "MyDubb did not answer in time.");
    const { storage, api } = await started(undefined, fakeApi({ createJob: vi.fn(async () => Promise.reject(timeout)) }));
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect($("job-error").textContent).toMatch(/not known whether the job was created/);
    expect((storage.data[`job:${TAB}`] as JobRecord).state).toBe("sending");
    // Reopening the panel says the same, and still sends nothing.
    const reopened = await started(storage, api);
    expect($("job-error").textContent).toMatch(/not known whether the job was created/);
    expect(api.createJob).toHaveBeenCalledTimes(1);
    reopened.dubbing.dispose();
  });

  it("shows the server's message for a failed job", async () => {
    const failed = { ...job("failed"), error: { code: "speech_quota_exceeded", message: "The speech quota is used up." } };
    await started(undefined, fakeApi({ getJob: vi.fn(async () => failed) }));
    $<HTMLButtonElement>("generate").click();
    await settle(10);
    expect($("job-error").textContent).toBe("The job failed: The speech quota is used up.");
  });

  it("resumes the job of this account and lecture when the panel reopens", async () => {
    const record: JobRecord = {
      operationId: "op-1",
      userId: "u1",
      connectionId: "conn-a",
      lessonKey: LESSON,
      state: "created",
      jobId: "job-1",
      sentAt: 0,
      choices: { languageLabel: "Arabic", voiceLabel: "Emma", speed: 1.5, timed: false, firstStart: "00:00:10", lastStart: "00:06:10" },
    };
    const storage = fakeStorage({ [AUTH_KEY]: AUTH, [`job:${TAB}`]: record });
    const { api } = await started(storage);
    await settle(10);
    expect(api.getJob).toHaveBeenCalledWith(AUTH.token, "job-1", expect.any(AbortSignal));
    expect(api.createJob).not.toHaveBeenCalled();
    expect($<HTMLAudioElement>("result-audio").getAttribute("src")).toBe("blob:test/1");

    // Another account's record is dropped, never followed.
    const other = fakeStorage({ [AUTH_KEY]: OTHER, [`job:${TAB}`]: record });
    const second = await started(other);
    await settle();
    expect(second.api.getJob).not.toHaveBeenCalled();
    expect(other.data[`job:${TAB}`]).toBeUndefined();
  });
});

describe("isolation", () => {
  it("drops a job of lecture A once the tab shows lecture B, and its late result too", async () => {
    let finish!: (value: unknown) => void;
    const api = fakeApi({
      getJob: vi.fn(() => new Promise((resolve) => (finish = resolve))),
    });
    const { dubbing, storage } = await started(undefined, api);
    $<HTMLButtonElement>("generate").click();
    await settle();
    lesson = "demo-course/2";
    dubbing.lessonState("demo-course/2");
    finish(job("completed"));
    await settle(10);
    expect(api.getResult).not.toHaveBeenCalled();
    expect($("result-section").hidden).toBe(true);
    expect($("form-error").textContent).toMatch(/lecture changed/);
    expect(storage.data[`job:${TAB}`]).toBeUndefined();
    expect($<HTMLAudioElement>("result-audio").hasAttribute("src")).toBe(false);
  });

  it("stops the audio and clears the result when the account changes", async () => {
    const { dubbing, storage } = await started();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect($<HTMLAudioElement>("result-audio").getAttribute("src")).toBe("blob:test/1");
    dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH, newValue: OTHER } });
    expect(urls.revoked).toEqual(["blob:test/1"]);
    expect($("translation").textContent).toBe("");
    expect($("account-status").textContent).toContain("minh@example.com");
    await settle();
    expect(storage.data[`job:${TAB}`]).toBeUndefined();
  });

  it("ignores the answer to a request sent before signing out", async () => {
    let answer!: (value: unknown) => void;
    const api = fakeApi({ createJob: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
    const { dubbing } = await started(undefined, api);
    $<HTMLButtonElement>("generate").click();
    await settle();
    dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH } });
    answer(job("queued"));
    await settle(10);
    expect(api.getJob).not.toHaveBeenCalled();
    expect($("result-section").hidden).toBe(true);
    expect($<HTMLButtonElement>("generate").disabled).toBe(true);
    expect($<HTMLButtonElement>("connect").hidden).toBe(false);
  });

  it("a late answer for the previous account does not unlock a newer request", async () => {
    const answers: ((value: unknown) => void)[] = [];
    const api = fakeApi({ createJob: vi.fn(() => new Promise((resolve) => answers.push(resolve))) });
    const { dubbing } = await started(undefined, api);
    $<HTMLButtonElement>("generate").click();
    await settle();
    dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH, newValue: OTHER } });
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(api.createJob).toHaveBeenCalledTimes(2);
    expect((api.createJob.mock.calls[1] as [string])[0]).toBe(OTHER.token);
    answers[0]!(job("queued"));
    await settle();
    expect($<HTMLButtonElement>("generate").disabled).toBe(true);
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(api.createJob).toHaveBeenCalledTimes(2);
  });

  it("removes a token the server refuses and asks to connect again", async () => {
    const refused = new MyDubbError(401, "not_authenticated", "A valid session is required.");
    const { storage } = await started(undefined, fakeApi({ getJob: vi.fn(async () => Promise.reject(refused)) }));
    $<HTMLButtonElement>("generate").click();
    await settle(10);
    expect(storage.data[AUTH_KEY]).toBeUndefined();
    expect($("account-error").textContent).toMatch(/Connect again/);
  });

  it("disconnect forgets the token before asking the server to end it", async () => {
    const { storage, api } = await started();
    $<HTMLButtonElement>("disconnect").click();
    await settle();
    expect(storage.data[AUTH_KEY]).toBeUndefined();
    expect(api.logout).toHaveBeenCalledWith(AUTH.token);
    expect($("account-status").textContent).toBe("Disconnected from MyDubb.");
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("restoring a reopened panel", () => {
  const TIMED_NEW = "0:01\nFirst caption.\n0:21\nLast caption.";
  const OLD_FORM = {
    lessonKey: LESSON,
    firstStart: "00:00:10",
    lastStart: "00:06:10",
    ignoreTimestamps: false,
    targetLanguage: "arabic",
    voice: "EmmaMultilingual",
    speed: 1.5,
    filledFrom: null,
  };

  it("a slow stored snapshot never overwrites a selection that arrived meanwhile", async () => {
    const storage = fakeStorage({ [AUTH_KEY]: AUTH, [`form:${TAB}`]: OLD_FORM });
    const read = deferred();
    const get = storage.get;
    storage.get = vi.fn(async (keys: string | string[]) => {
      await read.promise;
      return get(keys);
    });
    const { dubbing } = make(storage);
    const starting = dubbing.start();
    // The pending selection (new timestamps) and the first page state arrive before the read ends.
    transcript = TIMED_NEW;
    dubbing.transcriptChanged();
    dubbing.lessonState(LESSON);
    read.resolve();
    await starting;
    await settle();
    expect($<HTMLInputElement>("first-start").value).toBe("00:00:01");
    expect($<HTMLInputElement>("last-start").value).toBe("00:00:21");
    // The other stored choices are still restored.
    expect($<HTMLSelectElement>("speed").value).toBe("1.5");
    // Saved after the 250 ms debounce: the stored form now holds the new times too.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((storage.data[`form:${TAB}`] as { firstStart: string }).firstStart).toBe("00:00:01");
  });

  it("an edit typed before the snapshot arrives is kept", async () => {
    const storage = fakeStorage({ [AUTH_KEY]: AUTH, [`form:${TAB}`]: OLD_FORM });
    const read = deferred();
    const get = storage.get;
    storage.get = vi.fn(async (keys: string | string[]) => {
      await read.promise;
      return get(keys);
    });
    const { dubbing } = make(storage);
    const starting = dubbing.start();
    await flush();
    typeTime("first-start", "000002");
    read.resolve();
    await starting;
    expect($<HTMLInputElement>("first-start").value).toBe("00:00:02");
  });

  it("keeps a manual override when the same draft and lecture are reopened", async () => {
    transcript = TIMED_NEW;
    const storage = fakeStorage({
      [AUTH_KEY]: AUTH,
      [`form:${TAB}`]: { ...OLD_FORM, firstStart: "00:00:03", lastStart: "00:00:21", filledFrom: "1-21" },
    });
    const { dubbing } = make(storage);
    await dubbing.start();
    dubbing.lessonState(LESSON);
    dubbing.transcriptChanged();
    expect($<HTMLInputElement>("first-start").value).toBe("00:00:03");
    expect($("timing-override").hidden).toBe(false);
  });
});

describe("a late write of an older job", () => {
  it("never stops, replaces or overwrites the job of a newer lecture", async () => {
    const storage = fakeStorage({ [AUTH_KEY]: AUTH });
    const held = deferred();
    const set = storage.set;
    storage.set = vi.fn(async (items: Record<string, unknown>) => {
      const value = items[`job:${TAB}`] as JobRecord | undefined;
      if (value?.state === "created" && value.jobId === "job-A") await held.promise;
      return set(items);
    });
    const resultFor = (id: string) => ({ ...RESULT, job_id: id, translation: { ...RESULT.translation, text: `text ${id}` } });
    const api = fakeApi({
      createJob: vi
        .fn()
        .mockResolvedValueOnce({ id: "job-A", status: "queued" })
        .mockResolvedValueOnce({ id: "job-B", status: "queued" }),
      getJob: vi.fn(async (_token: string, id: string) => ({ id, status: "completed" })),
      getResult: vi.fn(async (_token: string, id: string) => resultFor(id)),
    });
    const { dubbing } = await started(storage, api);
    $<HTMLButtonElement>("generate").click();
    await settle(); // A answered; its "created" write is held
    lesson = "demo-course/2";
    dubbing.lessonState("demo-course/2");
    $<HTMLButtonElement>("generate").click();
    await settle();
    held.resolve(); // the old write and its callback finish now
    await settle(20);
    expect(api.createJob).toHaveBeenCalledTimes(2);
    expect(api.getJob.mock.calls.map((c) => c[1])).toEqual(["job-B"]);
    expect($("translation").textContent).toBe("text job-B");
    expect($("job-status").textContent).toBe("Completed.");
    expect($<HTMLAudioElement>("result-audio").getAttribute("src")).toBe("blob:test/1");
    const stored = storage.data[`job:${TAB}`] as JobRecord;
    expect(stored.jobId).toBe("job-B");
    expect(stored.lessonKey).toBe("demo-course/2");
  });
});

describe("audio download", () => {
  it("a failed or timed-out MP3 download can be retried", async () => {
    const api = fakeApi({
      getAudio: vi
        .fn()
        .mockRejectedValueOnce(new MyDubbError(0, "timeout", "MyDubb did not answer in time."))
        .mockResolvedValueOnce(new Blob(["mp3"], { type: "audio/mpeg" })),
    });
    await started(undefined, api);
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect($("audio-status").textContent).toMatch(/could not be loaded: MyDubb did not answer in time/);
    expect($<HTMLButtonElement>("check-again").hidden).toBe(false);
    $<HTMLButtonElement>("check-again").click();
    await settle(12);
    expect($<HTMLAudioElement>("result-audio").getAttribute("src")).toBe("blob:test/1");
    expect(api.createJob).toHaveBeenCalledTimes(1);
  });
});
