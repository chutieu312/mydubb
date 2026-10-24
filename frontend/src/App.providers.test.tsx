import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ResultView } from "./features/jobs/ResultView";

const BASE_META = {
  provider_mode: "mock",
  mock_mode: true,
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
const SESSION = {
  authenticated: true,
  csrf_token: "csrf-1",
  expires_at: "2030-01-01T00:00:00Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function stubApi(providers: Record<string, string>, result?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/meta") return json({ ...BASE_META, providers });
      if (url === "/api/session") return json(SESSION);
      if (url.endsWith("/result") && result) return json(result);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App provider labels", () => {
  it("all-mock mode: mock banner and nothing about outside services", async () => {
    stubApi({ translation: "mock", speech: "mock", audio: "mock" });
    render(<App />);
    await screen.findByLabelText("English Transcript");

    expect(screen.getByRole("status").textContent).toContain("Development mock mode.");
    expect(screen.getByRole("status").textContent).toContain("No Azure services are called");
    expect(screen.queryByText(/sent to Microsoft Azure/)).toBeNull();
  });

  it("Azure translation + Azure speech: the text going out is named before submit", async () => {
    stubApi({ translation: "azure", speech: "azure", audio: "mock" });
    render(<App />);
    await screen.findByLabelText("English Transcript");

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Speech: Azure Speech (real)");
    expect(banner.textContent).toContain("duration not adjusted");

    const notice = screen.getByText(/Your text is sent to Microsoft Azure to translate/);
    const submit = screen.getByRole("button", { name: "Generate audio" });
    expect(submit.getAttribute("aria-describedby")).toBe(notice.id);
    // The notice comes before the button in the page.
    expect(notice.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The full statement, naming both services, is in Privacy.
    const privacy = screen.getByText("Privacy").closest("details");
    expect(privacy?.textContent).toContain("sent to Microsoft Azure Translator");
    expect(privacy?.textContent).toContain("sent to Microsoft Azure Speech");
  });

  it("everything real: no banner, no provider or diagnostic clutter, disclosure kept", async () => {
    stubApi({ translation: "azure", speech: "azure", audio: "ffmpeg" });
    const { container } = render(<App />);
    await screen.findByLabelText("English Transcript");

    expect(screen.queryByRole("status")).toBeNull();
    const screenText = [".header", ".main"]
      .map((selector) => container.querySelector(selector)?.textContent ?? "")
      .join(" ");
    expect(screenText).not.toMatch(
      /Beta|Development|Azure Translator|Azure Speech|FFmpeg|not adjusted|sample|padding/i,
    );
    // What users must still be told: their text goes to an outside service.
    expect(screen.getByText(/Your text is sent to Microsoft Azure to translate/)).toBeTruthy();
    const privacy = screen.getByText("Privacy").closest("details");
    expect(privacy?.textContent).toContain("sent to Microsoft Azure Speech");
    expect(privacy?.textContent).toContain("kept temporarily (about 1 hour)");
  });

  it("Azure translation + mock audio: per-component banner and disclosure before submit", async () => {
    stubApi({ translation: "azure", speech: "mock", audio: "mock" });
    render(<App />);
    await screen.findByLabelText("English Transcript");

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Translation: Azure Translator (real)");
    expect(banner.textContent).toContain("Speech: mock");
    expect(banner.textContent).not.toContain("No Azure services are called");

    const notice = screen.getByText(/Your text is sent to Microsoft Azure to be translated/);
    const submit = screen.getByRole("button", { name: "Generate audio" });
    expect(submit.getAttribute("aria-describedby")).toBe(notice.id);
  });
});

const RESULT = {
  job_id: "j1",
  baseline_duration_seconds: 360,
  speed: 1,
  output_duration_seconds: 360,
  translation: {
    text: "Một <b>neural network</b> & loss function",
    is_illustrative: false,
    provider: "azure-translator",
  },
  audio: {
    url: "/a",
    download_url: "/a?download=1",
    content_type: "audio/mpeg",
    provider: "mock-speech",
    is_fixture: true,
    duration_adjusted: false,
    duration: null,
  },
  expires_at: "2030-01-01T00:00:00Z",
  notices: ["Translated by Azure Translator.", "The audio is a fixed development fixture."],
};

const DURATION = {
  sample_rate: 24000,
  target_seconds: 360,
  target_samples: 8640000,
  baseline_seconds: 360,
  speed: 1,
  source_seconds: 370.123458,
  source_samples: 8882963,
  processed_seconds: 360,
  processed_samples: 8640000,
  mp3_container_seconds: 360.056,
  mp3_decoded_seconds: 360.000042,
  mp3_decoded_samples: 8640001,
  mp3_header_seconds: 360,
  mp3_header_samples: 8640000,
  tempo_factor: 1.02812,
  padded_samples: 70,
  trimmed_samples: 0,
  mp3_padding_adjusted_samples: 0,
};

// What production returns: real translation, real speech, audio fitted by FFmpeg.
const REAL = {
  ...RESULT,
  audio: {
    ...RESULT.audio,
    provider: "azure-speech",
    is_fixture: false,
    duration_adjusted: true,
    duration: DURATION,
  },
  notices: [
    "Translated by Azure Translator. Technical terms from the MyDubb glossary are kept in English.",
    "Speech was generated by Azure Speech from the Vietnamese text above.",
  ],
};

const REAL_PROVIDERS = { translation: "azure", speech: "azure", audio: "ffmpeg" };

const renderResult = (result: unknown, providers: Record<string, string> = REAL_PROVIDERS) => {
  stubApi(providers, result);
  return render(
    <ResultView jobId="j1" voiceLabel="Andrew Multilingual" onSessionExpired={() => {}} />,
  );
};

const audioDetails = () =>
  screen.getByText("Audio details").closest("details") as HTMLDetailsElement;

describe("ResultView: a real result", () => {
  it("shows audio, download, voice, speed, target and actual, and nothing technical", async () => {
    const { container } = renderResult(REAL);
    await screen.findByText("Audio ready");

    expect(container.querySelector("audio")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download MP3" }).getAttribute("href")).toBe(
      "/a?download=1",
    );
    const facts = container.querySelector(".facts")?.textContent ?? "";
    expect(facts).toContain("VoiceAndrew Multilingual");
    expect(facts).toContain("Speed1x");
    expect(facts).toContain("Target length00:06:00");
    expect(facts).toContain("Actual length00:06:00");

    // Everything outside the closed "Audio details" is free of provider and measurement jargon.
    const details = audioDetails();
    expect(details.open).toBe(false);
    const main = (container.textContent ?? "").replace(details.textContent ?? "", "");
    expect(main).not.toMatch(/Azure|FFmpeg|samples|padding|header|tempo|mock|fixture/i);
    expect(screen.queryByText("Duration not adjusted")).toBeNull();
    expect(screen.queryByText(/Beta|Development/)).toBeNull();
  });

  it("keeps the unrounded measurements and the server notes inside Audio details", async () => {
    renderResult(REAL);
    await screen.findByText("Audio ready");

    const text = audioDetails().textContent ?? "";
    expect(text).toContain("Translated by Azure Translator. Technical terms");
    expect(text).toContain("Speech was generated by Azure Speech");
    expect(text).toContain("azure-translator");
    expect(text).toContain("azure-speech");

    const measured = screen.getByLabelText("Audio duration").textContent ?? "";
    expect(measured).toContain("Target 360.000000 s");
    expect(measured).toContain("Actual 360.000042 s");
    // A one-sample difference stays visible: nothing is rounded to hide it.
    expect(measured).toContain("8,640,001 samples");
    expect(measured).toContain("8,640,000 samples");
    expect(measured).toContain("370.123458 s");
    expect(measured).toContain("×1.02812 (faster, pitch preserved)");
    expect(measured).toContain("70 samples (2.92 ms) of silence added at the end");
    // ffprobe's own figure is shown as is, with the reason it can be a little longer.
    expect(measured).toContain("360.056000 s");
    expect(measured).toContain("encoder delay and padding");
    expect(text).toContain("MP3 header correction");
  });

  it("says when the speech needed no tempo change and nothing was added", async () => {
    const exact = {
      ...REAL,
      audio: {
        ...REAL.audio,
        duration: {
          ...DURATION,
          target_seconds: 5,
          target_samples: 120000,
          baseline_seconds: 5,
          source_seconds: 5,
          source_samples: 120000,
          processed_seconds: 5,
          processed_samples: 120000,
          mp3_container_seconds: 5,
          mp3_decoded_seconds: 5,
          mp3_decoded_samples: 120000,
          mp3_header_seconds: 5,
          mp3_header_samples: 120000,
          tempo_factor: null,
          padded_samples: 0,
        },
      },
    };
    renderResult(exact);
    await screen.findByText("Audio ready");
    const text = screen.getByLabelText("Audio duration").textContent ?? "";
    expect(text).toContain("none (the speech was already within the rounding of the target)");
    expect(text).toContain("Silence adjustment");
  });

  it("states a speed other than 1x as a plain consequence for the user", async () => {
    const { container } = renderResult({ ...REAL, speed: 1.5, output_duration_seconds: 240 });
    await screen.findByText("Audio ready");
    expect(container.querySelector(".facts")?.textContent).toContain("Speed1.5x");
    expect(screen.getByText(/At 1.5x this audio is shorter than the time between/)).toBeTruthy();

    cleanup();
    renderResult({ ...REAL, speed: 0.75, output_duration_seconds: 480 });
    await screen.findByText("Audio ready");
    expect(screen.getByText(/At 0.75x this audio is longer than the time between/)).toBeTruthy();
  });

  it("says nothing about speed when it is 1x", async () => {
    renderResult(REAL);
    await screen.findByText("Audio ready");
    expect(screen.queryByText(/this audio is (shorter|longer) than/)).toBeNull();
  });

  it("shows when the result expires, from the expires_at the server sent", async () => {
    renderResult({ ...REAL, expires_at: "2031-05-06T07:08:00Z" });
    await screen.findByText("Audio ready");
    const expected = new Date("2031-05-06T07:08:00Z").toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    expect(screen.getByText(/Available until/).textContent).toContain(expected);
  });

  it("lets the user collapse and expand the Vietnamese translation", async () => {
    renderResult(REAL);
    await screen.findByText("Audio ready");
    const details = screen.getByText("Vietnamese translation").closest("details")!;
    expect(details.open).toBe(true);
    await userEvent.click(screen.getByText("Vietnamese translation"));
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText("Vietnamese translation"));
    expect(details.open).toBe(true);
  });

  it("shows provider text as plain text, never as HTML", async () => {
    const { container } = renderResult(REAL);
    await screen.findByText("Audio ready");
    const text = container.querySelector(".translation");
    expect(text?.textContent).toBe("Một <b>neural network</b> & loss function");
    expect(text?.querySelector("b")).toBeNull();
  });

  it("starts the player at normal speed: the file already has the chosen speed", async () => {
    const { container } = renderResult({ ...REAL, speed: 2, output_duration_seconds: 180 });
    await screen.findByText("Audio ready");
    const player = container.querySelector("audio") as HTMLAudioElement;
    expect(player.playbackRate).toBe(1);
    expect(player.defaultPlaybackRate).toBe(1);
  });
});

describe("ResultView: mock and hybrid results stay recognisable", () => {
  it("a fixture is flagged next to the player and is not called a finished dubbing", async () => {
    renderResult(RESULT, { translation: "azure", speech: "mock", audio: "mock" });
    await screen.findByText("Mock sample ready");

    expect(screen.getByText(/Sample audio, not your dubbing/)).toBeTruthy();
    expect(screen.getByText(/NOT generated from your transcript/)).toBeTruthy();
    expect(screen.queryByText("Audio ready")).toBeNull();
    expect(screen.getByText("Duration not adjusted", { selector: ".chip" })).toBeTruthy();
    expect(screen.queryByLabelText("Audio duration")).toBeNull();
    // No Azure badge in the main flow; the provider ids live in Audio details.
    expect(screen.queryByText("Azure Translator", { selector: ".chip" })).toBeNull();
    expect(audioDetails().textContent).toContain("mock-speech");
  });

  it("real speech without duration processing: says the length is not the planned one", async () => {
    const real = {
      ...RESULT,
      speed: 1.5,
      output_duration_seconds: 240,
      audio: { ...RESULT.audio, provider: "azure-speech", is_fixture: false },
      notices: ["Speech was generated by Azure Speech from the Vietnamese text above."],
    };
    renderResult(real, { translation: "azure", speech: "azure", audio: "mock" });
    await screen.findByText("Audio ready");

    expect(screen.queryByText(/Sample audio/)).toBeNull();
    expect(screen.getByText("Duration not adjusted", { selector: ".chip" })).toBeTruthy();
    const note = screen.getByLabelText("Audio speed").textContent ?? "";
    expect(note).toContain("Selected speed 1.5x");
    expect(note).toContain("planned length 00:04:00");
    expect(note).toContain("This audio was not adjusted");
  });

  it("an illustrative translation is marked and explained", async () => {
    const mock = {
      ...RESULT,
      translation: { text: "(VI mock) x", is_illustrative: true, provider: "mock-translation" },
    };
    renderResult(mock, { translation: "mock", speech: "mock", audio: "mock" });
    await screen.findByText("Mock sample ready");
    expect(screen.getByText("Illustrative mock")).toBeTruthy();
    expect(screen.getByText(/placeholder text, not a real translation/)).toBeTruthy();
  });
});
