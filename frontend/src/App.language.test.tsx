import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { TargetLanguageOption } from "./api/types";
import { DubbingForm } from "./features/dubbing/DubbingForm";
import type { StudioDraft } from "./lib/studioDraft";

const LANGUAGES: TargetLanguageOption[] = [
  {
    id: "vietnamese",
    label: "Vietnamese",
    noun: "Vietnamese",
    translator_language: "vi",
    speech_locale: "vi-VN",
  },
  {
    id: "mandarin_simplified",
    label: "Chinese — Mandarin (Simplified)",
    noun: "Mandarin Chinese",
    translator_language: "zh-Hans",
    speech_locale: "zh-CN",
  },
];
const VOICES = [
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
];
const META = {
  provider_mode: "azure",
  mock_mode: false,
  providers: { translation: "azure", speech: "azure", audio: "ffmpeg" },
  voices: VOICES,
  target_languages: LANGUAGES,
  default_target_language: "vietnamese",
  timestamp_format: "HH:MM:SS",
  result_ttl_seconds: 3600,
  auth: { mode: "access_code", self_registration: false, password_reset: false },
};
const SESSION = { authenticated: true, csrf_token: "csrf-1", expires_at: "2030-01-01T00:00:00Z" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** What the server stores for a job: its own snapshot of the request (or an older job). */
function jobFor(body: Record<string, unknown>, status = "completed") {
  const language = LANGUAGES.find((l) => l.id === body.target_language);
  return {
    id: "job-1",
    status,
    voice: body.voice,
    ...(language ? { target_language: language.id, target_language_label: language.label } : {}),
    first_sentence_start: "00:00:10",
    last_sentence_start: "00:06:10",
    target_duration_seconds: 360,
    target_duration: "00:06:00",
    baseline_duration_seconds: 360,
    speed: 1,
    output_duration_seconds: 360,
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    completed_at: "2030-01-01T00:01:00Z",
    result_expires_at: "2030-01-01T01:01:00Z",
    error: null,
  };
}

function resultFor(body: Record<string, unknown>) {
  const mandarin = body.target_language === "mandarin_simplified";
  return {
    job_id: "job-1",
    ...(body.target_language ? { target_language: body.target_language } : {}),
    baseline_duration_seconds: 360,
    speed: 1,
    output_duration_seconds: 360,
    translation: {
      text: mandarin ? "Spring Boot使用JSON。" : "Spring Boot dùng JSON.",
      is_illustrative: false,
      provider: "azure-translator",
    },
    audio: {
      url: "/api/jobs/job-1/result/audio",
      download_url: "/api/jobs/job-1/result/audio?download=1",
      content_type: "audio/mpeg",
      provider: "azure-speech",
      is_fixture: false,
      duration_adjusted: true,
      duration: null,
    },
    expires_at: "2030-01-01T01:01:00Z",
    notices: [],
  };
}

let meta: Record<string, unknown>;
let created: Record<string, unknown>[];
// When set, the server answers job and result as for an older job (no language fields).
let olderServerJob: boolean;
let rejectLanguage: boolean;

beforeEach(() => {
  meta = META;
  created = [];
  olderServerJob = false;
  rejectLanguage = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url === "/api/meta") return json(meta);
      if (url === "/api/session") return json(SESSION);
      if (url === "/api/jobs" && method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        created.push(body);
        if (rejectLanguage) {
          return json(
            {
              error: {
                code: "validation_error",
                message: "The request is invalid.",
                fields: [{ field: "target_language", message: "Input should be 'vietnamese'." }],
              },
            },
            422,
          );
        }
        return json(jobFor(body, "queued"), 202);
      }
      const stored = olderServerJob ? { voice: created[0]?.voice } : (created[0] ?? {});
      if (url === "/api/jobs/job-1") return json(jobFor(stored));
      if (url === "/api/jobs/job-1/result") return json(resultFor(stored));
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openStudio() {
  render(<App />);
  await screen.findByLabelText("English Transcript");
  return userEvent.setup();
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("English Transcript"), "Spring Boot uses JSON.");
  await user.type(screen.getByLabelText("First Sentence Start Time"), "00:00:10");
  await user.type(screen.getByLabelText("Last Sentence Start Time"), "00:06:10");
  await user.click(screen.getByRole("button", { name: "Generate audio" }));
}

const languageSelect = () => screen.getByLabelText("Translate to") as HTMLSelectElement;

describe("Translate to", () => {
  it("offers the server's languages with Vietnamese selected, next to Andrew and Emma", async () => {
    await openStudio();
    const options = within(languageSelect()).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ["vietnamese", "Vietnamese"],
      ["mandarin_simplified", "Chinese — Mandarin (Simplified)"],
    ]);
    expect(languageSelect().value).toBe("vietnamese");
    expect(screen.getByText("English → Vietnamese")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Turn English into Vietnamese or Mandarin Chinese audio",
    );
    const settings = screen.getByRole("complementary", { name: "Language, voice and speed settings" });
    expect(within(settings).getAllByRole("radio", { name: /Multilingual/ })).toHaveLength(2);
  });

  it("sends Vietnamese by default", async () => {
    const user = await openStudio();
    await fillAndSubmit(user);
    await screen.findByText(/Language Vietnamese/);
    expect(created[0]?.target_language).toBe("vietnamese");
    expect(created[0]?.voice).toBe("AndrewMultilingual");
  });

  it("sends Mandarin when chosen, with the voice and speed chosen", async () => {
    const user = await openStudio();
    await user.selectOptions(languageSelect(), "mandarin_simplified");
    expect(screen.getByText("English → Mandarin Chinese")).toBeTruthy();
    await user.click(screen.getByLabelText(/Emma Multilingual/));
    await user.click(screen.getByLabelText("1.5x"));
    await fillAndSubmit(user);
    await screen.findByText(/Language Chinese — Mandarin \(Simplified\)/);
    expect(created[0]).toMatchObject({
      target_language: "mandarin_simplified",
      voice: "EmmaMultilingual",
      speed: 1.5,
    });
  });

  it("labels the result with the job's language, not with what the form shows later", async () => {
    const user = await openStudio();
    await user.selectOptions(languageSelect(), "mandarin_simplified");
    await fillAndSubmit(user);
    const summary = await screen.findByText("Mandarin Chinese translation");
    await user.selectOptions(languageSelect(), "vietnamese");

    expect(summary.textContent).toBe("Mandarin Chinese translation");
    expect(screen.queryByText("Vietnamese translation")).toBeNull();
    const facts = screen.getByText("Language", { selector: "dt" }).parentElement!;
    expect(facts.textContent).toContain("Chinese — Mandarin (Simplified)");
    const text = screen.getByText("Spring Boot使用JSON。");
    expect(text.getAttribute("lang")).toBe("zh-Hans");
  });

  it("shows a job without a stored language (older jobs) as Vietnamese", async () => {
    olderServerJob = true;
    const user = await openStudio();
    await user.selectOptions(languageSelect(), "mandarin_simplified");
    await fillAndSubmit(user);
    await screen.findByText("Vietnamese translation");
    expect(screen.getByText(/Language Vietnamese/)).toBeTruthy();
    expect(screen.getByText("Spring Boot dùng JSON.").getAttribute("lang")).toBe("vi");
  });

  it("shows the server's answer about the language next to the selector", async () => {
    rejectLanguage = true;
    const user = await openStudio();
    await fillAndSubmit(user);
    expect(await screen.findByText("Input should be 'vietnamese'.")).toBeTruthy();
    expect(languageSelect().getAttribute("aria-invalid")).toBe("true");
    expect(languageSelect().getAttribute("aria-describedby")).toBe("target-language-error");
  });

  it("names both languages in the disclosure", async () => {
    await openStudio();
    expect(document.body.textContent).toContain(
      "the translated Vietnamese or Mandarin Chinese text is sent to Microsoft Azure Speech",
    );
  });

  it("offers nothing and sends nothing when the server lists no languages", async () => {
    meta = { ...META, target_languages: undefined, default_target_language: undefined };
    const user = await openStudio();
    expect(screen.queryByLabelText("Translate to")).toBeNull();
    expect(screen.getByText("English → Vietnamese")).toBeTruthy();
    await fillAndSubmit(user);
    await screen.findByText("Vietnamese translation");
    expect(created[0]).not.toHaveProperty("target_language");
  });
});

describe("Translate to in a draft and for guests", () => {
  function renderForm(initialDraft?: StudioDraft, onDraftChange = vi.fn(), guest = false) {
    render(
      <DubbingForm
        voices={VOICES}
        languages={LANGUAGES}
        defaultLanguage="vietnamese"
        disclosure={null}
        onJobCreated={() => {}}
        onSessionExpired={() => {}}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        guest={
          guest
            ? { maxWords: 1000, maxOutputSeconds: 600, onQuotaExhausted() {}, onSignIn() {} }
            : undefined
        }
      />,
    );
    return onDraftChange;
  }
  const draft: StudioDraft = {
    transcript: "Hello.",
    firstStart: "00:00:10",
    lastStart: "00:00:20",
    voice: "EmmaMultilingual",
    speed: 1.25,
  };

  it("restores the drafted language and keeps it in the draft", () => {
    const onDraftChange = renderForm({ ...draft, targetLanguage: "mandarin_simplified" });
    expect(languageSelect().value).toBe("mandarin_simplified");
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetLanguage: "mandarin_simplified", voice: "EmmaMultilingual" }),
    );
  });

  it("starts a draft from before the option, or with a language no longer offered, in Vietnamese", () => {
    renderForm(draft);
    expect(languageSelect().value).toBe("vietnamese");
    cleanup();
    renderForm({ ...draft, targetLanguage: "cantonese" });
    expect(languageSelect().value).toBe("vietnamese");
  });

  it("remembers a new choice in the draft", async () => {
    const onDraftChange = renderForm(draft);
    await userEvent.setup().selectOptions(languageSelect(), "mandarin_simplified");
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetLanguage: "mandarin_simplified" }),
    );
  });

  it("offers guests the same choice and sends it", async () => {
    const user = userEvent.setup();
    renderForm(draft, vi.fn(), true);
    await user.selectOptions(languageSelect(), "mandarin_simplified");
    await user.click(screen.getByRole("button", { name: "Generate audio" }));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.target_language).toBe("mandarin_simplified");
  });
});
