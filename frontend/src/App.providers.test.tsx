import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ResultView } from "./features/jobs/ResultView";

const BASE_META = {
  provider_mode: "mock",
  mock_mode: true,
  voices: [{ id: "HoaiMy", provider_voice: "vi-VN-HoaiMyNeural", description: "Female" }],
  timestamp_format: "HH:MM:SS",
  result_ttl_seconds: 3600,
};
const SESSION = { authenticated: true, csrf_token: "csrf-1", expires_at: "2030-01-01T00:00:00Z" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
  translation: { text: "Một <b>neural network</b> & loss function", is_illustrative: false, provider: "azure-translator" },
  audio: {
    url: "/a",
    download_url: "/a?download=1",
    content_type: "audio/mpeg",
    is_fixture: true,
    duration_adjusted: false,
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
      translation: { text: "(VI mock) x", is_illustrative: true, provider: "mock-translation" },
    };
    stubApi({ translation: "mock", speech: "mock", audio: "mock" }, mock);
    render(<ResultView jobId="j1" onSessionExpired={() => {}} />);

    await screen.findByText("Vietnamese translation");
    expect(screen.getByText("Illustrative mock")).toBeTruthy();
    expect(screen.queryByText("Azure Translator", { selector: ".badge" })).toBeNull();
  });
});
