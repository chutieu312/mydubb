import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ResultView } from "./features/jobs/ResultView";
import { AUDIO_SPEEDS, formatOutputDuration, previewOutputSeconds, speedLabel } from "./lib/speed";

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

/** What the server stores and reports for a submitted job: its own snapshot of the choice. */
function jobFor(body: Record<string, unknown>, status = "queued") {
  const speed = typeof body.speed === "number" ? body.speed : 1;
  return {
    id: "job-1",
    status,
    voice: body.voice,
    first_sentence_start: body.first_sentence_start,
    last_sentence_start: body.last_sentence_start,
    target_duration_seconds: 20,
    target_duration: "00:00:20",
    baseline_duration_seconds: 20,
    speed,
    output_duration_seconds: 20 / speed,
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    completed_at: null,
    result_expires_at: null,
    error: null,
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
        return json(jobFor(body), 202);
      }
      if (url === "/api/jobs/job-1") return json(jobFor(created[0] ?? {}));
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openForm() {
  render(<App />);
  await screen.findByLabelText("English Transcript");
  return userEvent.setup();
}

async function fillTimes(user: ReturnType<typeof userEvent.setup>, first = "00:00:05", last = "00:00:25") {
  await user.type(screen.getByLabelText("English Transcript"), "Spring Boot uses JSON.");
  await user.type(screen.getByLabelText("First Sentence Start Time"), first);
  await user.type(screen.getByLabelText("Last Sentence Start Time"), last);
}

const speedGroup = () => screen.getByRole("group", { name: "Audio speed" });
const preview = () => screen.getByLabelText("Audio length preview");

describe("speed arithmetic for the preview", () => {
  it("lists the seven speeds and labels them", () => {
    expect(AUDIO_SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    expect(AUDIO_SPEEDS.map(speedLabel)).toEqual([
      "0.5x",
      "0.75x",
      "1x",
      "1.25x",
      "1.5x",
      "1.75x",
      "2x",
    ]);
  });

  it.each([
    [0.5, "00:00:40 (40 s)"],
    [0.75, "00:00:26.67 (26.67 s)"],
    [1, "00:00:20 (20 s)"],
    [1.25, "00:00:16 (16 s)"],
    [1.5, "00:00:13.33 (13.33 s)"],
    [1.75, "00:00:11.43 (11.43 s)"],
    [2, "00:00:10 (10 s)"],
  ])("baseline 20 s at %sx is shown as %s", (speed, text) => {
    expect(formatOutputDuration(previewOutputSeconds(20, speed))).toBe(text);
  });

  it("rounds for display without overflowing into 60 seconds", () => {
    expect(formatOutputDuration(59.999)).toBe("00:01:00 (60 s)");
    expect(formatOutputDuration(3599.996)).toBe("01:00:00 (3600 s)");
  });
});

describe("audio speed choice", () => {
  it("offers the seven speeds as one radio group with 1x selected", async () => {
    await openForm();
    const radios = within(speedGroup()).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["0.5", "0.75", "1", "1.25", "1.5", "1.75", "2"]);
    expect(radios.map((r) => r.checked)).toEqual([false, false, true, false, false, false, false]);
    // Every option has an accessible name, and they share a group name so one is chosen at a time.
    expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
      "0.5x",
      "0.75x",
      "1x",
      "1.25x",
      "1.5x",
      "1.75x",
      "2x",
    ]);
    expect(new Set(radios.map((r) => r.name))).toEqual(new Set(["speed"]));
  });

  it("puts the speed choice after the timestamps and explains that other speeds change the file", async () => {
    const user = await openForm();
    const group = speedGroup();
    const last = screen.getByLabelText("Last Sentence Start Time");
    expect(last.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await fillTimes(user);
    expect(preview().textContent).not.toContain("downloaded file itself changes");
    await user.click(screen.getByLabelText("1.5x"));
    expect(preview().textContent).toContain("The downloaded file itself changes.");
  });

  it("shows nothing computed until both timestamps are valid", async () => {
    const user = await openForm();
    expect(preview().textContent).toContain("Enter both start times");
    expect(preview().textContent).toContain("—");
    await user.type(screen.getByLabelText("First Sentence Start Time"), "00:00:05");
    await user.type(screen.getByLabelText("Last Sentence Start Time"), "00:00:05"); // not later
    expect(preview().textContent).toContain("Enter both start times");
    expect(preview().textContent).not.toContain("00:00:00");
  });

  it("updates the preview at once when the timestamps or the speed change", async () => {
    const user = await openForm();
    await fillTimes(user);
    const length = () => preview().querySelector(".length-value")?.textContent;
    expect(preview().textContent).toContain("00:00:20 at 1x");
    expect(length()).toBe("00:00:20");
    expect(preview().textContent).not.toContain("shorter");

    await user.click(screen.getByLabelText("1.25x"));
    expect(length()).toBe("00:00:16");
    expect(preview().textContent).toContain("the audio will be shorter than the time between");

    await user.click(screen.getByLabelText("0.75x"));
    expect(length()).toBe("00:00:26.67");
    expect(preview().textContent).toContain("the audio will be longer than the time between");

    // Changing a timestamp recomputes with the speed kept.
    await user.clear(screen.getByLabelText("Last Sentence Start Time"));
    await user.type(screen.getByLabelText("Last Sentence Start Time"), "00:00:35");
    expect(preview().textContent).toContain("00:00:30 at 1x");
    expect(length()).toBe("00:00:40");
  });

  it("does not put FFmpeg or sample details in the input flow", async () => {
    const user = await openForm();
    await fillTimes(user);
    await user.click(screen.getByLabelText("1.75x"));
    const form = screen.getByRole("button", { name: "Generate audio" }).closest("form");
    expect(form?.textContent).not.toMatch(/ffmpeg|atempo|samples|tempo/i);
  });

  it("moves between the speeds with the keyboard, one at a time", async () => {
    const user = await openForm();
    const one = screen.getByLabelText("1x") as HTMLInputElement;
    one.focus();
    await user.keyboard("{ArrowRight}");
    expect((screen.getByLabelText("1.25x") as HTMLInputElement).checked).toBe(true);
    expect(one.checked).toBe(false);
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect((screen.getByLabelText("2x") as HTMLInputElement).checked).toBe(true);
    const checked = within(speedGroup())
      .getAllByRole("radio")
      .filter((r) => (r as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
  });

  it("sends 1 when the user did not touch the speed", async () => {
    const user = await openForm();
    await fillTimes(user);
    await user.click(screen.getByRole("button", { name: "Generate audio" }));
    await screen.findByText(/Planned audio length/);
    expect(created).toHaveLength(1);
    expect(created[0]?.speed).toBe(1);
    expect(typeof created[0]?.speed).toBe("number");
  });

  it.each(AUDIO_SPEEDS)("sends the chosen speed %s as a number", async (speed) => {
    const user = await openForm();
    await fillTimes(user);
    await user.click(screen.getByLabelText(speedLabel(speed)));
    await user.click(screen.getByRole("button", { name: "Generate audio" }));
    await screen.findByText(/Planned audio length/);
    expect(created[0]?.speed).toBe(speed);
    // Only the choice is sent; the output length is the server's to calculate.
    expect(Object.keys(created[0] ?? {}).sort()).toEqual([
      "first_sentence_start",
      "last_sentence_start",
      "speed",
      "transcript",
      "voice",
    ]);
  });

  it("keeps showing the speed a job was submitted with when the form changes afterwards", async () => {
    const user = await openForm();
    await fillTimes(user);
    await user.click(screen.getByLabelText("1.5x"));
    await user.click(screen.getByRole("button", { name: "Generate audio" }));

    const status = await screen.findByText(/Planned audio length/);
    expect(status.textContent).toContain("Speed 1.5x");
    expect(status.textContent).toContain("Planned audio length 00:00:13.33");

    await user.click(screen.getByLabelText("2x"));
    expect((screen.getByLabelText("2x") as HTMLInputElement).checked).toBe(true);
    // The job panel shows what the server stored for that job, not the form.
    const after = screen.getByText(/Planned audio length/);
    expect(after.textContent).toContain("Speed 1.5x");
    expect(after.textContent).not.toContain("Speed 2x");
  });
});

// --- result ----------------------------------------------------------------------------------

function adjustedResult(speed: number, targetSamples: number, baseline = 20) {
  const target = targetSamples / 24000;
  return {
    job_id: "j1",
    baseline_duration_seconds: baseline,
    speed,
    output_duration_seconds: baseline / speed,
    translation: { text: "Xin chào", is_illustrative: false, provider: "azure-translator" },
    audio: {
      url: "/api/jobs/j1/result/audio",
      download_url: "/api/jobs/j1/result/audio?download=1",
      content_type: "audio/mpeg",
      provider: "azure-speech",
      is_fixture: false,
      duration_adjusted: true,
      duration: {
        sample_rate: 24000,
        target_seconds: target,
        target_samples: targetSamples,
        baseline_seconds: baseline,
        speed,
        source_seconds: 21.5,
        source_samples: 516000,
        processed_seconds: target,
        processed_samples: targetSamples,
        mp3_decoded_seconds: target,
        mp3_decoded_samples: targetSamples,
        mp3_header_seconds: target,
        mp3_header_samples: targetSamples,
        mp3_container_seconds: target + 0.048,
        tempo_factor: 516000 / targetSamples,
        padded_samples: 12,
        trimmed_samples: 0,
        mp3_padding_adjusted_samples: 0,
      },
    },
    expires_at: "2030-01-01T00:00:00Z",
    notices: ["Audio speed 1.75x: the audio is the baseline duration divided by 1.75x."],
  };
}

function stubResult(result: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/result")) return json(result);
      throw new Error(`Unexpected request: ${String(input)}`);
    }),
  );
}

describe("result of a job with a speed", () => {
  it("shows baseline, speed, target and the verified actual duration", async () => {
    stubResult(adjustedResult(1.75, 274286));
    render(<ResultView jobId="j1" voiceLabel="Andrew Multilingual" onSessionExpired={() => {}} />);
    await screen.findByText("Vietnamese translation");

    const text = screen.getByLabelText("Audio duration").textContent ?? "";
    expect(text).toContain("Baseline 20.000000 s");
    expect(text).toContain("Speed 1.75x");
    expect(text).toContain("Target 11.428583 s"); // 274286 / 24000, unrounded
    expect(text).toContain("Actual 11.428583 s");
    expect(text).toContain("274,286 samples");
  });

  it("a speed of 1x also shows its baseline and speed", async () => {
    stubResult(adjustedResult(1, 480000));
    render(<ResultView jobId="j1" voiceLabel="Andrew Multilingual" onSessionExpired={() => {}} />);
    await screen.findByText("Vietnamese translation");
    const text = screen.getByLabelText("Audio duration").textContent ?? "";
    expect(text).toContain("Baseline 20.000000 s · Speed 1x · Target 20.000000 s");
  });

  it("does not speed the player up a second time: the file is already processed", async () => {
    stubResult(adjustedResult(2, 240000));
    const { container } = render(<ResultView jobId="j1" voiceLabel="Andrew Multilingual" onSessionExpired={() => {}} />);
    await screen.findByText("Vietnamese translation");

    const player = container.querySelector("audio") as HTMLAudioElement;
    expect(player.playbackRate).toBe(1);
    expect(player.defaultPlaybackRate).toBe(1);
    expect(player.getAttribute("src")).toBe("/api/jobs/j1/result/audio");
  });

  it("a mock result records the selection without claiming a processed file", async () => {
    const mock = adjustedResult(1.5, 320000);
    mock.audio = {
      ...mock.audio,
      provider: "mock-speech",
      is_fixture: true,
      duration_adjusted: false,
      duration: null as never,
    };
    stubResult(mock);
    render(<ResultView jobId="j1" voiceLabel="Andrew Multilingual" onSessionExpired={() => {}} />);
    await screen.findByText("Vietnamese translation");

    expect(screen.queryByLabelText("Audio duration")).toBeNull();
    const note = screen.getByLabelText("Audio speed").textContent ?? "";
    expect(note).toContain("Selected speed 1.5x");
    expect(note).toContain("planned length 00:00:13.33");
    expect(note).toContain("This audio was not adjusted");
    expect(screen.getByText("Duration not adjusted", { selector: ".chip" })).toBeTruthy();
  });

  it("reports a corrected MP3 header when there was one", async () => {
    const result = adjustedResult(1.75, 68571, 5);
    result.audio.duration.mp3_padding_adjusted_samples = 20;
    stubResult(result);
    render(<ResultView jobId="j1" voiceLabel="Andrew Multilingual" onSessionExpired={() => {}} />);
    await screen.findByText("Vietnamese translation");
    const text = screen.getByLabelText("Audio duration").textContent ?? "";
    expect(text).toContain("20 samples added to the end padding");
  });
});
