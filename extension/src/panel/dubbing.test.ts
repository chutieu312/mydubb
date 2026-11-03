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
// Where the panel asked the page to pause the video, and what the page answers.
let placed: [string, number][];
let placeAnswer: () => Promise<string | null>;

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
    placeVideo: (key, at) => {
      placed.push([key, at]);
      return placeAnswer();
    },
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

/** A select's option, or a radio of a group (Audio speed). */
function choose(id: string, value: string) {
  const control = $(id);
  if (control instanceof HTMLSelectElement) {
    control.value = value;
    control.dispatchEvent(new Event("change"));
  } else {
    control.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click();
  }
}

const chosenSpeed = () => $("speed").querySelector<HTMLInputElement>("input:checked")?.value;
const playerTime = () => `${$("player-current").textContent} / ${$("player-duration").textContent}`;

beforeEach(() => {
  document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  transcript = "Spring Boot uses Dependency Injection.";
  lesson = LESSON;
  player = new FakePlayer();
  links = [];
  placed = [];
  placeAnswer = async () => null;
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
    expect([...$("speed").querySelectorAll("input")].map((o) => o.value)).toEqual(["0.5", "0.75", "1", "1.25", "1.5", "1.75", "2"]);
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
    expect($("player-info").textContent).toBe("Arabic · Andrew Multilingual · 1xVideo source not recorded MP3 180.000 s");
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
    expect(playerTime()).toBe("0:00 / 3:00");
    $<HTMLButtonElement>("player-play").click();
    player.set({ ...player.view!, paused: false, currentTime: 12 });
    expect($("player-play").textContent).toBe("Pause");
    $<HTMLButtonElement>("player-play").click();
    $<HTMLButtonElement>("player-back").click();
    $<HTMLButtonElement>("player-forward").click();
    const seek = $<HTMLInputElement>("player-seek");
    seek.value = "90";
    seek.dispatchEvent(new Event("input"));
    expect(playerTime()).toBe("1:30 / 3:00");
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

  describe("each finished result is loaded in place of the earlier audio", () => {
    const text = (id: string) => $(id).textContent;
    const mp3 = () => new Blob(["mp3"], { type: "audio/mpeg" });
    const SYNC_ON = { ...NO_SYNC, status: "playing", confirmed: true } as unknown as PanelPlayerView["sync"];
    const twoJobs = (extra: Partial<Record<keyof MyDubbApi, unknown>> = {}) =>
      fakeApi({
        createJob: vi
          .fn()
          .mockResolvedValueOnce({ id: "job-1", status: "queued" })
          .mockResolvedValueOnce({ id: "job-2", status: "queued" }),
        getJob: vi.fn(async (_token: string, id: string) => ({ id, status: "completed" })),
        getResult: vi.fn(async (_token: string, id: string) => ({
          ...RESULT,
          job_id: id,
          audio: {
            ...RESULT.audio,
            url: `/api/jobs/${id}/result/audio`,
            duration: { mp3_decoded_seconds: id === "job-2" ? 15.333 : 10 },
          },
          translation: { ...RESULT.translation, text: `Bản dịch ${id}` },
        })),
        ...extra,
      });

    /** Job 1 loaded (1x, 00:00:00 → 00:00:10) and playing, then job 2 generated (1.5x, 00:00:00 → 00:00:23). */
    async function earlierAndNew(api = twoJobs(), storage?: ReturnType<typeof fakeStorage>) {
      const made = await started(storage, api);
      typeTime("first-start", "000000");
      typeTime("last-start", "000010");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      player.set({ ...player.view!, paused: false, currentTime: 4, duration: 10 });
      typeTime("last-start", "000023");
      choose("speed", "1.5");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      return { ...made, api };
    }

    it("the first and every next result are loaded by themselves: audio, translation and facts together, paused", async () => {
      const { api } = await earlierAndNew();
      expect(api.createJob).toHaveBeenCalledTimes(2);
      expect(api.getAudio).toHaveBeenCalledTimes(2);
      expect(player.opened.map((o) => o.request.owner.jobId)).toEqual(["job-1", "job-2"]);
      expect(player.opened[1]?.request.choices).toMatchObject({ speed: 1.5, sourceRange: "00:00:00 → 00:00:23" });
      expect(player.view?.owner.jobId).toBe("job-2");
      expect(player.view?.paused).toBe(true);
      expect(player.commands).toEqual([]);
      expect(player.syncs).toEqual([]);
      expect(text("player-info")).toContain("1.5x");
      expect(text("player-info")).toContain("Video 00:00:00 → 00:00:23");
      expect(text("translation")).toBe("Bản dịch job-2");
      // No manual switch any more.
      expect(document.getElementById("player-switch")).toBeNull();
      expect(document.getElementById("result-switch")).toBeNull();
      expect(document.getElementById("player-badge")).toBeNull();
      expect($("job-note").hidden).toBe(true);
      expect($<HTMLButtonElement>("player-load").hidden).toBe(true);
      // The video is placed at each result's own start.
      expect(placed).toEqual([
        [LESSON, 0],
        [LESSON, 0],
      ]);
    });

    it("while the new job runs and its MP3 downloads, the earlier audio stays loaded and playing, with its own facts", async () => {
      let deliver!: (blob: Blob) => void;
      const api = twoJobs({
        getAudio: vi
          .fn()
          .mockResolvedValueOnce(mp3())
          .mockImplementationOnce(() => new Promise((resolve) => (deliver = resolve))),
      });
      await earlierAndNew(api);
      expect(player.view?.owner.jobId).toBe("job-1");
      expect(player.view?.paused).toBe(false);
      expect(text("translation")).toBe("Bản dịch job-1");
      expect(text("player-info")).toContain("00:00:00 → 00:00:10");
      expect(text("player-info")).not.toContain("00:00:23");
      expect($("job-note").hidden).toBe(false);
      expect(text("audio-status")).toBe("Loading the audio…");
      deliver(mp3());
      await settle(12);
      expect(player.view?.owner.jobId).toBe("job-2");
      expect(player.view?.paused).toBe(true);
      expect(text("translation")).toBe("Bản dịch job-2");
      expect($("job-note").hidden).toBe(true);
    });

    it("an earlier audio playing with Sync ON is replaced: the new one paused, Sync OFF, the video at its start", async () => {
      await started(undefined, twoJobs());
      typeTime("first-start", "000010");
      typeTime("last-start", "000056");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      player.set({ ...player.view!, paused: false, currentTime: 4, sync: SYNC_ON });
      expect($("sync-toggle").getAttribute("aria-pressed")).toBe("true");
      typeTime("first-start", "000113");
      typeTime("last-start", "000200");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(player.view?.owner.jobId).toBe("job-2");
      expect(player.view?.paused).toBe(true);
      expect(player.view?.currentTime).toBe(0);
      expect($("sync-toggle").getAttribute("aria-pressed")).toBe("false");
      expect(player.syncs).toEqual([]);
      expect(player.commands).toEqual([]);
      expect(placed.at(-1)).toEqual([LESSON, 73]);
      expect(text("video-place")).toBe("Video paused at 1:13, where this audio starts.");
    });

    it("places the video at the result's own start (from its Generate), not at what the form says now", async () => {
      let finish!: (value: unknown) => void;
      await started(undefined, fakeApi({ getJob: vi.fn(() => new Promise((resolve) => (finish = resolve))) }));
      typeTime("first-start", "000113");
      typeTime("last-start", "000300");
      $<HTMLButtonElement>("generate").click();
      await settle(6);
      typeTime("first-start", "000005");
      finish(job("completed"));
      await settle(12);
      expect(placed).toEqual([[LESSON, 73]]);
      expect(text("video-place")).toBe("Video paused at 1:13, where this audio starts.");
    });

    it("says when the video could not be placed, and never that it was", async () => {
      placeAnswer = async () => "The video is not ready yet. Wait for it to load.";
      await started();
      typeTime("first-start", "000010");
      typeTime("last-start", "000610");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(player.view?.paused).toBe(true);
      expect(text("video-place")).toBe("The video was not moved to 0:10: The video is not ready yet. Wait for it to load.");
    });

    it("a failed download keeps the earlier audio and its translation; Load audio retries without a new job", async () => {
      const api = twoJobs({
        getAudio: vi
          .fn()
          .mockResolvedValueOnce(mp3())
          .mockRejectedValueOnce(new MyDubbError(0, "timeout", "MyDubb did not answer in time."))
          .mockResolvedValueOnce(mp3()),
      });
      await earlierAndNew(api);
      expect(player.view?.owner.jobId).toBe("job-1");
      expect(player.view?.paused).toBe(false);
      expect(text("translation")).toBe("Bản dịch job-1");
      expect(text("audio-status")).toMatch(/could not be loaded/);
      expect($("job-note").hidden).toBe(false);
      expect($<HTMLButtonElement>("player-load").hidden).toBe(false);
      expect(placed).toHaveLength(1);
      $<HTMLButtonElement>("player-load").click();
      await settle(12);
      expect(api.createJob).toHaveBeenCalledTimes(2);
      expect(player.view?.owner.jobId).toBe("job-2");
      expect(text("translation")).toBe("Bản dịch job-2");
      expect(placed).toHaveLength(2);
    });

    it("a failed new job keeps the earlier audio and its translation", async () => {
      const failed = { id: "job-2", status: "failed", error: { code: "speech_quota_exceeded", message: "The speech quota is used up." } };
      const api = twoJobs({
        getJob: vi.fn(async (_token: string, id: string) => (id === "job-2" ? failed : { id, status: "completed" })),
      });
      await earlierAndNew(api);
      expect(player.opened).toHaveLength(1);
      expect(player.view?.owner.jobId).toBe("job-1");
      expect(text("translation")).toBe("Bản dịch job-1");
      expect(text("job-error")).toMatch(/speech quota is used up/);
      expect($("job-note").hidden).toBe(false);
    });

    it("a reopened panel whose new download failed shows the earlier audio's stored translation", async () => {
      const storage = fakeStorage({ [AUTH_KEY]: AUTH });
      const failing = new MyDubbError(0, "timeout", "MyDubb did not answer in time.");
      const api = twoJobs({ getAudio: vi.fn().mockResolvedValueOnce(mp3()).mockRejectedValue(failing) });
      const { dubbing } = await earlierAndNew(api, storage);
      dubbing.dispose();
      expect(storage.data[`loaded:${TAB}`]).toMatchObject({ jobId: "job-1", text: "Bản dịch job-1", tag: "ar", dir: "rtl" });

      document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
      await started(storage, api);
      await settle(12);
      expect(player.view?.owner.jobId).toBe("job-1");
      expect(text("translation")).toBe("Bản dịch job-1");
      expect($("translation").dir).toBe("rtl");
      expect(api.createJob).toHaveBeenCalledTimes(2);
    });

    it("loading an earlier result again (after a release) places the video at that result's own start", async () => {
      const { api } = await started();
      typeTime("first-start", "000030");
      typeTime("last-start", "000100");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(placed).toEqual([[LESSON, 30]]);
      player.set(null); // the tab reloaded: the session is gone
      typeTime("first-start", "000005");
      $<HTMLButtonElement>("player-load").click();
      await settle(12);
      expect(placed).toEqual([
        [LESSON, 30],
        [LESSON, 30],
      ]);
      expect(api.createJob).toHaveBeenCalledTimes(1);
    });

    it("a late download after a new Generate, a lecture change or an account change neither loads nor places", async () => {
      for (const change of ["generate", "lecture", "account"] as const) {
        document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
        player = new FakePlayer();
        placed = [];
        lesson = LESSON;
        let deliver!: (blob: Blob) => void;
        const api = twoJobs({ getAudio: vi.fn(() => new Promise((resolve) => (deliver = resolve))) });
        const { dubbing } = await started(undefined, api);
        typeTime("first-start", "000010");
        typeTime("last-start", "000020");
        $<HTMLButtonElement>("generate").click();
        await settle(12);
        if (change === "generate") {
          api.getJob.mockReturnValue(new Promise(() => undefined));
          $<HTMLButtonElement>("generate").click();
        } else if (change === "lecture") {
          lesson = "demo-course/2";
          dubbing.lessonState(lesson);
        } else {
          dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH, newValue: OTHER } });
        }
        await settle(6);
        deliver(mp3());
        await settle(12);
        expect(player.view, change).toBeNull();
        expect(placed, change).toEqual([]);
        dubbing.dispose();
      }
    });

    it("tells two jobs with the same language, voice and speed apart by span and length", async () => {
      const api = twoJobs();
      await started(undefined, api);
      choose("speed", "1.5");
      typeTime("first-start", "000000");
      typeTime("last-start", "000015");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(text("player-info")).toContain("00:00:00 → 00:00:15");
      typeTime("last-start", "000023");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(text("player-info")).toContain("1.5x");
      expect(text("player-info")).toContain("00:00:00 → 00:00:23");
      expect(text("player-info")).not.toContain("00:00:15");
    });

    it("a timed job shows and uses the captions' span (milliseconds kept), not the overridden fields", async () => {
      transcript = "0:05.480\nFirst caption.\n0:34.250\nSecond caption.";
      const api = twoJobs();
      await started(undefined, api);
      typeTime("first-start", "000010");
      typeTime("last-start", "000056");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(player.opened[0]?.request.choices.sourceRange).toBe("00:00:05.480 → 00:00:34.250");
      expect(text("player-info")).toContain("Video 00:00:05.480 → 00:00:34.250");
      expect(text("player-info")).not.toContain("00:00:56");
      // The video is placed where the captions start.
      expect(placed).toEqual([[LESSON, 5.48]]);
      expect(text("video-place")).toBe("Video paused at 0:05.480, where this audio starts.");
      // The form changing later changes nothing about the next result's span either.
      typeTime("first-start", "000100");
      typeTime("last-start", "000200");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(text("player-info")).toContain("Video 00:00:05.480 → 00:00:34.250");
      expect(text("player-info")).not.toContain("00:01:00");
    });

    it("a job without a Sync snapshot does not borrow its start-time fields for the source", async () => {
      transcript = "0:05.480\nFirst caption.\n0:34.250\nSecond caption.";
      await started();
      typeTime("first-start", "000010");
      typeTime("last-start", "000056");
      $<HTMLButtonElement>("ignore-timestamps").click();
      typeTime("first-start", "000010");
      typeTime("last-start", "000056");
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      // Plain here (timestamps ignored): the two fields are the source.
      expect(player.opened[0]?.request.choices.sourceRange).toBe("00:00:10 → 00:00:56");
      expect(placed).toEqual([[LESSON, 10]]);
    });

    it("an audio without a recorded span says so instead of borrowing the form's", async () => {
      await started();
      typeTime("first-start", "000500");
      typeTime("last-start", "000900");
      player.set({
        sessionId: "session-old",
        lessonKey: LESSON,
        status: "ready",
        paused: true,
        ended: false,
        currentTime: 0,
        duration: 12,
        problem: null,
        choices: { languageLabel: "Hindi", voiceLabel: "Old voice", speed: 0.75 },
        floating: false,
        sync: NO_SYNC,
        owner: { userId: "u1", connectionId: "conn-a", jobId: "job-9", operationId: "op-9" },
        linked: true,
      });
      expect(text("player-info")).toBe("Hindi · Old voice · 0.75xVideo source not recorded MP3 12.000 s");
      // Not this panel's result and no stored translation for it: said, never another result's text.
      expect(text("translation-heading")).toBe("Translation · Hindi");
      expect(text("translation")).toMatch(/no longer available/);
    });
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
    expect(playerTime()).toBe("0:33 / 3:00");
    // Reopening is not loading again: the video is left where it is.
    expect(placed).toEqual([]);
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
    // Said beside the form, where the click was; Your audio says it briefly.
    expect($("form-error").textContent).toMatch(/not known whether the job was created/);
    expect($("job-status").textContent).toMatch(/unknown whether this job was created/);
    expect((storage.data[`job:${TAB}`] as JobRecord).state).toBe("sending");
    // Reopening the panel says the same, and still sends nothing.
    $("form-error").textContent = "";
    const reopened = await started(storage, api);
    expect($("form-error").textContent).toMatch(/not known whether the job was created/);
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
    expect($("listen-notice").textContent).toMatch(/lecture changed/);
    expect($("listen-empty").hidden).toBe(false);
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
    expect($("account-status").textContent).toBe("Disconnected");
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
    expect(chosenSpeed()).toBe("1.5");
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

describe("job status spinner", () => {
  const working = () => $("job-status").classList.contains("working");
  const never = () => new Promise<never>(() => undefined);
  /** Real time: the poll waits a second between two answers. */
  async function until(check: () => boolean, ms = 4000) {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it.each([
    ["queued", "Queued…"],
    ["translating", "Translating…"],
    ["synthesizing", "Generating speech…"],
    ["processing", "Processing audio…"],
  ])("shows a spinner beside %s, the status staying in words", async (status, text) => {
    const getJob = vi.fn().mockResolvedValueOnce(job(status)).mockImplementation(never);
    const { dubbing } = await started(undefined, fakeApi({ getJob }));
    $<HTMLButtonElement>("generate").click();
    await settle(6);
    expect($("job-status").textContent).toBe(text);
    expect(working()).toBe(true);
    dubbing.dispose();
  });

  it("has none while sending, after an unknown outcome, or for a finished or failed job", async () => {
    let answer!: (value: unknown) => void;
    const sending = await started(undefined, fakeApi({ createJob: vi.fn(() => new Promise((resolve) => (answer = resolve))) }));
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect($("job-status").textContent).toBe("Sending to MyDubb…");
    expect(working()).toBe(false);
    answer(job("queued"));
    sending.dubbing.dispose();

    document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
    const timeout = new MyDubbError(0, "timeout", "MyDubb did not answer in time.");
    const unknown = await started(undefined, fakeApi({ createJob: vi.fn(async () => Promise.reject(timeout)) }));
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect($("job-status").textContent).toMatch(/unknown whether this job was created/);
    expect(working()).toBe(false);
    unknown.dubbing.dispose();

    document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
    await started();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect($("job-status").textContent).toBe("Completed.");
    expect(working()).toBe(false);

    document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
    const failed = { ...job("failed"), error: { code: "speech_quota_exceeded", message: "The speech quota is used up." } };
    await started(undefined, fakeApi({ getJob: vi.fn(async () => failed) }));
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect($("job-status").textContent).toBe("Failed.");
    expect(working()).toBe(false);
  });

  it.each([
    ["completes", async () => job("completed")],
    ["fails", async () => ({ ...job("failed"), error: { code: "job_failed", message: "Nope." } })],
    ["is gone", async () => Promise.reject(new MyDubbError(404, "not_found", "No such job."))],
  ])("stops when the job %s after it was running", async (_name, second) => {
    const getJob = vi.fn().mockResolvedValueOnce(job("translating")).mockImplementationOnce(second).mockImplementation(never);
    const { dubbing } = await started(undefined, fakeApi({ getJob }));
    $<HTMLButtonElement>("generate").click();
    await settle(6);
    expect(working()).toBe(true);
    await until(() => !working());
    expect(working()).toBe(false);
    dubbing.dispose();
  });

  it("stops when the panel gives up checking, and Check again starts it with the next answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const timeout = new MyDubbError(0, "timeout", "MyDubb did not answer in time.");
      const getJob = vi.fn().mockResolvedValueOnce(job("processing"));
      for (let i = 0; i < 5; i += 1) getJob.mockRejectedValueOnce(timeout);
      getJob.mockResolvedValueOnce(job("synthesizing")).mockImplementation(never);
      const { dubbing } = await started(undefined, fakeApi({ getJob }));
      $<HTMLButtonElement>("generate").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($("job-status").textContent).toBe("Processing audio…");
      expect(working()).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect($("job-error").textContent).toMatch(/Stopped checking the job/);
      expect($("job-status").textContent).toBe("Processing audio…");
      expect(working()).toBe(false);
      $<HTMLButtonElement>("check-again").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($("job-status").textContent).toBe("Generating speech…");
      expect(working()).toBe(true);
      dubbing.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the job is no longer followed (another lecture, another account)", async () => {
    for (const change of ["lecture", "account"] as const) {
      document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
      lesson = LESSON;
      const getJob = vi.fn().mockResolvedValueOnce(job("queued")).mockImplementation(never);
      const { dubbing } = await started(undefined, fakeApi({ getJob }));
      $<HTMLButtonElement>("generate").click();
      await settle(6);
      expect(working(), change).toBe(true);
      if (change === "lecture") {
        lesson = "demo-course/2";
        dubbing.lessonState(lesson);
      } else {
        dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH, newValue: OTHER } });
      }
      expect(working(), change).toBe(false);
      expect($("job-status").textContent, change).toBe("");
      dubbing.dispose();
    }
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
    expect($("sync-status").textContent).toBe("OFF");
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
    expect($("sync-status").textContent).toBe("ON · Playing");
    // The toggle keeps its name; its pressed state says ON.
    expect($("sync-toggle").textContent).toBe("Sync with video");
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

describe("one page: English transcript, Translate to, Your audio", () => {
  const SYNC_ON = {
    status: "playing",
    unavailable: null,
    start: 10,
    end: 56,
    duration: 30.563,
    rate: 1.5,
    confirmed: true,
    notice: null,
  } as unknown as PanelPlayerView["sync"];

  it("shows the three blocks at once, with no tabs; Your audio starts with a short empty state", async () => {
    await started();
    expect(document.querySelector("[role=tablist], [role=tab], [role=tabpanel]")).toBeNull();
    const headings = [...document.querySelectorAll("section > h2, section > .card-head > h2")].map((h) => h.textContent?.trim());
    expect(headings).toEqual(["English transcript", "Translate to", "Your audio"]);
    // The video row sits between the transcript and the two start times.
    const order = ["transcript", "video-box", "first-start", "last-start", "target-language", "speed", "generate", "player-section"].map($);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect($("video-heading").textContent).toBe("Video");
    expect($("listen-empty").hidden).toBe(false);
    expect($("result-section").hidden).toBe(true);
    expect($("player-section").hidden).toBe(true);
    expect($("result-details").hidden).toBe(true);
  });

  it("the seven speeds are radio buttons: one is checked, the choice is saved and sent", async () => {
    const { api } = await started();
    const radios = [...$("speed").querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((r) => r.parentElement?.textContent)).toEqual(["0.5x", "0.75x", "1x", "1.25x", "1.5x", "1.75x", "2x"]);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["1"]);
    choose("speed", "1.75");
    expect(chosenSpeed()).toBe("1.75");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect((api.createJob.mock.calls[0] as [string, { speed: number }])[1].speed).toBe(1.75);
  });

  it("an accepted Generate shows the job under Your audio without playing it; focus stays on Generate", async () => {
    let answer!: (value: unknown) => void;
    const api = fakeApi({ createJob: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
    await started(undefined, api);
    choose("speed", "1.5");
    $<HTMLButtonElement>("generate").click();
    await settle();
    answer(job("queued"));
    await settle(12);
    expect(document.activeElement).toBe($("generate"));
    expect($("listen-empty").hidden).toBe(true);
    expect($("result-section").hidden).toBe(false);
    expect($("job-choices").textContent).toContain("1.5x");
    expect(player.opened).toHaveLength(1);
    expect(player.commands).toEqual([]);
    expect(player.view?.paused).toBe(true);
  });

  it("a validation error focuses the field to fix and marks it", async () => {
    const refusal = new MyDubbError(422, "validation_error", "Fix the times.", [
      { field: "last_sentence_start", message: "Must be after the first." },
    ]);
    const { storage } = await started(undefined, fakeApi({ createJob: vi.fn(async () => Promise.reject(refusal)) }));
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(document.activeElement).toBe($("last-start"));
    expect($("last-start").getAttribute("aria-invalid")).toBe("true");
    expect($("first-start").hasAttribute("aria-invalid")).toBe(false);
    expect($("last-start-error").textContent).toBe("Must be after the first.");
    expect($("form-error").textContent).toBe("Fix the times.");
    expect($("listen-empty").hidden).toBe(false);
    expect(storage.data[`job:${TAB}`]).toBeUndefined();
  });

  it("a refused speed focuses the chosen speed; a refusal without a field keeps focus on Generate", async () => {
    const speed = new MyDubbError(422, "validation_error", "Check the speed.", [{ field: "speed", message: "Not offered." }]);
    const busy = new MyDubbError(503, "server_at_capacity", "Busy.");
    await started(undefined, fakeApi({ createJob: vi.fn().mockRejectedValueOnce(speed).mockRejectedValueOnce(busy) }));
    choose("speed", "0.75");
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(document.activeElement).toBe($("speed").querySelector("input[value='0.75']"));
    expect($("speed").getAttribute("aria-invalid")).toBe("true");
    (document.activeElement as HTMLElement).blur();
    $<HTMLButtonElement>("generate").click();
    await settle();
    expect(document.activeElement).toBe($("generate"));
    expect($("form-error").textContent).not.toBe("");
  });

  it("a job that completes while the user edits the form leaves the focus and the edit alone", async () => {
    let finish!: (value: unknown) => void;
    const { api } = await started(undefined, fakeApi({ getJob: vi.fn(() => new Promise((resolve) => (finish = resolve))) }));
    $<HTMLButtonElement>("generate").click();
    await settle(6);
    $<HTMLInputElement>("first-start").focus();
    typeTime("first-start", "000005");
    finish(job("completed"));
    await settle(12);
    expect(api.getResult).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe($("first-start"));
    expect($<HTMLInputElement>("first-start").value).toBe("00:00:05");
    expect(player.opened).toHaveLength(1);
    expect(player.commands).toEqual([]);
  });

  it("editing the form and scrolling while the audio plays with Sync on sends nothing to the player or MyDubb", async () => {
    const { api } = await started();
    typeTime("first-start", "000010");
    typeTime("last-start", "000610");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    player.set({ ...player.view!, paused: false, currentTime: 42, sync: SYNC_ON });
    const requests = () => Object.values(api).reduce((n, fn) => n + fn.mock.calls.length, 0);
    const before = requests();
    typeTime("last-start", "000700");
    choose("speed", "2");
    choose("voice", "EmmaMultilingual");
    window.dispatchEvent(new Event("scroll"));
    await settle();
    expect(requests()).toBe(before);
    expect(player.ended).toEqual([]);
    expect(player.commands).toEqual([]);
    expect(player.syncs).toEqual([]);
    expect(player.view).toMatchObject({ paused: false, currentTime: 42 });
    expect(playerTime()).toBe("0:42 / 3:00");
    expect($("sync-toggle").getAttribute("aria-pressed")).toBe("true");
    // What the loaded audio was made with does not follow the form.
    expect($("player-info").textContent).toContain("1x");
  });

  it("the translation is shown before Play, in its language and direction, as text", async () => {
    await started();
    choose("target-language", "arabic");
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    const translation = $("translation");
    expect(translation.closest("details")).toBeNull();
    expect(translation.compareDocumentPosition($("player-play")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect($("translation-heading").textContent).toBe("Translation · Arabic");
    expect(translation.textContent).toBe("<b>نص</b>");
    expect(translation.children).toHaveLength(0);
    expect(translation.dir).toBe("rtl");
    expect(translation.lang).toBe("ar");
  });

  it("a reopened panel with a followed job restores it without sending anything", async () => {
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
    const { api } = await started(fakeStorage({ [AUTH_KEY]: AUTH, [`job:${TAB}`]: record }));
    await settle(10);
    expect($("listen-empty").hidden).toBe(true);
    expect($("result-section").hidden).toBe(false);
    expect(api.createJob).not.toHaveBeenCalled();
  });

  it("changing the account empties Your audio and says why there", async () => {
    const { dubbing } = await started();
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    dubbing.onStorageChanged({ [AUTH_KEY]: { newValue: OTHER } });
    expect($("listen-empty").hidden).toBe(false);
    expect($("listen-notice").textContent).toMatch(/account changed/);
    expect(player.view).toBeNull();
  });

  it("keeps the header short: the account name, with the email and Disconnect under Details", async () => {
    await started();
    expect($("account-status").textContent).toBe("Connected as Lan");
    expect($("account-detail").textContent).toBe("Lan (lan@example.com)");
    expect($("header-details").contains($("disconnect"))).toBe(true);
    expect($<HTMLButtonElement>("disconnect").hidden).toBe(false);
    expect($("generate-hint").textContent).toBe("Your text is sent to MyDubb only when you choose Generate audio.");
  });
});

describe("the stored translation of the loaded audio (loaded:<tab>)", () => {
  const LOADED = `loaded:${TAB}`;
  const text = (id: string) => $(id).textContent;
  const refusal = () => new MyDubbError(422, "validation_error", "Fix the times.", [{ field: "last_sentence_start", message: "Must be after the first." }]);
  const resultFor = (id: string) => ({
    ...RESULT,
    job_id: id,
    audio: { ...RESULT.audio, url: `/api/jobs/${id}/result/audio` },
    translation: { ...RESULT.translation, text: `Bản dịch ${id}` },
  });
  /** Job A is made; the second Generate is refused (no job B, so the tab's job record is gone). */
  const refusedAfterA = () =>
    fakeApi({
      createJob: vi.fn().mockResolvedValueOnce({ id: "job-A", status: "queued" }).mockRejectedValue(refusal()),
      getJob: vi.fn(async (_token: string, id: string) => ({ id, status: "completed" })),
      getResult: vi.fn(async (_token: string, id: string) => resultFor(id)),
    });
  /** Job A, then job B for whoever is connected next. */
  const aThenB = () =>
    fakeApi({
      createJob: vi
        .fn()
        .mockResolvedValueOnce({ id: "job-A", status: "queued" })
        .mockResolvedValueOnce({ id: "job-B", status: "queued" }),
      getJob: vi.fn(async (_token: string, id: string) => ({ id, status: "completed" })),
      getResult: vi.fn(async (_token: string, id: string) => resultFor(id)),
    });

  async function aLoadedThenBRefused() {
    const storage = fakeStorage({ [AUTH_KEY]: AUTH });
    const made = await started(storage, refusedAfterA());
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect(player.view?.owner.jobId).toBe("job-A");
    expect(storage.data[LOADED]).toMatchObject({ jobId: "job-A", text: "Bản dịch job-A" });
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect(made.api.createJob).toHaveBeenCalledTimes(2);
    expect(storage.data[`job:${TAB}`]).toBeUndefined(); // the refusal left no job record
    return { ...made, storage };
  }

  it("a refused new Generate keeps the earlier audio and its translation, playing and stored", async () => {
    const { storage } = await aLoadedThenBRefused();
    expect(player.view?.owner.jobId).toBe("job-A");
    expect(player.ended).toEqual([]);
    expect(text("translation")).toBe("Bản dịch job-A");
    expect(storage.data[LOADED]).toMatchObject({ jobId: "job-A", text: "Bản dịch job-A" });
  });

  it("a failed new job keeps the earlier translation stored as well", async () => {
    const failed = { id: "job-B", status: "failed", error: { code: "speech_quota_exceeded", message: "The speech quota is used up." } };
    const api = aThenB();
    api.getJob.mockImplementation(async (_token: string, id: string) => (id === "job-B" ? failed : { id, status: "completed" }));
    const storage = fakeStorage({ [AUTH_KEY]: AUTH });
    await started(storage, api);
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    $<HTMLButtonElement>("generate").click();
    await settle(12);
    expect(text("job-error")).toMatch(/speech quota is used up/);
    expect(player.view?.owner.jobId).toBe("job-A");
    expect(storage.data[LOADED]).toMatchObject({ jobId: "job-A" });
  });

  it("is removed on Disconnect, also when the refused Generate left no job record", async () => {
    const { dubbing, storage } = await aLoadedThenBRefused();
    dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH } });
    await settle();
    expect(storage.data[LOADED]).toBeUndefined();
  });

  it("is removed when the token is no longer accepted (the stored connection goes), with no job record", async () => {
    const { dubbing, storage } = await aLoadedThenBRefused();
    delete storage.data[AUTH_KEY];
    dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH } });
    await settle();
    expect(storage.data[LOADED]).toBeUndefined();
  });

  it("is removed when another account connects, with no job record", async () => {
    const { dubbing, storage } = await aLoadedThenBRefused();
    dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH, newValue: OTHER } });
    await settle();
    expect(storage.data[LOADED]).toBeUndefined();
  });

  it("is removed when the tab moves to another lecture, with no job record", async () => {
    const { dubbing, storage } = await aLoadedThenBRefused();
    lesson = "demo-course/2";
    dubbing.lessonState("demo-course/2");
    await settle();
    expect(storage.data[LOADED]).toBeUndefined();
  });

  it("is removed when the tab leaves the lecture pages", async () => {
    const { dubbing, storage } = await aLoadedThenBRefused();
    lesson = null;
    dubbing.lessonState(null);
    await settle();
    expect(storage.data[LOADED]).toBeUndefined();
  });

  it("a page reload (the player session gone) on the same lecture and connection keeps it", async () => {
    const { dubbing, storage } = await aLoadedThenBRefused();
    player.set(null);
    dubbing.lessonState(LESSON);
    await settle();
    expect(storage.data[LOADED]).toMatchObject({ jobId: "job-A" });
  });

  describe("a write that is still pending when the identity or the lecture changes", () => {
    /** The first write of A's translation waits until released; everything else goes through. */
    function holdA() {
      const storage = fakeStorage({ [AUTH_KEY]: AUTH });
      const held = deferred();
      const set = storage.set;
      storage.set = vi.fn(async (items: Record<string, unknown>) => {
        const value = items[LOADED] as { jobId?: string } | undefined;
        if (value?.jobId === "job-A") await held.promise;
        return set(items);
      });
      return { storage, release: held.resolve };
    }

    it("the lecture changes: A's late write does not bring the translation back", async () => {
      const { storage, release } = holdA();
      const { dubbing } = await started(storage, aThenB());
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(storage.set).toHaveBeenCalledWith(expect.objectContaining({ [LOADED]: expect.objectContaining({ jobId: "job-A" }) }));
      lesson = "demo-course/2";
      dubbing.lessonState("demo-course/2");
      await settle();
      release();
      await settle(10);
      expect(storage.data[LOADED]).toBeUndefined();
    });

    it("the account changes: A's late write does not bring the translation back", async () => {
      const { storage, release } = holdA();
      const { dubbing } = await started(storage, aThenB());
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH } });
      await settle();
      release();
      await settle(10);
      expect(storage.data[LOADED]).toBeUndefined();
    });

    it("another account loads B meanwhile: A's late write does not overwrite B's translation", async () => {
      const { storage, release } = holdA();
      const { dubbing } = await started(storage, aThenB());
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      dubbing.onStorageChanged({ [AUTH_KEY]: { oldValue: AUTH, newValue: OTHER } });
      $<HTMLButtonElement>("generate").click();
      await settle(12);
      expect(player.view?.owner.jobId).toBe("job-B");
      release();
      await settle(10);
      expect(storage.data[LOADED]).toMatchObject({ jobId: "job-B", text: "Bản dịch job-B", userId: "u2", connectionId: "conn-b", lessonKey: LESSON });
    });
  });

  describe("when the panel is reopened", () => {
    const stored = (over: Record<string, unknown> = {}) => ({
      jobId: "job-A",
      text: "Bản dịch job-A",
      tag: "vi",
      dir: "ltr",
      userId: "u1",
      connectionId: "conn-a",
      lessonKey: LESSON,
      ...over,
    });

    it("keeps it for the same account, connection and lecture", async () => {
      const storage = fakeStorage({ [AUTH_KEY]: AUTH, [LOADED]: stored() });
      await started(storage);
      await settle();
      expect(storage.data[LOADED]).toMatchObject({ jobId: "job-A" });
    });

    it.each([
      ["another account", { userId: "u9" }],
      ["another connection", { connectionId: "conn-old" }],
      ["another lecture", { lessonKey: "demo-course/9" }],
      ["a copy without its owner (older shape)", { userId: undefined, connectionId: undefined, lessonKey: undefined }],
    ])("removes it for %s", async (_name, over) => {
      const storage = fakeStorage({ [AUTH_KEY]: AUTH, [LOADED]: stored(over) });
      await started(storage);
      await settle();
      expect(storage.data[LOADED]).toBeUndefined();
    });

    it("removes it when no account is connected", async () => {
      const storage = fakeStorage({ [LOADED]: stored() });
      await started(storage);
      await settle();
      expect(storage.data[LOADED]).toBeUndefined();
    });
  });
});
