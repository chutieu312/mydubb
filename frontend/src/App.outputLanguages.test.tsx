import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { TargetLanguageOption } from "./api/types";
import { DubbingForm } from "./features/dubbing/DubbingForm";
import { ProviderBanner } from "./features/providers/ProviderBanner";
import { ltrRuns } from "./lib/bidi";
import { jobLanguage, languageNouns } from "./lib/languages";
import { azureDisclosure } from "./lib/providers";
import type { StudioDraft } from "./lib/studioDraft";

// What GET /api/meta lists: Vietnamese, Mandarin and the six added languages, in this order.
const ROWS: [string, string, string, string, string][] = [
  ["vietnamese", "Vietnamese", "Vietnamese", "vi", "vi-VN"],
  [
    "mandarin_simplified",
    "Chinese — Mandarin (Simplified)",
    "Mandarin Chinese",
    "zh-Hans",
    "zh-CN",
  ],
  ["hindi", "Hindi", "Hindi", "hi", "hi-IN"],
  ["spanish", "Spanish (Spain)", "Spanish", "es", "es-ES"],
  ["arabic", "Arabic (Modern Standard)", "Arabic", "ar", "ar-SA"],
  ["french", "French (France)", "French", "fr", "fr-FR"],
  ["russian", "Russian", "Russian", "ru", "ru-RU"],
  ["japanese", "Japanese", "Japanese", "ja", "ja-JP"],
];
const LANGUAGES: TargetLanguageOption[] = ROWS.map(
  ([id, label, noun, translator_language, speech_locale]) => ({
    id,
    label,
    noun,
    translator_language,
    speech_locale,
    text_direction: id === "arabic" ? ("rtl" as const) : ("ltr" as const),
  }),
);
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
  auth: {
    mode: "access_code",
    self_registration: false,
    password_reset: false,
  },
};
const SESSION = {
  authenticated: true,
  csrf_token: "csrf-1",
  expires_at: "2030-01-01T00:00:00Z",
};
// Translations as the server returns them: Arabic holds English terms and code (left to right).
const TRANSLATIONS = {
  vietnamese: "Spring Boot dùng JSON.",
  arabic: "يستخدم Spring Boot صيغة JSON عبر /api/v1 بنسبة 50%.",
  japanese: "Spring BootはJSONを使います。",
  hindi: "Spring Boot JSON का उपयोग करता है।",
};
const translationOf = (id: string): string =>
  TRANSLATIONS[id as keyof typeof TRANSLATIONS];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function jobFor(body: Record<string, unknown>, status = "completed") {
  const language = LANGUAGES.find((l) => l.id === body.target_language);
  return {
    id: "job-1",
    status,
    voice: body.voice,
    ...(language
      ? { target_language: language.id, target_language_label: language.label }
      : {}),
    first_sentence_start: "00:00:10",
    last_sentence_start: "00:06:10",
    target_duration_seconds: 360,
    target_duration: "00:06:00",
    baseline_duration_seconds: 360,
    speed: body.speed ?? 1,
    output_duration_seconds: 360,
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    completed_at: "2030-01-01T00:01:00Z",
    result_expires_at: "2030-01-01T01:01:00Z",
    error: null,
  };
}

function resultFor(body: Record<string, unknown>) {
  const id = String(body.target_language ?? "vietnamese");
  return {
    job_id: "job-1",
    target_language: id,
    baseline_duration_seconds: 360,
    speed: 1,
    output_duration_seconds: 360,
    translation: {
      text: translationOf(id),
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

let created: Record<string, unknown>[];

beforeEach(() => {
  created = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      if (url === "/api/meta") return json(META);
      if (url === "/api/session") return json(SESSION);
      if (url === "/api/jobs" && method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        created.push(body);
        return json(jobFor(body, "queued"), 202);
      }
      const stored = created[0] ?? {};
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
  await user.type(
    screen.getByLabelText("English Transcript"),
    "Spring Boot uses JSON.",
  );
  await user.type(
    screen.getByLabelText("First Sentence Start Time"),
    "00:00:10",
  );
  await user.type(
    screen.getByLabelText("Last Sentence Start Time"),
    "00:06:10",
  );
  await user.click(screen.getByRole("button", { name: "Generate audio" }));
}

const languageSelect = () =>
  screen.getByLabelText("Translate to") as HTMLSelectElement;

describe("Eight output languages", () => {
  it("offers all eight in the server's order with Vietnamese selected; the UI stays English", async () => {
    await openStudio();
    const options = within(languageSelect()).getAllByRole(
      "option",
    ) as HTMLOptionElement[];
    expect(options.map((o) => o.textContent)).toEqual([
      "Vietnamese",
      "Chinese — Mandarin (Simplified)",
      "Hindi",
      "Spanish (Spain)",
      "Arabic (Modern Standard)",
      "French (France)",
      "Russian",
      "Japanese",
    ]);
    expect(languageSelect().value).toBe("vietnamese");
    // Eight names do not fit a heading or a sentence: "your chosen language", "translated text".
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Turn English into audio in your chosen language",
    );
    expect(document.body.textContent).toContain(
      "the translated text is sent to Microsoft Azure Speech",
    );
    expect(document.body.textContent).not.toContain("Vietnamese or");
    expect(document.documentElement.getAttribute("dir")).toBeNull();
  });

  it.each([
    ["hindi", "Hindi"],
    ["spanish", "Spanish"],
    ["arabic", "Arabic"],
    ["french", "French"],
    ["russian", "Russian"],
    ["japanese", "Japanese"],
  ])("sends %s with the voice and speed chosen", async (id, noun) => {
    const user = await openStudio();
    await user.selectOptions(languageSelect(), id);
    expect(screen.getByText(`English → ${noun}`)).toBeTruthy();
    await user.click(screen.getByLabelText(/Emma Multilingual/));
    await user.click(screen.getByLabelText("0.75x"));
    await fillAndSubmit(user);
    await screen.findByText(/Language /);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      target_language: id,
      voice: "EmmaMultilingual",
      speed: 0.75,
    });
  });

  it("shows an Arabic result right to left in its own box only, English and code kept inside", async () => {
    const user = await openStudio();
    await user.selectOptions(languageSelect(), "arabic");
    await fillAndSubmit(user);
    expect(await screen.findByText("Arabic translation")).toBeTruthy();
    const text = document.querySelector(".translation")!;
    expect(text.textContent).toBe(TRANSLATIONS.arabic); // unchanged, as text
    expect(text.getAttribute("lang")).toBe("ar");
    expect(text.getAttribute("dir")).toBe("rtl");
    // English terms and code are left-to-right isolates, so "/api/v1" keeps its slash in front.
    const isolates = Array.from(text.querySelectorAll('span[dir="ltr"]')).map((s) => s.textContent);
    expect(isolates).toEqual(["Spring Boot", "JSON", "/api/v1"]);
    expect(text.querySelectorAll("*:not(span)")).toHaveLength(0);
    // Nothing around the box changes direction.
    expect(text.parentElement?.closest("[dir]")).toBeNull();
    const facts = screen.getByText("Language", {
      selector: "dt",
    }).parentElement!;
    expect(facts.textContent).toContain("Arabic (Modern Standard)");
  });

  it.each([
    ["japanese", "ja"],
    ["hindi", "hi"],
  ])(
    "tags a %s result with its language and left to right",
    async (id, tag) => {
      const user = await openStudio();
      await user.selectOptions(languageSelect(), id);
      await fillAndSubmit(user);
      const text = await screen.findByText(translationOf(id));
      expect(text.getAttribute("lang")).toBe(tag);
      expect(text.getAttribute("dir")).toBe("ltr");
    },
  );

  it("keeps the result of a job in its own language when the form changes afterwards", async () => {
    const user = await openStudio();
    await user.selectOptions(languageSelect(), "japanese");
    await fillAndSubmit(user);
    const summary = await screen.findByText("Japanese translation");
    await user.selectOptions(languageSelect(), "arabic");
    expect(summary.textContent).toBe("Japanese translation");
    expect(screen.queryByText("Arabic translation")).toBeNull();
    expect(screen.getByText(TRANSLATIONS.japanese).getAttribute("dir")).toBe(
      "ltr",
    );
    expect(created).toHaveLength(1);
  });
});

describe("Eight languages in a draft, for guests and in the wording", () => {
  function renderForm(
    initialDraft?: StudioDraft,
    onDraftChange = vi.fn(),
    guest = false,
  ) {
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
            ? {
                maxWords: 1000,
                maxOutputSeconds: 600,
                onQuotaExhausted() {},
                onSignIn() {},
              }
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

  it("restores a drafted new language and an older draft starts in Vietnamese", () => {
    const onDraftChange = renderForm({ ...draft, targetLanguage: "russian" });
    expect(languageSelect().value).toBe("russian");
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetLanguage: "russian",
        voice: "EmmaMultilingual",
        speed: 1.25,
      }),
    );
    cleanup();
    renderForm(draft);
    expect(languageSelect().value).toBe("vietnamese");
    cleanup();
    renderForm({ ...draft, targetLanguage: "german" });
    expect(languageSelect().value).toBe("vietnamese");
  });

  it("offers guests the same eight and sends their choice", async () => {
    const user = userEvent.setup();
    renderForm(draft, vi.fn(), true);
    expect(within(languageSelect()).getAllByRole("option")).toHaveLength(8);
    await user.selectOptions(languageSelect(), "french");
    await user.click(screen.getByRole("button", { name: "Generate audio" }));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.target_language).toBe("french");
  });

  it("names one or two languages and speaks of the translated text beyond that", () => {
    expect(languageNouns(LANGUAGES.slice(0, 1))).toBe("Vietnamese");
    expect(languageNouns(LANGUAGES.slice(0, 2))).toBe(
      "Vietnamese or Mandarin Chinese",
    );
    expect(languageNouns(LANGUAGES)).toBeNull();
    const speechOnly = {
      translation: "mock",
      speech: "azure",
      audio: "ffmpeg",
    };
    expect(azureDisclosure(speechOnly, null)).toContain(
      "the translated text (here a mock",
    );
    render(<ProviderBanner providers={speechOnly} languages={null} />);
    expect(screen.getByRole("status").textContent).toContain(
      "The translated text is an illustrative placeholder",
    );
  });

  it("gives a stored job without a known option no direction, and Arabic rtl", () => {
    expect(jobLanguage({ target_language: "arabic" }, LANGUAGES).dir).toBe(
      "rtl",
    );
    expect(jobLanguage({ target_language: "french" }, LANGUAGES).dir).toBe(
      "ltr",
    );
    expect(
      jobLanguage({ target_language: "klingon" }, LANGUAGES).dir,
    ).toBeUndefined();
  });
});

describe("Left-to-right runs in a right-to-left translation", () => {
  it.each([
    ["نستخدم REST API الآن.", ["REST API"]],
    ["عبر /api/v1 و ~/.bashrc و ./run.sh.", ["/api/v1", "~/.bashrc", "./run.sh"]],
    ["لغة C++ و C# و Node.js و user@example.com", ["C++", "C#", "Node.js", "user@example.com"]],
    ["بنسبة 50% في 2026.", []],
    // A whole token stays in one isolate: digits, query punctuation and backslashes included.
    ["افتح /2026/api الآن.", ["/2026/api"]],
    [
      "ابحث في https://example.com/search?q=API&lang=en، ثم تابع.",
      ["https://example.com/search?q=API&lang=en"],
    ],
    [String.raw`احفظ الملف في C:\Users\demo\file.txt.`, [String.raw`C:\Users\demo\file.txt`]],
    // Punctuation and Arabic letters touching a token stay on the Arabic side.
    ["المسار (/api/v1)، وDocker؟", ["/api/v1", "Docker"]],
    ["يستخدم Spring Boot و gradient descent.", ["Spring Boot", "gradient descent"]],
  ])("isolates %s", (text, runs) => {
    const pieces = ltrRuns(text);
    expect(pieces.map((p) => p.text).join("")).toBe(text);
    expect(pieces.filter((p) => p.ltr).map((p) => p.text)).toEqual(runs);
  });
});
