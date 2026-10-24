import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { THEME_STORAGE_KEY } from "./lib/theme";

const META = {
  provider_mode: "azure",
  mock_mode: false,
  providers: { translation: "azure", speech: "azure", audio: "ffmpeg" },
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
  auth: { mode: "access_code", self_registration: false, password_reset: false },
};
const SESSION = { authenticated: true, csrf_token: "csrf-1", expires_at: "2030-01-01T00:00:00Z" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

/** The job as the server stores it: its own voice and speed, whatever the form shows later. */
function storedJob(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status,
    voice: "EmmaMultilingual",
    first_sentence_start: "00:00:05",
    last_sentence_start: "00:00:25",
    target_duration_seconds: 20,
    target_duration: "00:00:20",
    baseline_duration_seconds: 20,
    speed: 1.5,
    output_duration_seconds: 20 / 1.5,
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    completed_at: null,
    result_expires_at: null,
    error: null,
    ...extra,
  };
}

const target = 20 / 1.5;
const RESULT = {
  job_id: "job-1",
  baseline_duration_seconds: 20,
  speed: 1.5,
  output_duration_seconds: target,
  translation: { text: "Xin chào", is_illustrative: false, provider: "azure-translator" },
  audio: {
    url: "/api/jobs/job-1/result/audio",
    download_url: "/api/jobs/job-1/result/audio?download=1",
    content_type: "audio/mpeg",
    provider: "azure-speech",
    is_fixture: false,
    duration_adjusted: true,
    duration: {
      sample_rate: 24000,
      target_seconds: target,
      target_samples: 320000,
      baseline_seconds: 20,
      speed: 1.5,
      source_seconds: 15,
      source_samples: 360000,
      processed_seconds: target,
      processed_samples: 320000,
      mp3_decoded_seconds: target,
      mp3_decoded_samples: 320000,
      mp3_header_seconds: target,
      mp3_header_samples: 320000,
      mp3_container_seconds: target,
      tempo_factor: 1.125,
      padded_samples: 0,
      trimmed_samples: 0,
      mp3_padding_adjusted_samples: 0,
    },
  },
  expires_at: "2030-01-01T01:00:00Z",
  notices: [],
};

let authenticated: boolean;
let created: Record<string, unknown>[];
let jobResponse: () => Response;
let resultResponse: () => Response;

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  authenticated = true;
  created = [];
  jobResponse = () => json(storedJob("queued"));
  resultResponse = () => json(RESULT);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url === "/api/meta") return json(META);
      if (url === "/api/session" && method === "GET") {
        return authenticated ? json(SESSION) : apiError(401, "not_authenticated", "Sign in.");
      }
      if (url === "/api/session" && method === "POST") {
        authenticated = true;
        return json(SESSION);
      }
      if (url === "/api/jobs" && method === "POST") {
        created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jobResponse();
      }
      if (url === "/api/jobs/job-1") return jobResponse();
      if (url === "/api/jobs/job-1/result") return resultResponse();
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const themeButton = () => screen.getByRole("button", { name: /Switch to (dark|light) mode/ });
const theme = () => document.documentElement.dataset.theme;

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("English Transcript"), "Spring Boot uses JSON.");
  await user.type(screen.getByLabelText("First Sentence Start Time"), "00:00:05");
  await user.type(screen.getByLabelText("Last Sentence Start Time"), "00:00:25");
  await user.click(screen.getByLabelText(/Emma Multilingual/));
  await user.click(screen.getByLabelText("1.5x"));
  await user.click(screen.getByRole("button", { name: "Generate audio" }));
}

describe("appearance", () => {
  it("starts in light mode, also when the OS prefers dark", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("dark"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    render(<App />);
    await screen.findByLabelText("English Transcript");

    expect(theme()).toBe("light");
    expect(themeButton().getAttribute("aria-label")).toBe("Switch to dark mode");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("toggles, saves the choice and restores it on the next visit", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");

    await user.click(themeButton());
    expect(theme()).toBe("dark");
    expect(themeButton().getAttribute("aria-label")).toBe("Switch to light mode");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    cleanup(); // a new visit
    delete document.documentElement.dataset.theme;
    render(<App />);
    await screen.findByLabelText("English Transcript");
    expect(theme()).toBe("dark");

    await userEvent.click(themeButton());
    expect(theme()).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("ignores an unknown saved value", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    render(<App />);
    await screen.findByLabelText("English Transcript");
    expect(theme()).toBe("light");
  });

  it("is available on the Access Code screen too", async () => {
    authenticated = false;
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("Access Code");
    await user.click(themeButton());
    expect(theme()).toBe("dark");
  });

  it("still works when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");

    expect(theme()).toBe("light");
    await user.click(themeButton());
    expect(theme()).toBe("dark");
  });

  it("keeps the form and the running job when only the theme changes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);
    await screen.findByText(/Planned audio length/);

    await user.click(themeButton());
    await user.click(themeButton());
    await user.click(themeButton());

    expect(theme()).toBe("dark");
    expect((screen.getByLabelText("English Transcript") as HTMLTextAreaElement).value).toBe(
      "Spring Boot uses JSON.",
    );
    expect((screen.getByLabelText("First Sentence Start Time") as HTMLInputElement).value).toBe(
      "00:00:05",
    );
    expect((screen.getByLabelText(/Emma Multilingual/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("1.5x") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Planned audio length/)).toBeTruthy();
    expect(created).toHaveLength(1); // no second job was started
  });

  it("writes nothing but the theme to localStorage", async () => {
    authenticated = false;
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText("Access Code"), "a-secret-access-code");
    await user.click(screen.getByRole("button", { name: "Enter" }));
    await screen.findByLabelText("English Transcript");
    await user.click(themeButton());

    const stored = Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_, i) => {
        const key = window.localStorage.key(i)!;
        return [key, window.localStorage.getItem(key)];
      }),
    );
    expect(stored).toEqual({ [THEME_STORAGE_KEY]: "dark" });
  });
});

describe("Access Code screen", () => {
  it("offers only the Access Code: no email, password, sign-up or reset", async () => {
    authenticated = false;
    render(<App />);
    const code = await screen.findByLabelText("Access Code");

    expect(code.getAttribute("type")).toBe("password");
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(screen.queryByLabelText(/^password/i)).toBeNull();
    expect(screen.queryByText(/sign up|forgot|activate|invite|register/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /log out/i })).toBeNull();
  });

  it("shows the Access Code screen again, with a notice, when a request finds the session gone", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    jobResponse = () => apiError(401, "not_authenticated", "A valid session is required.");
    await user.type(screen.getByLabelText("English Transcript"), "Hello.");
    await user.click(screen.getByRole("button", { name: "Generate audio" }));

    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("session has expired or ended");
    expect(screen.queryByLabelText("English Transcript")).toBeNull();
  });
});

describe("job and result states", () => {
  it("shows the real stage while processing, never a percentage", async () => {
    jobResponse = () => json(storedJob("synthesizing"));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);

    const panel = (await screen.findByText("Creating your audio…")).closest("section")!;
    const stages = within(panel).getByRole("list", { name: "Progress" });
    const active = stages.querySelector(".stage.active");
    expect(active?.textContent).toBe("Generating voice");
    expect(active?.getAttribute("aria-current")).toBe("step");
    expect(stages.querySelectorAll(".stage.done")).toHaveLength(2);
    expect(panel.textContent).not.toMatch(/\d\s*%/);
    expect(within(panel).queryByRole("progressbar")).toBeNull();
  });

  it("shows the voice and speed the job was created with, not the form's current choice", async () => {
    jobResponse = () => json(storedJob("completed"));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user); // Emma, 1.5x

    await screen.findByText("Audio ready");
    // Now change the form; the result must keep describing the job.
    await user.click(screen.getByLabelText(/Andrew Multilingual/));
    await user.click(screen.getByLabelText("0.5x"));

    const facts = document.querySelector(".facts")?.textContent ?? "";
    expect(facts).toContain("VoiceEmma Multilingual");
    expect(facts).toContain("Speed1.5x");
    expect(facts).toContain("Target length00:00:13.33");
    expect(created[0]).toMatchObject({ voice: "EmmaMultilingual", speed: 1.5 });
  });

  it("explains a failed job with the server's message and loads no result", async () => {
    jobResponse = () =>
      json(
        storedJob("failed", {
          error: { code: "translation_failed", message: "The translation service is unavailable." },
        }),
      );
    resultResponse = () => {
      throw new Error("a failed job has no result to fetch");
    };
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);

    expect(await screen.findByText("Audio could not be created")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "The translation service is unavailable.",
    );
    expect(document.querySelector(".stage.failed")?.textContent).toBe("Failed");
    expect(document.querySelector("audio")).toBeNull();
    expect(screen.queryByRole("link", { name: "Download MP3" })).toBeNull();
  });

  it("reports an expired result and removes the player and download", async () => {
    jobResponse = () => json(storedJob("completed"));
    resultResponse = () => apiError(410, "result_expired", "The result is no longer available.");
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);

    const notice = await screen.findByText("Result expired.");
    expect(notice.parentElement?.textContent).toContain("The result is no longer available.");
    expect(notice.parentElement?.textContent).toContain("generate the audio again");
    expect(document.querySelector("audio")).toBeNull();
    expect(screen.queryByRole("link", { name: "Download MP3" })).toBeNull();
  });

  it("returns to the Access Code screen when the session ends while polling", async () => {
    // The create call itself succeeds; only the later status check is rejected.
    let first = true;
    jobResponse = () => {
      if (first) {
        first = false;
        return json(storedJob("queued"));
      }
      return apiError(401, "not_authenticated", "A valid session is required.");
    };
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);

    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
    expect(screen.queryByText("Creating your audio…")).toBeNull();
  });

  it("returns to the Access Code screen when the session ends while loading the result", async () => {
    jobResponse = () => json(storedJob("completed"));
    resultResponse = () => apiError(401, "not_authenticated", "A valid session is required.");
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);

    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("session has expired or ended");
  });
});
