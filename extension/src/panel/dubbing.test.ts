import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MyDubbError, type MyDubbApi } from "./api";
import { AUTH_KEY, type StoredAuth } from "./auth";
import type { PanelPlayerView, PlayerCommand } from "../shared/playback";
import { Dubbing, type DubbingDeps } from "./dubbing";
import type { JobRecord } from "./jobs";
import type { OpenOutcome, OpenRequest, PanelPlayer } from "./player";
import { NO_SYNC } from "../shared/testSync";

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

/** Stands in for the offscreen session (player.ts): records what the panel asks of it. */
class FakePlayer implements PanelPlayer {
  view: PanelPlayerView | null = null;
  readonly opened: { request: OpenRequest; blob: Blob }[] = [];
  readonly ended: (string | undefined)[] = [];
  readonly commands: PlayerCommand[] = [];
  readonly floating: boolean[] = [];
  readonly syncs: boolean[] = [];
  disposed = false;
  nextOutcome: OpenOutcome | null = null;
  private readonly listeners: (() => void)[] = [];

  subscribe(listener: () => void): void {
    this.listeners.push(listener);
  }
  async ready(): Promise<void> {}
  async open(request: OpenRequest, blob: Blob): Promise<OpenOutcome> {
    this.opened.push({ request, blob });
    if (this.nextOutcome) return this.nextOutcome;
    const sessionId = `session-${this.opened.length}`;
    this.set({
      sessionId,
      lessonKey: request.lessonKey,
      status: "ready",
      paused: true,
      ended: false,
      currentTime: 0,
      duration: 180,
      problem: null,
      choices: request.choices,
      floating: false,
      sync: NO_SYNC,
      owner: request.owner,
      linked: false,
    });
    return { ok: true, sessionId };
  }
  command(command: PlayerCommand): void {
    this.commands.push(command);
  }
  setFloating(visible: boolean): void {
    this.floating.push(visible);
    if (this.view) this.set({ ...this.view, floating: visible });
  }
  setSync(on: boolean): void {
    this.syncs.push(on);
  }
  end(sessionId?: string): void {
    this.ended.push(sessionId);
    if (this.view && (!sessionId || sessionId === this.view.sessionId)) this.set(null);
  }
  dispose(): void {
    this.disposed = true;
  }
  set(view: PanelPlayerView | null): void {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
}

let transcript = "";
let lesson: string | null | undefined = LESSON;
let player: FakePlayer;
let links: string[];

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
    player,
  };
  const dubbing = new Dubbing(deps, {
    currentLesson: () => lesson,
    transcript: () => transcript,
    linkPlayback: (key) => links.push(key),
  });
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
  player = new FakePlayer();
  links = [];
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
  it("hands the MP3 to the tab's playback session with the job's own choices, never playing it", async () => {
    const { dubbing, api } = await started();
    choose("target-language", "arabic");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect(api.getAudio).toHaveBeenCalledWith(AUTH.token, "/api/jobs/job-1/result/audio", expect.any(AbortSignal));
    expect(player.opened).toHaveLength(1);
    const [{ request, blob }] = player.opened as [{ request: OpenRequest; blob: Blob }];
    expect(blob.type).toBe("audio/mpeg");
    expect(request).toEqual({
      lessonKey: LESSON,
      owner: { userId: "u1", connectionId: "conn-a", jobId: "job-1", operationId: "id-1" },
      choices: { languageLabel: "Arabic", voiceLabel: "Andrew Multilingual", speed: 1 },
      // The result says 1.5x while the click sent 1x: the span is not confirmed, so no Sync.
      sync: null,
    });
    // The form changing later does not change what the player says the file was made with.
    choose("speed", "2");
    expect($("player-info").textContent).toBe("Loaded: Arabic · Andrew Multilingual · 1x");
    expect(player.commands).toEqual([]);
    expect($("audio-status").textContent).toBe("Ready. Press play when you want to listen.");
    // The page is asked to link itself to the session (for the lecture watch and floating player).
    expect(links).toEqual([LESSON]);
    const translation = $("translation");
    expect(translation.textContent).toBe("<b>نص</b>");
    expect(translation.children).toHaveLength(0); // shown as text, never as HTML
    expect(translation.dir).toBe("rtl");
    expect($("result-durations").textContent).toContain("00:06:00");
    // Closing the panel only drops the link: the session (and the audio) carries on.
    dubbing.dispose();
    expect(player.disposed).toBe(true);
    expect(player.ended).toEqual([]);
  });

  it("drives the session from the panel controls", async () => {
    await started();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect($("player-section").hidden).toBe(false);
    expect($("player-time").textContent).toBe("0:00 / 3:00");
    $<HTMLButtonElement>("player-play").click();
    player.set({ ...player.view!, paused: false, currentTime: 12 });
    expect($("player-play").textContent).toBe("Pause");
    $<HTMLButtonElement>("player-play").click();
    $<HTMLButtonElement>("player-back").click();
    $<HTMLButtonElement>("player-forward").click();
    const seek = $<HTMLInputElement>("player-seek");
    seek.value = "90";
    seek.dispatchEvent(new Event("input"));
    expect($("player-time").textContent).toBe("1:30 / 3:00");
    seek.dispatchEvent(new Event("change"));
    expect(player.commands).toEqual([
      { command: "play" },
      { command: "pause" },
      { command: "seek-by", value: -5 },
      { command: "seek-by", value: 5 },
      { command: "seek-to", value: 90 },
    ]);
    $<HTMLButtonElement>("player-floating").click();
    expect(player.floating).toEqual([true]);
    expect($("player-floating").textContent).toBe("Hide floating player");
  });

  it("a new Generate keeps the audio being listened to until the user switches", async () => {
    const api = fakeApi({
      createJob: vi
        .fn()
        .mockResolvedValueOnce({ id: "job-1", status: "queued" })
        .mockResolvedValueOnce({ id: "job-2", status: "queued" }),
      getJob: vi.fn(async (_token: string, id: string) => ({ id, status: "completed" })),
      getResult: vi.fn(async (_token: string, id: string) => ({ ...RESULT, job_id: id, audio: { ...RESULT.audio, url: `/api/jobs/${id}/result/audio` } })),
    });
    await started(undefined, api);
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    player.set({ ...player.view!, paused: false, currentTime: 42 });
    choose("speed", "2");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    // Nothing replaced or stopped the first audio, and the second was not downloaded yet.
    expect(player.opened).toHaveLength(1);
    expect(player.ended).toEqual([]);
    expect(api.getAudio).toHaveBeenCalledTimes(1);
    expect($("player-other").hidden).toBe(false);
    expect($("player-other-text").textContent).toContain("1x");
    $<HTMLButtonElement>("player-switch").click();
    await settle(12);
    expect(player.ended).toEqual(["session-1"]);
    expect(player.opened[1]?.request.owner.jobId).toBe("job-2");
    expect(player.opened[1]?.request.choices.speed).toBe(2);
    expect($("player-other").hidden).toBe(true);
    expect(api.createJob).toHaveBeenCalledTimes(2);
  });

  it("does not download again when the tab's session already has this job (panel reopened)", async () => {
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
    player.view = {
      sessionId: "session-x",
      lessonKey: LESSON,
      status: "ready",
      paused: false,
      ended: false,
      currentTime: 33,
      duration: 180,
      problem: null,
      choices: { languageLabel: "Arabic", voiceLabel: "Emma", speed: 1.5 },
      floating: true,
      sync: NO_SYNC,
      owner: { userId: "u1", connectionId: "conn-a", jobId: "job-1", operationId: "op-1" },
      linked: true,
    };
    const { api } = await started(fakeStorage({ [AUTH_KEY]: AUTH, [`job:${TAB}`]: record }));
    await settle(10);
    expect(api.getAudio).not.toHaveBeenCalled();
    expect(player.opened).toHaveLength(0);
    expect(player.ended).toEqual([]);
    expect($("player-play").textContent).toBe("Pause");
    expect($("player-time").textContent).toBe("0:33 / 3:00");
  });

  it("ends a session of another account connection or lecture instead of showing it", async () => {
    player.view = {
      sessionId: "session-old",
      lessonKey: LESSON,
      status: "ready",
      paused: false,
      ended: false,
      currentTime: 1,
      duration: 180,
      problem: null,
      choices: { languageLabel: "Vietnamese", voiceLabel: "Andrew", speed: 1 },
      floating: false,
      sync: NO_SYNC,
      owner: { userId: "u1", connectionId: "conn-old", jobId: "job-9", operationId: "op-9" },
      linked: true,
    };
    await started();
    expect(player.ended).toEqual(["session-old"]);
    expect($("player-section").hidden).toBe(true);
  });

  it("after the page released the session, Load audio downloads again without a new job", async () => {
    const { api } = await started();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    player.set(null); // the Udemy tab reloaded
    expect($("audio-status").textContent).toMatch(/player was released/);
    expect($<HTMLButtonElement>("player-load").hidden).toBe(false);
    $<HTMLButtonElement>("player-load").click();
    await settle(12);
    expect(api.getAudio).toHaveBeenCalledTimes(2);
    expect(player.opened).toHaveLength(2);
    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect($("audio-status").textContent).toBe("Ready. Press play when you want to listen.");
  });

  it("reports a player that refused the audio, with a way to try again", async () => {
    player.nextOutcome = { ok: false, reason: "unavailable" };
    await started();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect($("audio-status").textContent).toMatch(/player could not start/);
    expect($<HTMLButtonElement>("player-load").hidden).toBe(false);
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
    expect(player.opened).toHaveLength(1);

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
    expect(player.opened).toHaveLength(0);
    expect(player.ended).toContain(undefined);
  });

  it("stops the audio and clears the result when the account changes", async () => {
    const { dubbing, storage } = await started();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect(player.view?.sessionId).toBe("session-1");
    dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH, newValue: OTHER } });
    expect(player.view).toBeNull();
    expect($("player-section").hidden).toBe(true);
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
    expect(player.opened.map((o) => o.request.owner.jobId)).toEqual(["job-B"]);
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
    expect(player.opened).toHaveLength(1);
    expect(api.createJob).toHaveBeenCalledTimes(1);
  });
});

describe("Sync with video", () => {
  const PLAIN_RESULT = { ...RESULT, baseline_duration_seconds: 46, speed: 1.5, output_duration_seconds: 46 / 1.5 };
  const SYNC_VIEW = (status: string, confirmed = false) => ({
    status,
    unavailable: status === "unavailable" ? "length-mismatch" : null,
    start: 10,
    end: 56,
    duration: 30.563,
    rate: 46 / 30.563,
    confirmed,
    notice: null,
  });

  async function generate(api = fakeApi({ getResult: vi.fn(async () => PLAIN_RESULT) })) {
    const made = await started(undefined, api);
    typeTime("first-start", "000010");
    typeTime("last-start", "000056");
    choose("speed", "1.5");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    return made;
  }

  it("plain: keeps the click's two start times with the job and hands them to the player", async () => {
    const { storage } = await generate();
    const record = storage.data[`job:${TAB}`] as JobRecord;
    expect(record.choices.sync).toEqual({ mode: "plain", start: 10, end: 56, baseline: 46, speed: 1.5 });
    expect(player.opened[0]!.request.sync).toEqual({ mode: "plain", start: 10, end: 56, baseline: 46, speed: 1.5 });
    // A form edit after Generate is not the job's span.
    typeTime("first-start", "000001");
    expect((storage.data[`job:${TAB}`] as JobRecord).choices.sync?.start).toBe(10);
  });

  it("timed: the first and last caption with milliseconds, and the changed baseline of the fields", async () => {
    const result = {
      ...RESULT,
      baseline_duration_seconds: 46,
      speed: 1.5,
      timing: { mode: "timed", source_first_seconds: 10.25, source_last_seconds: 40.25, source_baseline_seconds: 30, selected_baseline_seconds: 46 },
    };
    const { dubbing, storage } = await started(undefined, fakeApi({ getResult: vi.fn(async () => result) }));
    transcript = "0:10.250\nHello.\n0:25\nMiddle.\n0:40.250\nLast.";
    dubbing.transcriptChanged();
    expect($<HTMLInputElement>("last-start").value).toBe("00:00:40");
    typeTime("last-start", "000056");
    choose("speed", "1.5");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    const expected = { mode: "timed", start: 10.25, end: 40.25, baseline: 46, speed: 1.5 };
    expect((storage.data[`job:${TAB}`] as JobRecord).choices.sync).toEqual(expected);
    expect(player.opened[0]!.request.sync).toEqual(expected);
  });

  it("drops the span when the server's result disagrees with the click (another caption span, baseline or speed)", async () => {
    const result = {
      ...RESULT,
      baseline_duration_seconds: 30,
      speed: 1,
      timing: { mode: "timed", source_first_seconds: 10.25, source_last_seconds: 41, source_baseline_seconds: 30.75, selected_baseline_seconds: 30 },
    };
    const { dubbing } = await started(undefined, fakeApi({ getResult: vi.fn(async () => result) }));
    transcript = "0:10.250\nHello.\n0:40.250\nLast.";
    dubbing.transcriptChanged();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect(player.opened[0]!.request.sync).toBeNull();
    // A plain click whose result says timed is not trusted either.
    expect(player.opened).toHaveLength(1);
  });

  it("a job record from before Sync existed still plays, without a span (no guess from the form)", async () => {
    const record: JobRecord = {
      operationId: "op-1",
      userId: "u1",
      connectionId: "conn-a",
      lessonKey: LESSON,
      state: "created",
      jobId: "job-1",
      sentAt: 0,
      choices: { languageLabel: "Arabic", voiceLabel: "Emma", speed: 1.5, timed: false, firstStart: "00:00:10", lastStart: "00:00:56" },
    };
    const form = { lessonKey: LESSON, firstStart: "00:00:10", lastStart: "00:00:56", ignoreTimestamps: false, targetLanguage: "arabic", voice: "", speed: 1.5, filledFrom: null };
    await started(
      fakeStorage({ [AUTH_KEY]: AUTH, [`job:${TAB}`]: record, [`form:${TAB}`]: form }),
      fakeApi({ getResult: vi.fn(async () => PLAIN_RESULT) }),
    );
    await settle(12);
    expect(player.opened).toHaveLength(1);
    expect(player.opened[0]!.request.sync).toBeNull();
  });

  it("explains before the first time, then turns Sync on and off through the player", async () => {
    await generate();
    const view = player.view!;
    player.set({ ...view, sync: SYNC_VIEW("off") as PanelPlayerView["sync"] });
    expect($("sync-status").textContent).toBe("Sync with video: OFF");
    expect($<HTMLButtonElement>("sync-toggle").disabled).toBe(false);
    $<HTMLButtonElement>("sync-toggle").click();
    expect($("sync-confirm").hidden).toBe(false);
    expect($("sync-preview").textContent).toBe(
      "Video 0:10 → 0:56 (46 s), MP3 30.563 s, video speed 1.505x. The video is muted: the MyDubb audio replaces the spoken part. The timing is an estimate, not word by word.",
    );
    expect(player.syncs).toEqual([]);
    $<HTMLButtonElement>("sync-cancel").click();
    expect($("sync-confirm").hidden).toBe(true);
    expect(player.syncs).toEqual([]);
    $<HTMLButtonElement>("sync-toggle").click();
    $<HTMLButtonElement>("sync-on").click();
    expect(player.syncs).toEqual([true]);
    player.set({ ...player.view!, sync: SYNC_VIEW("playing", true) as PanelPlayerView["sync"] });
    expect($("sync-status").textContent).toBe("Sync with video: ON · Playing");
    expect($("sync-toggle").textContent).toBe("Turn off sync");
    expect($("sync-toggle").getAttribute("aria-pressed")).toBe("true");
    $<HTMLButtonElement>("sync-toggle").click();
    expect(player.syncs).toEqual([true, false]);
    // Confirmed once for this session: on again directly.
    player.set({ ...player.view!, sync: { ...(SYNC_VIEW("off", true) as PanelPlayerView["sync"]), notice: "rate-changed" } });
    expect($("sync-notice").textContent).toContain("the video speed changed from");
    $<HTMLButtonElement>("sync-toggle").click();
    expect(player.syncs).toEqual([true, false, true]);
    expect($("sync-confirm").hidden).toBe(true);
    // Unavailable: the reason, and no way to turn it on.
    player.set({ ...player.view!, sync: SYNC_VIEW("unavailable") as PanelPlayerView["sync"] });
    expect($("sync-status").textContent).toMatch(/^Sync unavailable: the MP3 length does not match/);
    expect($<HTMLButtonElement>("sync-toggle").disabled).toBe(true);
  });
});
