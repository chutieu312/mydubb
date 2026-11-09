import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import {
  META,
  OTHER_USER,
  accountUsage,
  always,
  apiError,
  authenticated,
  installAuthFetch,
  json,
  meResponse,
  noContent,
} from "./test/authFetch.testkit";

// The signed-in account's daily limits (Free plan): what the banner shows, when it is asked again
// (never by polling), which refusals the form tells apart, and answers that arrive after the
// account changed.

let fake: ReturnType<typeof installAuthFetch>;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  expect(fake?.unexpected ?? []).toEqual([]);
});

type Routes = Parameters<typeof installAuthFetch>[0];

const USAGE = "/api/account/usage";
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
const IMPORT_META = { ...META, youtube_import: { enabled: true, provider: "supadata" } };
const usage = (...args: Parameters<typeof accountUsage>) => () => json(200, accountUsage(...args));

function deferred() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => (release = resolve));
  return { handler: () => promise, release: (response: Response) => act(async () => release(response)) };
}

function setup(routes: Routes, meta: unknown = IMPORT_META) {
  fake = installAuthFetch({
    "GET /api/meta": [() => json(200, meta)],
    "GET /api/auth/me": [meResponse()],
    "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    ...routes,
  });
  return { ...render(<App />), user: userEvent.setup() };
}

const banner = () => screen.getByRole("region", { name: "Your plan" });
const usageRequests = () => fake.to(USAGE);
const jobPosts = () => fake.requests.filter((r) => r.method === "POST" && r.path === "/api/jobs");

async function fillForm(user: ReturnType<typeof userEvent.setup>, text = "Hello world.") {
  await user.type(screen.getByLabelText("English Transcript"), text);
  await user.type(screen.getByLabelText("First Sentence Start Time"), "000010");
  await user.type(screen.getByLabelText("Last Sentence Start Time"), "000610");
}

describe("the plan banner", () => {
  it("shows what is left today, the per-job limits and the UTC reset", async () => {
    setup({ [`GET ${USAGE}`]: [usage(3, 1)] });
    const region = await screen.findByRole("region", { name: "Your plan" });
    expect(region.textContent).toContain(
      "Free plan. 17 of 20 audio jobs left today · 4 of 5 YouTube imports left today.",
    );
    expect(region.textContent).toContain("Each job: up to 1,000 words and 10 minutes of audio.");
    expect(region.textContent).toContain("even if it fails later");
    expect(region.textContent).toContain("Counts start again at 00:00 UTC (");
    expect(usageRequests()).toHaveLength(1);
  });

  it("does not mention imports when the server offers none", async () => {
    setup({ [`GET ${USAGE}`]: [usage(0, 0)] }, META);
    expect((await screen.findByRole("region", { name: "Your plan" })).textContent).toContain(
      "Free plan. 20 of 20 audio jobs left today.",
    );
    expect(banner().textContent).not.toContain("YouTube");
  });

  it("says when today's jobs are used up", async () => {
    setup({ [`GET ${USAGE}`]: [usage(20, 5)] });
    const region = await screen.findByRole("region", { name: "Your plan" });
    expect(within(region).getAllByRole("status").map((s) => s.textContent)).toEqual([
      "You have used today's 20 audio jobs. Jobs you started keep running and your audio stays available.",
      "You have used today's 5 YouTube imports. You can still paste a transcript.",
    ]);
  });

  it("shows no limits for an exempt account", async () => {
    setup({
      [`GET ${USAGE}`]: [
        usage(25, 0, {
          exempt: true,
          generate: { used: 25, limit: null, remaining: null },
          youtube_import: { used: 0, limit: null, remaining: null },
          max_words: null,
          max_output_seconds: null,
        }),
      ],
    });
    expect((await screen.findByRole("region", { name: "Your plan" })).textContent).toContain(
      "No daily MyDubb limits apply to your account. The server's capacity still does.",
    );
    expect(screen.queryByText(/of 1,000 words/)).toBeNull();
  });

  it("previews the plan's word and audio limits in the form", async () => {
    const { user } = setup({ [`GET ${USAGE}`]: [usage()] });
    await screen.findByRole("region", { name: "Your plan" });
    await user.type(screen.getByLabelText("English Transcript"), "one two three");
    expect(screen.getByText(/About 3 of 1,000 words/)).toBeTruthy();
    expect(screen.getByText(/Free plan audio can be at most 00:10:00 long/)).toBeTruthy();
  });
});

describe("refreshing the numbers", () => {
  it("asks again once after a job is accepted, never on its own", async () => {
    const { user } = setup({
      [`GET ${USAGE}`]: [usage(0), usage(1)],
      "POST /api/jobs": [() => json(202, JOB)],
    });
    await screen.findByRole("region", { name: "Your plan" });
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "Generate audio" }));
    await waitFor(() => expect(banner().textContent).toContain("19 of 20 audio jobs left today"));
    expect(usageRequests()).toHaveLength(2);
  });

  it("a quota refusal shows the server's words and refreshes the numbers, without retrying", async () => {
    const message =
      "Your Free plan includes 20 audio jobs a day, and today's are used up. Jobs you already started keep running and your finished audio stays available. You can generate again after 00:00 UTC.";
    const { user } = setup({
      [`GET ${USAGE}`]: [usage(19), usage(20)],
      "POST /api/jobs": [() => apiError(429, "daily_generate_quota_exhausted", message, { "Retry-After": "3600" })],
    });
    await screen.findByRole("region", { name: "Your plan" });
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "Generate audio" }));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    await waitFor(() => expect(banner().textContent).toContain("0 of 20 audio jobs left today"));
    expect(jobPosts()).toHaveLength(1);
  });

  it.each([
    ["generate_daily_cap_reached", 503, "MyDubb has reached today's limit on new audio jobs, shared by all users."],
    ["server_at_capacity", 503, "The server is already processing the maximum number of jobs it can handle."],
  ])("%s is shown as the server words it and sent once", async (code, status, message) => {
    const { user } = setup({
      [`GET ${USAGE}`]: [usage(2)],
      "POST /api/jobs": [() => apiError(status, code, message, { "Retry-After": "30" })],
    });
    await screen.findByRole("region", { name: "Your plan" });
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "Generate audio" }));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(jobPosts()).toHaveLength(1);
    // Not the account's quota: the numbers are not asked again.
    expect(usageRequests()).toHaveLength(1);
  });

  it("asks again after an import ends, also when it failed", async () => {
    const { user } = setup({
      [`GET ${USAGE}`]: [usage(0, 0), usage(0, 1)],
      "POST /api/transcripts/youtube": [
        () => apiError(502, "youtube_import_failed", "The caption service failed."),
      ],
    });
    await screen.findByRole("region", { name: "Your plan" });
    await user.click(screen.getByRole("radio", { name: "YouTube URL" }));
    await user.type(screen.getByLabelText("YouTube video link"), "https://youtu.be/dQw4w9WgXcQ");
    await user.click(screen.getByRole("button", { name: "Import transcript" }));
    await waitFor(() => expect(banner().textContent).toContain("4 of 5 YouTube imports left today"));
    expect(usageRequests()).toHaveLength(2);
  });
});

describe("another account", () => {
  it("never shows the previous account's late numbers", async () => {
    const late = deferred();
    const { user } = setup({
      [`GET ${USAGE}`]: [late.handler, usage(7)],
      "POST /api/auth/logout": [noContent],
      "POST /api/auth/login": [authenticated(OTHER_USER, "csrf-2")],
    });
    await screen.findByText("Ada");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.type(await screen.findByLabelText("Email"), OTHER_USER.email);
    await user.type(screen.getByLabelText("Password"), "correct-horse-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(banner().textContent).toContain("13 of 20 audio jobs left today"));
    // The first account's answer arrives last: it is dropped.
    await late.release(json(200, accountUsage(0)));
    expect(banner().textContent).toContain("13 of 20 audio jobs left today");
    expect(usageRequests()).toHaveLength(2);
  });

  it("a signed-out page shows no plan", async () => {
    const { user } = setup({
      [`GET ${USAGE}`]: [usage(3)],
      "POST /api/auth/logout": [noContent],
    });
    await screen.findByRole("region", { name: "Your plan" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Email");
    expect(screen.queryByRole("region", { name: "Your plan" })).toBeNull();
  });
});

describe("the 00:00 UTC reset", () => {
  // The default snapshot resets at 2030-01-02T00:00:00Z; the page opens a minute before.
  const NEXT_DAY = { day: "2030-01-02", resets_at: "2030-01-03T00:00:00Z" };
  const nextDay = (generateUsed = 0) => usage(generateUsed, 0, NEXT_DAY);
  let visibility: DocumentVisibilityState = "visible";

  const startClock = () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2030-01-01T23:59:00Z"));
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const setVisibility = (state: DocumentVisibilityState) =>
    act(async () => {
      visibility = state;
      document.dispatchEvent(new Event("visibilitychange"));
    });
  const clockUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  afterEach(() => {
    vi.useRealTimers();
    // Back to jsdom's own getter.
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it("asks once when the reset instant passes and shows the new day's numbers", async () => {
    startClock();
    setup({ [`GET ${USAGE}`]: [usage(20, 5), nextDay(2)] });
    await waitFor(() => expect(banner().textContent).toContain("0 of 20 audio jobs left today"));
    await advance(30_000); // still the old day: nothing asked
    expect(usageRequests()).toHaveLength(1);
    await advance(40_000); // past 00:00 UTC (and the margin)
    // The server's numbers and reset instant, not 20/5 made up here.
    await waitFor(() => expect(banner().textContent).toContain("18 of 20 audio jobs left today"));
    expect(banner().textContent).toContain("5 of 5 YouTube imports left today");
    expect(usageRequests()).toHaveLength(2);
    await advance(3 * 3600_000); // no polling afterwards
    expect(usageRequests()).toHaveLength(2);
  });

  it("a background tab asks when it is back, once, even when timer and focus come together", async () => {
    startClock();
    const answer = deferred();
    setup({ [`GET ${USAGE}`]: [usage(20, 5), answer.handler] });
    await waitFor(() => expect(banner().textContent).toContain("0 of 20 audio jobs left today"));
    await setVisibility("hidden");
    await advance(2 * 3600_000); // the reset passes in the background (or the computer sleeps)
    expect(usageRequests()).toHaveLength(1);
    // The old numbers are not shown as today's meanwhile.
    expect(banner().textContent).toContain("A new day started at 00:00 UTC");
    expect(banner().textContent).not.toContain("0 of 20");
    await setVisibility("visible");
    await setVisibility("hidden");
    await setVisibility("visible"); // a second foreground event while the first ask is in flight
    expect(usageRequests()).toHaveLength(2);
    await answer.release(json(200, accountUsage(0, 0, NEXT_DAY)));
    await waitFor(() => expect(banner().textContent).toContain("20 of 20 audio jobs left today"));
    expect(usageRequests()).toHaveLength(2);
  });

  it("a timer of the previous account is gone after signing out", async () => {
    startClock();
    const user = clockUser();
    setup({
      [`GET ${USAGE}`]: [usage(20), usage(13, 0, NEXT_DAY)],
      "POST /api/auth/logout": [noContent],
      "POST /api/auth/login": [authenticated(OTHER_USER, "csrf-2")],
    });
    await waitFor(() => expect(banner().textContent).toContain("0 of 20 audio jobs left today"));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.type(await screen.findByLabelText("Email"), OTHER_USER.email);
    await user.type(screen.getByLabelText("Password"), "correct-horse-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(banner().textContent).toContain("7 of 20 audio jobs left today"));
    await advance(3600_000); // past the first account's reset instant
    expect(usageRequests()).toHaveLength(2);
    expect(banner().textContent).toContain("7 of 20 audio jobs left today");
  });

  it("a reset ask of the previous account that answers late never shows its quota", async () => {
    startClock();
    const user = clockUser();
    const late = deferred();
    setup({
      [`GET ${USAGE}`]: [usage(20), late.handler, usage(13, 0, NEXT_DAY)],
      "POST /api/auth/logout": [noContent],
      "POST /api/auth/login": [authenticated(OTHER_USER, "csrf-2")],
    });
    await waitFor(() => expect(banner().textContent).toContain("0 of 20 audio jobs left today"));
    await advance(70_000); // the reset ask is sent and stays in flight
    expect(usageRequests()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.type(await screen.findByLabelText("Email"), OTHER_USER.email);
    await user.type(screen.getByLabelText("Password"), "correct-horse-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(banner().textContent).toContain("7 of 20 audio jobs left today"));
    await late.release(json(200, accountUsage(1, 0, NEXT_DAY)));
    expect(banner().textContent).toContain("7 of 20 audio jobs left today");
    expect(usageRequests()).toHaveLength(3);
  });

  it("a failing ask or an answer still of the old day does not loop", async () => {
    startClock();
    setup({
      [`GET ${USAGE}`]: [
        usage(20),
        () => apiError(503, "internal_error", "Try later."),
        usage(20), // the old day again (the same reset instant)
      ],
    });
    await waitFor(() => expect(banner().textContent).toContain("0 of 20 audio jobs left today"));
    await advance(70_000); // the timer's ask fails
    await waitFor(() => expect(usageRequests()).toHaveLength(2));
    expect(banner().textContent).toContain("A new day started at 00:00 UTC");
    await setVisibility("hidden");
    await setVisibility("visible"); // one more ask when the page is back: still the old day
    await waitFor(() => expect(usageRequests()).toHaveLength(3));
    await advance(1000);
    expect(banner().textContent).toContain("A new day started at 00:00 UTC");
    expect(banner().textContent).not.toContain("0 of 20");
    // No more automatic asks: neither timers nor focus.
    await setVisibility("hidden");
    await setVisibility("visible");
    await advance(6 * 3600_000);
    expect(usageRequests()).toHaveLength(3);
  });
});
