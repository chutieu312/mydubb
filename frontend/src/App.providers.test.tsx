import { cleanup, render, screen } from "@testing-library/react";
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
  it("all-mock mode: mock banner and no Azure disclosure", async () => {
    stubApi({ translation: "mock", speech: "mock", audio: "mock" });
    render(<App />);
    await screen.findByLabelText("English Transcript");

    expect(screen.getByRole("status").textContent).toContain("No Azure services are called");
    expect(screen.queryByText(/sent to Microsoft Azure Translator/)).toBeNull();
  });

  it("Azure translation + Azure speech: both services named before submit", async () => {
    stubApi({ translation: "azure", speech: "azure", audio: "mock" });
    render(<App />);
    await screen.findByLabelText("English Transcript");

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Speech: Azure Speech (real)");
    expect(banner.textContent).toContain("duration not adjusted");

    const disclosure = screen.getByText(/sent to Microsoft Azure Speech/);
    const submit = screen.getByRole("button", { name: "Generate Dubbing" });
    expect(disclosure.textContent).toContain("Microsoft Azure Translator");
    expect(submit.getAttribute("aria-describedby")).toBe(disclosure.id);
  });

  it("everything real, with FFmpeg: no mock banner", async () => {
    stubApi({ translation: "azure", speech: "azure", audio: "ffmpeg" });
    render(<App />);
    await screen.findByLabelText("English Transcript");

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/not adjusted/i)).toBeNull();
    expect(screen.getByText(/sent to Microsoft Azure Speech/)).toBeTruthy();
  });

  it("Azure translation + mock audio: per-component banner and disclosure before submit", async () => {
    stubApi({ translation: "azure", speech: "mock", audio: "mock" });
    render(<App />);
    await screen.findByLabelText("English Transcript");

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Translation: Azure Translator (real)");
    expect(banner.textContent).toContain("Speech: mock");
    expect(banner.textContent).not.toContain("No Azure services are called");

    const disclosure = screen.getByText(/transcript text is sent to Microsoft Azure Translator/);
    const submit = screen.getByRole("button", { name: "Generate Dubbing" });
    expect(submit.getAttribute("aria-describedby")).toBe(disclosure.id);
    // The notice comes before the submit button in the page.
    expect(
      disclosure.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

const RESULT = {
  job_id: "j1",
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

describe("ResultView labels", () => {
  it("labels a real translation and a mock audio fixture separately", async () => {
    stubApi({ translation: "azure", speech: "mock", audio: "mock" }, RESULT);
    render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    expect(screen.getByText("Azure Translator", { selector: ".badge" })).toBeTruthy();
    expect(screen.getByText("Mock fixture")).toBeTruthy();
    expect(screen.queryByText("Illustrative mock")).toBeNull();
  });

  it("real speech: Azure Speech badge, no fixture label, duration not adjusted", async () => {
    const real = {
      ...RESULT,
      audio: { ...RESULT.audio, provider: "azure-speech", is_fixture: false },
      notices: ["Speech was generated by Azure Speech from the Vietnamese text above."],
    };
    stubApi({ translation: "azure", speech: "azure", audio: "mock" }, real);
    render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    expect(screen.getByText("Azure Speech", { selector: ".badge" })).toBeTruthy();
    expect(screen.getByText("Duration not adjusted", { selector: ".badge" })).toBeTruthy();
    expect(screen.queryByText("Mock fixture")).toBeNull();
    expect(screen.getByText("Azure Translator", { selector: ".badge" })).toBeTruthy();
  });

  it("a duration-adjusted result shows target and actual durations, unrounded", async () => {
    const adjusted = {
      ...RESULT,
      audio: {
        ...RESULT.audio,
        provider: "azure-speech",
        is_fixture: false,
        duration_adjusted: true,
        duration: {
          sample_rate: 24000,
          target_seconds: 360,
          target_samples: 8640000,
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
        },
      },
    };
    stubApi({ translation: "azure", speech: "azure", audio: "ffmpeg" }, adjusted);
    render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    expect(screen.queryByText("Duration not adjusted")).toBeNull();
    expect(screen.getByText("Duration adjusted", { selector: ".badge" })).toBeTruthy();

    const details = screen.getByLabelText("Audio duration");
    const text = details.textContent ?? "";
    expect(text).toContain("Target 360.000000 s");
    expect(text).toContain("Actual 360.000042 s");
    // A one-sample difference stays visible: nothing is rounded to hide it.
    expect(text).toContain("8,640,001 samples");
    expect(text).toContain("8,640,000 samples");
    expect(text).toContain("370.123458 s");
    expect(text).toContain("×1.02812 (faster, pitch preserved)");
    expect(text).toContain("70 samples (2.92 ms) of silence added at the end");
    // ffprobe's own figure is shown as is, with the reason it can be a little longer.
    expect(text).toContain("360.056000 s");
    expect(text).toContain("encoder delay and padding");
  });

  it("says when the speech needed no tempo change and nothing was added", async () => {
    const exact = {
      ...RESULT,
      audio: {
        ...RESULT.audio,
        provider: "azure-speech",
        is_fixture: false,
        duration_adjusted: true,
        duration: {
          sample_rate: 24000,
          target_seconds: 5,
          target_samples: 120000,
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
          trimmed_samples: 0,
        },
      },
    };
    stubApi({ translation: "azure", speech: "azure", audio: "ffmpeg" }, exact);
    render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    const text = screen.getByLabelText("Audio duration").textContent ?? "";
    expect(text).toContain("Tempo change");
    expect(text).toContain("none (the speech was already within the rounding of the target)");
    expect(text).toContain("Silence adjustment");
  });

  it("a result that was not adjusted shows no duration details", async () => {
    stubApi({ translation: "azure", speech: "azure", audio: "mock" }, RESULT);
    render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    expect(screen.queryByLabelText("Audio duration")).toBeNull();
  });

  it("shows provider text as plain text, never as HTML", async () => {
    stubApi({ translation: "azure", speech: "mock", audio: "mock" }, RESULT);
    const { container } = render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    const text = container.querySelector(".translation");
    expect(text?.textContent).toBe("Một <b>neural network</b> & loss function");
    expect(text?.querySelector("b")).toBeNull();
  });

  it("keeps the illustrative badge for mock translations", async () => {
    const mock = {
      ...RESULT,
      translation: {
        text: "(VI mock) x",
        is_illustrative: true,
        provider: "mock-translation",
      },
    };
    stubApi({ translation: "mock", speech: "mock", audio: "mock" }, mock);
    render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    expect(screen.getByText("Illustrative mock")).toBeTruthy();
    expect(screen.queryByText("Azure Translator", { selector: ".badge" })).toBeNull();
  });
});
