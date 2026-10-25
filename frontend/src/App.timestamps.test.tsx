import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
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

let fake: ReturnType<typeof installAuthFetch>;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  expect(fake?.unexpected ?? []).toEqual([]);
});

type User = ReturnType<typeof userEvent.setup>;
type Routes = Parameters<typeof installAuthFetch>[0];

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

function setup(routes: Routes = {}) {
  fake = installAuthFetch({
    "GET /api/meta": [meta],
    "GET /api/auth/me": [meResponse()],
    ...routes,
  });
  return { ...render(<App />), user: userEvent.setup() };
}

const first = () => screen.getByLabelText("First Sentence Start Time") as HTMLInputElement;
const last = () => screen.getByLabelText("Last Sentence Start Time") as HTMLInputElement;
const preview = () => screen.getByLabelText("Audio length preview").textContent ?? "";
const generate = () => screen.getByRole("button", { name: "Generate audio" });

async function openStudio(user: User) {
  await screen.findByText("Ada");
  await user.type(screen.getByLabelText("English Transcript"), "Spring Boot uses JSON.");
}

const validationError = (field: string, message: string) => () =>
  json(422, {
    error: {
      code: "validation_error",
      message: "The request contains invalid fields.",
      fields: [{ field, message }],
    },
  });

describe("typing digits in the two start times", () => {
  it("shows the formatted value and previews the duration, without any other change", async () => {
    const { user } = setup();
    await openStudio(user);

    await user.type(first(), "000010");
    await user.type(last(), "000610");

    expect(first().value).toBe("00:00:10");
    expect(last().value).toBe("00:06:10");
    expect(preview()).toContain("00:06:00 at 1x");
  });

  it("previews nothing while a timestamp is still incomplete", async () => {
    const { user } = setup();
    await openStudio(user);

    await user.type(first(), "000010");
    await user.type(last(), "00061");

    expect(last().value).toBe("00:06:1");
    expect(preview()).toContain("Enter both start times");
  });

  it("sends the complete timestamps in the existing format", async () => {
    const { user } = setup({ "POST /api/jobs": [() => json(202, JOB)], "GET /api/jobs/job-1": [always(() => json(200, JOB))] });
    await openStudio(user);
    await user.type(first(), "000010");
    await user.type(last(), "000610");

    await user.click(generate());

    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).toEqual({
      transcript: "Spring Boot uses JSON.",
      first_sentence_start: "00:00:10",
      last_sentence_start: "00:06:10",
      voice: "AndrewMultilingual",
      speed: 1,
    });
  });

  it("sends a pasted timestamp in either format", async () => {
    const { user } = setup({ "POST /api/jobs": [() => json(202, JOB)], "GET /api/jobs/job-1": [always(() => json(200, JOB))] });
    await openStudio(user);
    await user.click(first());
    await user.paste("000010");
    await user.click(last());
    await user.paste("00:06:10");

    await user.click(generate());

    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({
      first_sentence_start: "00:00:10",
      last_sentence_start: "00:06:10",
    });
  });
});

describe("incomplete or invalid input", () => {
  it("sends an incomplete timestamp as typed and shows the error the server returns", async () => {
    const { user } = setup({
      "POST /api/jobs": [
        validationError(
          "first_sentence_start",
          "Timestamp must use the HH:MM:SS format, for example 00:06:10.",
        ),
      ],
    });
    await openStudio(user);
    await user.type(first(), "00001");
    await user.type(last(), "000610");

    await user.click(generate());

    const message = await screen.findByText(/must use the HH:MM:SS format/);
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({
      first_sentence_start: "00:00:1",
      last_sentence_start: "00:06:10",
    });
    expect(first().getAttribute("aria-invalid")).toBe("true");
    expect(first().getAttribute("aria-describedby")).toContain(message.id);
    expect(last().getAttribute("aria-invalid")).toBe("false");
  });

  it("does not turn 75 minutes into an hour, and does not clamp it", async () => {
    const { user } = setup({
      "POST /api/jobs": [
        validationError(
          "last_sentence_start",
          "Timestamp must use the HH:MM:SS format, for example 00:06:10.",
        ),
      ],
    });
    await openStudio(user);
    await user.type(first(), "000010");
    await user.type(last(), "007500");

    expect(last().value).toBe("00:75:00");
    expect(preview()).toContain("Enter both start times");

    await user.click(generate());

    await screen.findByText(/must use the HH:MM:SS format/);
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({ last_sentence_start: "00:75:00" });
  });

  it("does not turn 75 seconds into a minute, and does not clamp it", async () => {
    const { user } = setup();
    await openStudio(user);

    await user.type(first(), "000010");
    await user.type(last(), "000175");

    expect(last().value).toBe("00:01:75");
    expect(preview()).toContain("Enter both start times");
  });

  it("keeps requiring the last start to be later than the first", async () => {
    const { user } = setup({
      "POST /api/jobs": [
        validationError(
          "last_sentence_start",
          "Last Sentence Start Time must be later than First Sentence Start Time.",
        ),
      ],
    });
    await openStudio(user);
    await user.type(first(), "000610");
    await user.type(last(), "000010");
    expect(preview()).toContain("Enter both start times");

    await user.click(generate());

    expect(await screen.findByText(/must be later than First Sentence Start Time/)).toBeTruthy();
  });

  it("keeps a pasted text that is not a timestamp visible and sends it unchanged", async () => {
    const { user } = setup({
      "POST /api/jobs": [
        validationError(
          "first_sentence_start",
          "Timestamp must use the HH:MM:SS format, for example 00:06:10.",
        ),
      ],
    });
    await openStudio(user);
    await user.click(first());
    await user.paste("about 00:00:10");
    await user.type(last(), "000610");
    expect(first().value).toBe("about 00:00:10");

    await user.click(generate());

    await screen.findByText(/must use the HH:MM:SS format/);
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({ first_sentence_start: "about 00:00:10" });
  });
});

describe("hours with more than two digits", () => {
  it("keeps a pasted 100-hour timestamp whole, previews it and sends it", async () => {
    const { user } = setup({ "POST /api/jobs": [() => json(202, JOB)], "GET /api/jobs/job-1": [always(() => json(200, JOB))] });
    await openStudio(user);
    await user.click(first());
    await user.paste("100:00:10");
    await user.click(last());
    await user.paste("100:06:10");

    expect(first().value).toBe("100:00:10");
    expect(preview()).toContain("00:06:00 at 1x");

    await user.click(generate());

    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({
      first_sentence_start: "100:00:10",
      last_sentence_start: "100:06:10",
    });
  });

  it("previews a span that crosses into more than two hour digits", async () => {
    const { user } = setup();
    await openStudio(user);
    await user.type(first(), "995959");
    await user.click(last());
    await user.paste("100:00:00");

    expect(preview()).toContain("00:00:01 at 1x");
  });
});

describe("the draft after the session expires", () => {
  it("brings back the formatted timestamps, ready to edit, after signing in again", async () => {
    const { user } = setup({
      "POST /api/jobs": [notAuthenticated],
      "POST /api/auth/login": [authenticated(USER, "csrf-2")],
    });
    await openStudio(user);
    await user.type(first(), "000010");
    await user.type(last(), "0006");
    await user.click(generate());
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });

    await user.type(screen.getByLabelText("Email", { selector: "input" }), "x@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Ada");

    expect(first().value).toBe("00:00:10");
    expect(last().value).toBe("00:06");

    // The restored value is still edited as digits.
    await user.type(last(), "10");
    expect(last().value).toBe("00:06:10");
    expect(preview()).toContain("00:06:00 at 1x");
  });
});
