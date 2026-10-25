import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import { ResultView } from "./features/jobs/ResultView";
import {
  USER,
  always,
  authenticated,
  installAuthFetch,
  json,
  meResponse,
  meta,
  notAuthenticated,
} from "./test/authFetch.testkit";

let fake: ReturnType<typeof installAuthFetch> | undefined;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  expect(fake?.unexpected ?? []).toEqual([]);
  fake = undefined;
});

type Routes = Parameters<typeof installAuthFetch>[0];

const YOUTUBE = [
  "0:00",
  "Generally, if if somebody's trying to",
  "0:01",
  "make a company work, they should expect",
  "0:03",
  "to grind super hard. Uh except that",
  "0:05",
  "there's like some meaningful chance of",
  "0:06",
  "failure. I could not make a spaceship by",
  "0:08",
  "myself, but but uh with a collection of",
  "0:11",
  "humans, uh we can make spaceships. It's",
].join("\n");

const JOB = {
  id: "job-1",
  status: "queued",
  voice: "AndrewMultilingual",
  first_sentence_start: "00:00:00",
  last_sentence_start: "00:00:11",
  target_duration_seconds: 11,
  target_duration: "00:00:11",
  baseline_duration_seconds: 11,
  speed: 1,
  output_duration_seconds: 11,
  created_at: "2030-01-01T00:00:00Z",
  updated_at: "2030-01-01T00:00:00Z",
  completed_at: null,
  result_expires_at: null,
  error: null,
};
const SUBMIT = {
  "POST /api/jobs": [() => json(202, JOB)],
  "GET /api/jobs/job-1": [always(() => json(200, JOB))],
};

function setup(routes: Routes = {}) {
  fake = installAuthFetch({
    "GET /api/meta": [meta],
    "GET /api/auth/me": [meResponse()],
    ...routes,
  });
  return { ...render(<App />), user: userEvent.setup() };
}

const transcript = () => screen.getByLabelText("English Transcript") as HTMLTextAreaElement;
const first = () => screen.getByLabelText("First Sentence Start Time") as HTMLInputElement;
const last = () => screen.getByLabelText("Last Sentence Start Time") as HTMLInputElement;
const preview = () => screen.getByLabelText("Audio length preview").textContent ?? "";
const panel = () => screen.getByLabelText("Transcript timing").textContent ?? "";
const ignore = () => screen.getByLabelText(/Ignore the timestamps/) as HTMLInputElement;
const generate = () => screen.getByRole("button", { name: "Generate audio" });

async function paste(user: ReturnType<typeof userEvent.setup>, text: string) {
  await screen.findByText("Ada");
  await user.click(transcript());
  await user.paste(text);
}

async function clearAndType(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLInputElement,
  digits: string,
) {
  await user.clear(field);
  await user.type(field, digits);
}

describe("a transcript with timestamps", () => {
  it("fills both start times from the first and last caption and says so", async () => {
    const { user } = setup();
    await paste(user, YOUTUBE);

    expect(first().value).toBe("00:00:00");
    expect(last().value).toBe("00:00:11");
    expect(panel()).toContain("Timestamps detected: 7 captions from 0:00 to 0:11");
    expect(panel()).toContain("some sentences may be grouped together");
    expect(preview()).toContain("00:00:11 at 1x");
  });

  it("sends the transcript as timed, with the filled times", async () => {
    const { user } = setup(SUBMIT);
    await paste(user, YOUTUBE);
    await user.click(generate());

    await waitFor(() => expect(fake?.to("/api/jobs")).toHaveLength(1));
    expect(fake?.to("/api/jobs")[0]?.body).toEqual({
      transcript: YOUTUBE,
      first_sentence_start: "00:00:00",
      last_sentence_start: "00:00:11",
      voice: "AndrewMultilingual",
      speed: 1,
      timing_mode: "timed",
    });
  });

  it("keeps the user's own times while the transcript is edited, and can restore them", async () => {
    const { user } = setup(SUBMIT);
    await paste(user, YOUTUBE);
    await clearAndType(user, last(), "000022");

    expect(panel()).toContain("caption timing is scaled to 00:00:22");
    expect(preview()).toContain("00:00:22 at 1x");

    // More typing in the transcript (same first and last caption) does not refill the fields.
    await user.type(transcript(), " Really.");
    expect(last().value).toBe("00:00:22");

    await user.click(generate());
    await waitFor(() => expect(fake?.to("/api/jobs")).toHaveLength(1));
    expect(fake?.to("/api/jobs")[0]?.body).toMatchObject({
      last_sentence_start: "00:00:22",
      timing_mode: "timed",
    });

    await user.click(screen.getByRole("button", { name: "Use the transcript times" }));
    expect(last().value).toBe("00:00:11");
    expect(panel()).not.toContain("scaled");
  });

  it("refills the times when a transcript with other captions is pasted", async () => {
    const { user } = setup();
    await paste(user, YOUTUBE);
    await clearAndType(user, first(), "000003");
    await user.clear(transcript());
    await user.paste("1:00\nHello there.\n1:30\nGoodbye now.");

    expect(first().value).toBe("00:01:00");
    expect(last().value).toBe("00:01:30");
  });

  it("can be processed as plain text instead", async () => {
    const { user } = setup(SUBMIT);
    await paste(user, YOUTUBE);
    await user.click(ignore());

    expect(panel()).toContain("Timestamps detected but ignored");
    await user.click(generate());
    await waitFor(() => expect(fake?.to("/api/jobs")).toHaveLength(1));
    expect(fake?.to("/api/jobs")[0]?.body).not.toHaveProperty("timing_mode");
  });
});

describe("timestamps that cannot be used", () => {
  const BACKWARDS = "0:00\nOne.\n0:05\nTwo.\n0:03\nThree.";

  it("explains the problem and fills nothing", async () => {
    const { user } = setup();
    await paste(user, BACKWARDS);

    expect(screen.getByText(/The timestamps cannot be used/).parentElement?.textContent).toContain(
      "go backwards (0:05 is followed by 0:03)",
    );
    expect(first().value).toBe("");
    expect(last().value).toBe("");
  });

  it("leaves the decision to the server unless the user picks plain text", async () => {
    const { user } = setup({
      "POST /api/jobs": [
        () =>
          json(422, {
            error: {
              code: "validation_error",
              message: "The request contains invalid fields.",
              fields: [{ field: "transcript", message: "The timestamps go backwards." }],
            },
          }),
        () => json(202, JOB),
      ],
      "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    });
    await paste(user, BACKWARDS);
    await user.type(first(), "000000");
    await user.type(last(), "000005");
    await user.click(generate());

    await screen.findByText("The timestamps go backwards.");
    expect(fake?.to("/api/jobs")[0]?.body).toMatchObject({ timing_mode: "timed" });

    await user.click(ignore());
    await user.click(generate());
    await waitFor(() => expect(fake?.to("/api/jobs")).toHaveLength(2));
    expect(fake?.to("/api/jobs")[1]?.body).not.toHaveProperty("timing_mode");
  });
});

describe("other transcripts keep the current form", () => {
  it("plain text shows no timing panel and is sent as before", async () => {
    const { user } = setup(SUBMIT);
    await paste(user, "Spring Boot uses JSON.");
    expect(screen.queryByLabelText("Transcript timing")).toBeNull();
    await user.type(first(), "000010");
    await user.type(last(), "000610");
    await user.click(generate());
    await waitFor(() => expect(fake?.to("/api/jobs")).toHaveLength(1));
    expect(fake?.to("/api/jobs")[0]?.body).not.toHaveProperty("timing_mode");
  });

  it("SRT is accepted as plain text and says its timing is not used yet", async () => {
    const { user } = setup();
    await paste(user, "1\n00:00:01,000 --> 00:00:03,000\nHello.");
    expect(screen.getByText(/SRT\/WebVTT timing is not used yet/)).toBeTruthy();
    expect(first().value).toBe("");
  });
});

describe("the draft after the session expires", () => {
  it("brings back the user's edited times without refilling them", async () => {
    const { user } = setup({
      "POST /api/jobs": [notAuthenticated],
      "POST /api/auth/login": [authenticated(USER, "csrf-2")],
    });
    await paste(user, YOUTUBE);
    await clearAndType(user, last(), "000020");
    await user.click(generate());
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });

    await user.type(screen.getByLabelText("Email", { selector: "input" }), "x@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Ada");

    expect(transcript().value).toBe(YOUTUBE);
    expect(first().value).toBe("00:00:00");
    expect(last().value).toBe("00:00:20");
    expect(panel()).toContain("scaled to 00:00:20");
  });
});

describe("the result of a timed job", () => {
  it("says the caption timing is estimated and lists how it was used", async () => {
    const result = {
      job_id: "j1",
      baseline_duration_seconds: 11,
      speed: 1.5,
      output_duration_seconds: 11 / 1.5,
      translation: { text: "Một\nHai\nBa", is_illustrative: false, provider: "azure-translator" },
      audio: {
        url: "/api/jobs/j1/result/audio",
        download_url: "/api/jobs/j1/result/audio?download=1",
        content_type: "audio/mpeg",
        provider: "azure-speech",
        is_fixture: false,
        duration_adjusted: true,
        duration: null,
      },
      expires_at: "2030-01-01T00:00:00Z",
      notices: ["Timed transcript: the speech follows the caption times."],
      timing: {
        mode: "timed",
        captions: 7,
        blocks: 3,
        source_first_seconds: 0,
        source_last_seconds: 11,
        source_baseline_seconds: 11,
        selected_baseline_seconds: 11,
        speech_requests: 1,
        frames: 2,
        removed_boundaries: 1,
        tempo_warning_level: 2,
        max_tempo_factor: 1.84,
        frames_over_warning_level: 0,
        estimated_max_displacement_seconds: 0.41,
        frame_details: [],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/result")) return json(200, result);
        throw new Error(`Unexpected request: ${String(input)}`);
      }),
    );
    render(<ResultView jobId="j1" voiceLabel="Andrew Multilingual" onSessionExpired={() => {}} />);
    await screen.findByText("Vietnamese translation");

    const note = screen.getByLabelText("Transcript timing").textContent ?? "";
    expect(note).toContain("3 sentence blocks in 2 parts");
    expect(note).toContain("Caption timing is estimated");
    const details = screen.getByLabelText("Caption timing").textContent ?? "";
    expect(details).toContain("7 (0:00 to 0:11)");
    expect(details).toContain("2 (1 block boundaries merged)");
    expect(details).toContain("1.84x");
    expect(details).toContain("0.41 s (estimated, not measured)");
  });
});
