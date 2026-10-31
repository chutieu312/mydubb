// Shared harness of the browser tests: the real extension build (dist-test/) in Playwright's
// Chromium, synthetic Udemy fixture pages and a fake MyDubb server, all served by request routing.
// Nothing leaves the machine: udemy.com and mydubb.com are never contacted (the test build talks to
// https://mydubb.test, see build.mjs). These tests prove local behaviour only.

import { test as base, chromium, expect, type BrowserContext, type Page, type Route, type Worker } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "dist-test");
const fixtureHtml = readFileSync(join(here, "fixtures", "lecture.html"), "utf8");
const fixtureJs = readFileSync(join(here, "fixtures", "fixture.js"), "utf8");
// A real MP3: the backend's 3 s mock-provider fixture (CBR, no header frame) ten times over, so
// the player really decodes a 30 s MP3 and seeking has room.
const fixtureMp3 = Buffer.concat(
  Array.from({ length: 10 }, () => readFileSync(join(here, "..", "..", "backend", "app", "audio", "fixtures", "mock_audio.mp3"))),
);
export const ORIGIN = "https://www.udemy.com";
export const MYDUBB = "https://mydubb.test";
export const lectureUrl = (id: number, query = "") => `${ORIGIN}/course/demo-course/learn/lecture/${id}${query}`;

export const META = {
  provider_mode: "mock",
  mock_mode: true,
  providers: { translation: "mock", speech: "mock", audio: "mock" },
  voices: [
    { id: "AndrewMultilingual", label: "Andrew Multilingual", provider_voice: "en-US-AndrewMultilingualNeural", description: "" },
    { id: "EmmaMultilingual", label: "Emma Multilingual", provider_voice: "en-US-EmmaMultilingualNeural", description: "" },
  ],
  target_languages: [
    { id: "vietnamese", label: "Vietnamese", noun: "Vietnamese", translator_language: "vi", speech_locale: "vi-VN", text_direction: "ltr" },
    { id: "arabic", label: "Arabic", noun: "Arabic", translator_language: "ar", speech_locale: "ar-SA", text_direction: "rtl" },
  ],
  default_target_language: "vietnamese",
  timestamp_format: "HH:MM:SS",
  result_ttl_seconds: 3600,
  auth: { mode: "cognito", self_registration: false, password_reset: true },
};

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeJob {
  id: string;
  body: Record<string, unknown>;
  status: string;
  owner: string;
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const apiError = (route: Route, status: number, code: string, message: string) =>
  json(route, status, { error: { code, message } });
const hms = (value: unknown) => {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(value));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};
/** The first and last caption start of a timed transcript (M:SS or M:SS.mmm lines), as the server reads them. */
function captionSpan(transcript: unknown): [number, number] {
  const starts = String(transcript)
    .split("\n")
    .map((line) => /^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]) * 60 + Number(m[2]) + Number((m[3] ?? "0").padEnd(3, "0")) / 1000);
  return [starts[0] ?? 0, starts.at(-1) ?? 0];
}

/**
 * A fake of the MyDubb API endpoints the extension uses, with the contract's shapes. It checks the
 * PKCE verifier against the challenge the authorize step saw, and the bearer token on every call.
 */
export class FakeMyDubb {
  readonly requests: RecordedRequest[] = [];
  readonly jobs = new Map<string, FakeJob>();
  readonly tokens = new Map<string, string>(); // token -> user id
  private readonly codes = new Map<string, { challenge: string; clientId: string; redirect: string; user: string }>();
  user = { id: "u1", email: "lan@example.com", display_name: "Lan" };
  /** Answers for POST /api/jobs, consumed in order: "ok" (default), "drop" (no answer) or a status. */
  createAnswers: ("ok" | "drop" | number)[] = [];
  /** Statuses a job goes through, one per GET, before staying at the last one. */
  progression = ["queued", "processing", "completed"];
  /** When false, jobs stay at their current status (the test moves them on). */
  advance = true;
  /** Answers for the MP3 download, consumed in order: "ok" (default) or an HTTP status. */
  audioAnswers: ("ok" | number)[] = [];
  private nextJob = 1;

  /** Stands in for the website: the signed-in user approves the extension. */
  authorize(url: string, extensionId: string): string {
    const params = new URL(url).searchParams;
    const redirect = params.get("redirect_uri") ?? "";
    if (params.get("client_id") !== extensionId || redirect !== `https://${extensionId}.chromiumapp.org/`) {
      throw new Error("unexpected client or redirect");
    }
    if (params.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, { challenge: params.get("code_challenge") ?? "", clientId: extensionId, redirect, user: this.user.id });
    return `${redirect}?code=${code}&state=${params.get("state")}`;
  }

  complete(jobId: string, status = "completed"): void {
    const job = this.jobs.get(jobId);
    if (job) job.status = status;
  }

  revokeAll(): void {
    this.tokens.clear();
  }

  posts(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === path);
  }

  gets(prefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "GET" && r.path.startsWith(prefix));
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const raw = request.postData();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    this.requests.push({ method: request.method(), path: url.pathname, headers, body });
    const path = url.pathname;

    if (path === "/api/meta") return json(route, 200, META);
    if (path === "/api/extension/token" && request.method() === "POST") {
      const code = this.codes.get(String(body?.code));
      this.codes.delete(String(body?.code));
      const verifier = String(body?.code_verifier ?? "");
      if (!code || code.clientId !== body?.client_id || code.redirect !== body?.redirect_uri || s256(verifier) !== code.challenge) {
        return apiError(route, 400, "invalid_grant", "This connection attempt expired or was already used.");
      }
      const token = randomBytes(32).toString("base64url");
      this.tokens.set(token, code.user);
      return json(route, 200, { access_token: token, token_type: "Bearer", expires_at: "2099-01-01T00:00:00Z", user: this.user });
    }

    const auth = headers.authorization ?? "";
    const owner = auth.startsWith("Bearer ") ? this.tokens.get(auth.slice(7)) : undefined;
    if (!owner) return apiError(route, 401, "not_authenticated", "A valid session is required.");

    if (path === "/api/extension/session") return json(route, 200, { user: this.user, expires_at: "2099-01-01T00:00:00Z" });
    if (path === "/api/extension/logout") {
      this.tokens.delete(auth.slice(7));
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/jobs" && request.method() === "POST") {
      const answer = this.createAnswers.shift() ?? "ok";
      if (answer === "drop") return route.abort("connectionreset");
      if (typeof answer === "number") return apiError(route, answer, "server_at_capacity", "Busy.");
      const id = `job-${this.nextJob++}`;
      this.jobs.set(id, { id, body: body ?? {}, status: "queued", owner });
      return json(route, 202, this.jobJson(id));
    }
    const match = /^\/api\/jobs\/([\w-]+)(\/result(\/audio)?)?$/.exec(path);
    const job = match ? this.jobs.get(match[1]!) : undefined;
    if (!match || !job || job.owner !== owner) return apiError(route, 404, "job_not_found", "Job not found.");
    if (match[3]) {
      const answer = this.audioAnswers.shift() ?? "ok";
      if (answer === 410) return apiError(route, 410, "result_expired", "This result has expired. Generate it again.");
      if (typeof answer === "number") return apiError(route, answer, "server_error", "Failed.");
      return route.fulfill({ status: 200, contentType: "audio/mpeg", body: fixtureMp3 });
    }
    if (match[2]) {
      // Like the server: the baseline of the two start times; a timed job also reports the caption span.
      const baseline = hms(job.body.last_sentence_start) - hms(job.body.first_sentence_start);
      const [first, last] = captionSpan(job.body.transcript);
      const timing =
        job.body.timing_mode === "timed"
          ? {
              mode: "timed",
              captions: 2,
              blocks: 1,
              source_first_seconds: first,
              source_last_seconds: last,
              source_baseline_seconds: last - first,
              selected_baseline_seconds: baseline,
              speech_requests: 1,
              frames: null,
              removed_boundaries: null,
              tempo_warning_level: null,
              max_tempo_factor: null,
              frames_over_warning_level: null,
              estimated_max_displacement_seconds: null,
              frame_details: null,
            }
          : null;
      return json(route, 200, {
        job_id: job.id,
        target_language: job.body.target_language ?? "vietnamese",
        target_language_label: job.body.target_language === "arabic" ? "Arabic" : "Vietnamese",
        baseline_duration_seconds: baseline,
        speed: job.body.speed,
        output_duration_seconds: baseline / Number(job.body.speed),
        timing,
        translation: { text: `Bản dịch <b>${job.id}</b>`, is_illustrative: true, provider: "mock" },
        audio: {
          url: `/api/jobs/${job.id}/result/audio`,
          download_url: `/api/jobs/${job.id}/result/audio?download=1`,
          content_type: "audio/mpeg",
          provider: "mock-speech",
          is_fixture: true,
          duration_adjusted: false,
          duration: null,
        },
        expires_at: "2099-01-01T01:00:00Z",
        notices: ["The audio is a fixed development fixture."],
      });
    }
    if (this.advance) {
      const index = this.progression.indexOf(job.status);
      job.status = this.progression[Math.min(index + 1, this.progression.length - 1)] ?? job.status;
    }
    return json(route, 200, this.jobJson(job.id));
  }

  private jobJson(id: string) {
    const job = this.jobs.get(id)!;
    return { id, status: job.status, voice: job.body.voice, speed: job.body.speed, error: null };
  }
}

type Fixtures = { context: BrowserContext; worker: Worker; extensionId: string; mydubb: FakeMyDubb };

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  mydubb: async ({}, use) => {
    await use(new FakeMyDubb());
  },
  context: async ({ mydubb }, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        // Fixture audio plays without a page gesture; the play() rejection path is unit-tested.
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    // Nothing leaves the machine: Udemy URLs get fixtures, MyDubb gets the fake, everything else
    // is refused.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      // The extension's own pages and scripts.
      if (url.protocol === "chrome-extension:" || url.protocol === "blob:") return route.continue();
      if (url.origin === MYDUBB) return mydubb.handle(route);
      if (url.origin === ORIGIN && url.pathname === "/__fixture/fixture.js") {
        return route.fulfill({ contentType: "text/javascript", body: fixtureJs });
      }
      const lecture = /^\/course\/demo-course\/learn\/lecture\/(\d+)$/.exec(url.pathname);
      if (url.origin === ORIGIN && lecture) {
        return route.fulfill({ contentType: "text/html", body: fixtureHtml.replace("__LECTURE__", lecture[1]!) });
      }
      // A Udemy page that is not a lecture (course overview).
      if (url.origin === ORIGIN && /^\/course\/demo-course\/?$/.test(url.pathname)) {
        return route.fulfill({ contentType: "text/html", body: fixtureHtml.replace("Lecture __LECTURE__", "Course overview") });
      }
      if (url.origin === "https://example.test") {
        return route.fulfill({ contentType: "text/html", body: "<title>Other site</title><video></video>" });
      }
      return route.abort();
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
});

export { expect };

/** The tab id whose content script reports this lecture (tabs.query cannot see URLs without the "tabs" permission). */
export async function tabIdFor(worker: Worker, lessonKey: string): Promise<number> {
  const id = await worker.evaluate(async (key) => {
    for (const tab of await chrome.tabs.query({})) {
      try {
        const reply = await chrome.tabs.sendMessage(tab.id!, { type: "mydubb:get-selection" }, { frameId: 0 });
        if (reply?.lesson?.key === key) return tab.id!;
      } catch {
        // not a tab with the content script
      }
    }
    return null;
  }, lessonKey);
  if (id === null) throw new Error(`no tab for ${lessonKey}`);
  return id;
}

export async function openLecture(context: BrowserContext, worker: Worker, id: number, query = "") {
  const page = await context.newPage();
  await page.goto(lectureUrl(id, query));
  await expect.poll(() => page.evaluate(() => document.querySelector("video")?.readyState ?? 0)).toBeGreaterThan(0);
  let tabId = -1;
  await expect.poll(async () => (tabId = await tabIdFor(worker, `demo-course/${id}`).catch(() => -1))).toBeGreaterThan(-1);
  return { page, tabId };
}

export async function openPanel(context: BrowserContext, extensionId: string, tabId: number): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
  return panel;
}

/** Selects the fixture transcript in the page, then runs the real "Send to MyDubb" handler. */
export async function sendTranscriptSelection(page: Page, worker: Worker, tabId: number) {
  const expected = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("transcript")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  await worker.evaluate(
    ([tab, url]) =>
      (globalThis as unknown as { mydubbE2E: { sendSelection(t: number, s: string, u: string): Promise<unknown> } }).mydubbE2E.sendSelection(
        tab,
        "chrome collapsed text",
        url,
      ),
    [tabId, page.url()] as const,
  );
  return expected;
}

export interface PlayingSession {
  tabId: number;
  paused: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  blobSrc: boolean;
  floating: boolean;
  lessonKey: string;
  audioElements: number;
  sync: { status: string; notice: string | null; start: number | null; end: number | null; duration: number | null; rate: number | null };
  /** Drift the coordinator measured (MP3 seconds) and the corrections it made. */
  drift: { samples: number; corrections: number; maxAbsDrift: number; lastDrift: number | null };
}

/**
 * The offscreen document's sessions, read from its real media elements (test build only), asked
 * from the service worker or from an extension page (e.g. the panel, once the worker is stopped).
 */
export async function playerSessions(from: Worker | Page): Promise<PlayingSession[]> {
  return (from as Worker).evaluate(async () => {
    if (!(await chrome.offscreen.hasDocument())) return [];
    try {
      return ((await chrome.runtime.sendMessage({ type: "mydubbE2E:inspect" })) ?? []) as PlayingSession[];
    } catch {
      return [];
    }
  });
}

export const hasPlayerDocument = (worker: Worker) => worker.evaluate(() => chrome.offscreen.hasDocument());

export const sessionGet = (worker: Worker, key: string) =>
  worker.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, key);

/**
 * Lets the panel's Connect button run without Chrome's sign-in window (which Playwright cannot
 * drive): the panel's test-build hook hands the authorize URL to the fake, which plays the
 * website's part (sign-in and approval) and answers with the redirect Chrome would capture.
 */
const approving = new WeakSet<Page>();

export async function allowConnect(panel: Page, mydubb: FakeMyDubb, extensionId: string): Promise<void> {
  if (approving.has(panel)) return;
  approving.add(panel);
  await panel.exposeFunction("mydubbE2EApprove", (url: string) => mydubb.authorize(url, extensionId));
  await panel.evaluate(() => {
    (globalThis as unknown as { mydubbE2EAuthFlow: (url: string) => Promise<string> }).mydubbE2EAuthFlow = (url) =>
      (globalThis as unknown as { mydubbE2EApprove: (url: string) => Promise<string> }).mydubbE2EApprove(url);
  });
}

export async function connectAccount(panel: Page, mydubb: FakeMyDubb, extensionId: string) {
  await allowConnect(panel, mydubb, extensionId);
  await panel.getByRole("button", { name: "Connect MyDubb" }).click();
  await expect(panel.getByText("Connected as Lan (lan@example.com).")).toBeVisible();
}

export async function fillTimes(panel: Page) {
  await panel.getByLabel("First Sentence Start Time").fill("000010");
  await panel.getByLabel("Last Sentence Start Time").fill("000610");
}
