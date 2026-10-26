// The YouTube caption import and timed mode together: an imported transcript goes through the
// same timing detection as a pasted one, and timing always follows what the box holds now.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import { META, always, installAuthFetch, json, meResponse } from "./test/authFetch.testkit";

let fake: ReturnType<typeof installAuthFetch>;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  expect(fake?.unexpected ?? []).toEqual([]);
});

type User = ReturnType<typeof userEvent.setup>;
type Routes = Parameters<typeof installAuthFetch>[0];

const IMPORTED = "0:10.480\nWelcome back.\n0:12.960\nGradient descent, step by step.\n6:10.999\nBye!";
const RESULT = {
  transcript: IMPORTED,
  language: "en",
  caption_count: 3,
  skipped_empty_captions: 0,
  first_caption_start_ms: 10_480,
  last_caption_start_ms: 370_999,
  first_sentence_start: "00:00:10",
  last_sentence_start: "00:06:10",
  provider: "supadata",
};
const JOB = {
  id: "job-1",
  status: "queued",
  voice: "AndrewMultilingual",
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

function setup(routes: Routes) {
  fake = installAuthFetch({
    "GET /api/meta": [
      () => json(200, { ...META, youtube_import: { enabled: true, provider: "supadata" } }),
    ],
    "GET /api/auth/me": [meResponse()],
    "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    ...routes,
  });
  return { ...render(<App />), user: userEvent.setup() };
}

const transcript = () => screen.getByLabelText("English Transcript") as HTMLTextAreaElement;
const first = () => screen.getByLabelText("First Sentence Start Time") as HTMLInputElement;
const last = () => screen.getByLabelText("Last Sentence Start Time") as HTMLInputElement;
const panel = () => screen.getByLabelText("Transcript timing").textContent ?? "";
const generate = () => screen.getByRole("button", { name: "Generate audio" });

async function importCaptions(user: User) {
  await screen.findByText("Ada");
  await user.click(screen.getByRole("radio", { name: "YouTube URL" }));
  await user.type(screen.getByLabelText("YouTube video link"), "https://youtu.be/dQw4w9WgXcQ");
  await user.click(screen.getByRole("button", { name: "Import transcript" }));
  await waitFor(() => expect(transcript().value).not.toBe(""));
}

describe("an imported transcript in timed mode", () => {
  it("is recognized like a pasted one and sent as timed, with milliseconds kept", async () => {
    const { user } = setup({
      "POST /api/transcripts/youtube": [() => json(200, RESULT)],
      "POST /api/jobs": [() => json(202, JOB)],
    });
    await importCaptions(user);

    expect(transcript().value).toBe(IMPORTED);
    expect(first().value).toBe("00:00:10");
    expect(last().value).toBe("00:06:10");
    expect(panel()).toContain("Timestamps detected: 3 captions from 0:10.480 to 6:10.999");
    expect(panel()).toContain("filled from the first and last caption (whole seconds)");
    expect(panel()).not.toContain("You changed the start times");

    await user.click(generate());
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({
      transcript: IMPORTED,
      first_sentence_start: "00:00:10",
      last_sentence_start: "00:06:10",
      timing_mode: "timed",
    });
  });

  it("follows the edited captions, not the imported ones", async () => {
    const { user } = setup({
      "POST /api/transcripts/youtube": [() => json(200, RESULT)],
      "POST /api/jobs": [() => json(202, JOB)],
    });
    await importCaptions(user);

    // The user removes the last caption: the times come from what the box holds now.
    const edited = "0:10.480\nWelcome back.\n0:12.960\nGradient descent, step by step.";
    await user.clear(transcript());
    await user.click(transcript());
    await user.paste(edited);

    expect(panel()).toContain("2 captions from 0:10.480 to 0:12.960");
    expect(first().value).toBe("00:00:10");
    expect(last().value).toBe("00:00:12");

    await user.click(generate());
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({
      transcript: edited,
      last_sentence_start: "00:00:12",
      timing_mode: "timed",
    });
  });

  it("keeps times the user set after the import", async () => {
    const { user } = setup({ "POST /api/transcripts/youtube": [() => json(200, RESULT)] });
    await importCaptions(user);
    await user.clear(last());
    await user.type(last(), "000700");

    expect(last().value).toBe("00:07:00");
    expect(panel()).toContain("caption timing is scaled to 00:06:50");
    // Typing in the text without changing the first or last caption keeps the user's times.
    await user.type(transcript(), " Thanks.");
    expect(last().value).toBe("00:07:00");
  });

  it("asks for the times when the first and last caption start in the same second", async () => {
    const sameSecond = "0:10.100\nHello there.\n0:10.900\nAnd goodbye.";
    const { user } = setup({
      "POST /api/transcripts/youtube": [
        () =>
          json(200, {
            ...RESULT,
            transcript: sameSecond,
            caption_count: 2,
            first_caption_start_ms: 10_100,
            last_caption_start_ms: 10_900,
            first_sentence_start: null,
            last_sentence_start: null,
          }),
      ],
    });
    await importCaptions(user);

    expect(first().value).toBe("");
    expect(last().value).toBe("");
    expect(panel()).toContain("within the same second");
    expect(panel()).toContain("enter them");
  });

  it("can still be processed as plain text", async () => {
    const { user } = setup({
      "POST /api/transcripts/youtube": [() => json(200, RESULT)],
      "POST /api/jobs": [() => json(202, JOB)],
    });
    await importCaptions(user);
    await user.click(screen.getByLabelText(/Ignore the timestamps/));
    await user.click(generate());

    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).not.toHaveProperty("timing_mode");
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({ transcript: IMPORTED });
  });
});
