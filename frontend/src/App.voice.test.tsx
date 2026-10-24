import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const META = {
  provider_mode: "mock",
  mock_mode: true,
  providers: { translation: "mock", speech: "mock", audio: "mock" },
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

function job(voice: string) {
  return {
    id: "job-1",
    status: "queued",
    voice,
    first_sentence_start: "00:00:10",
    last_sentence_start: "00:06:10",
    target_duration_seconds: 360,
    target_duration: "00:06:00",
    baseline_duration_seconds: 360,
    speed: 1,
    output_duration_seconds: 360,
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    completed_at: null,
    result_expires_at: null,
    error: null,
  };
}

let created: Record<string, unknown>[];
let storedVoice: string | null;

beforeEach(() => {
  created = [];
  storedVoice = null; // when set, the server reports this voice instead of the requested one
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
        return json(job(storedVoice ?? String(body.voice)), 202);
      }
      if (url === "/api/jobs/job-1") {
        return json(job(storedVoice ?? String(created[0]?.voice)));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("English Transcript"), "Spring Boot uses JSON.");
  await user.type(screen.getByLabelText("First Sentence Start Time"), "00:00:10");
  await user.type(screen.getByLabelText("Last Sentence Start Time"), "00:06:10");
  await user.click(screen.getByRole("button", { name: "Generate audio" }));
}

describe("voice selection", () => {
  it("offers exactly Andrew and Emma Multilingual, Andrew selected by default", async () => {
    render(<App />);
    await screen.findByLabelText("English Transcript");

    const voiceGroup = screen.getByRole("group", { name: "Voice" });
    const radios = within(voiceGroup).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["AndrewMultilingual", "EmmaMultilingual"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(screen.getByLabelText(/Andrew Multilingual/)).toBeTruthy();
    expect(screen.getByLabelText(/Emma Multilingual/)).toBeTruthy();
    expect(screen.queryByLabelText(/HoaiMy/)).toBeNull();
    expect(screen.queryByLabelText(/NamMinh/)).toBeNull();
  });

  it("submits the default voice", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);

    await screen.findByText(/Voice Andrew Multilingual/);
    expect(created).toHaveLength(1);
    expect(created[0]?.voice).toBe("AndrewMultilingual");
  });

  it("submits Emma when she is chosen", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await user.click(screen.getByLabelText(/Emma Multilingual/));
    await fillAndSubmit(user);

    await screen.findByText(/Voice Emma Multilingual/);
    expect(created[0]?.voice).toBe("EmmaMultilingual");
  });

  it("shows a job stored with a replaced voice by its stored name instead of failing", async () => {
    const user = userEvent.setup();
    storedVoice = "HoaiMy"; // metadata of a job created before the voices changed
    render(<App />);
    await screen.findByLabelText("English Transcript");
    await fillAndSubmit(user);

    await screen.findByText(/Voice HoaiMy/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
