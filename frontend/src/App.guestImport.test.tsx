import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import {
  META,
  always,
  apiError,
  authenticated,
  installAuthFetch,
  json,
  noContent,
  notAuthenticated,
} from "./test/authFetch.testkit";

// Guest YouTube import: its own quota next to the audio jobs, one request per click, the content
// limits after an import, and answers that arrive after the identity changed.

let fake: ReturnType<typeof installAuthFetch>;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Every request a test did not list fails here: no extra import, no extra refresh.
  expect(fake?.unexpected ?? []).toEqual([]);
});

type User = ReturnType<typeof userEvent.setup>;
type Routes = Parameters<typeof installAuthFetch>[0];

const IMPORT = "/api/transcripts/youtube";
const LINK = "https://youtu.be/dQw4w9WgXcQ";
const IMPORTED_TRANSCRIPT =
  "0:10.480\nWelcome back.\n0:12.960\nGradient descent, step by step.\n6:10.999\nBye!";
const RESULT = {
  transcript: IMPORTED_TRANSCRIPT,
  language: "en",
  caption_count: 3,
  skipped_empty_captions: 0,
  first_caption_start_ms: 10_480,
  last_caption_start_ms: 370_999,
  first_sentence_start: "00:00:10",
  last_sentence_start: "00:06:10",
  provider: "supadata",
};

const GUEST_META = {
  ...META,
  youtube_import: { enabled: true, provider: "supadata" },
  guest_access: {
    enabled: true,
    jobs_per_session: 5,
    jobs_per_ip: 20,
    ip_window_seconds: 86400,
    max_words: 1000,
    max_output_seconds: 600,
    session_ttl_seconds: 86400,
    imports_per_session: 5,
    imports_per_ip: 20,
  },
};

const counts = (overrides: Record<string, unknown> = {}) => ({
  session_limit: 5,
  session_used: 0,
  session_in_progress: 0,
  session_remaining: 5,
  ip_limit: 20,
  ip_used: 0,
  ip_in_progress: 0,
  ip_remaining: 20,
  ip_retry_after_seconds: null,
  ...overrides,
});
const guestBody = (
  imports: Record<string, unknown> | null = {},
  id = "g-1",
  csrf = "guest-csrf",
) => ({
  status: "guest",
  guest: { id },
  csrf_token: csrf,
  expires_at: "2030-01-01T00:00:00Z",
  quota: { ...counts(), ip_window_seconds: 86400, max_words: 1000, max_output_seconds: 600 },
  imports: imports === null ? null : counts(imports),
});
const guestSession =
  (imports: Record<string, unknown> | null = {}, id = "g-1") =>
  () =>
    json(200, guestBody(imports, id));

function deferred() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => (release = resolve));
  const handler = () => promise;
  return { handler, release: (response: Response) => act(async () => release(response)) };
}

function setup(routes: Routes, meta: unknown = GUEST_META) {
  fake = installAuthFetch({
    "GET /api/meta": [() => json(200, meta)],
    "GET /api/auth/me": [notAuthenticated],
    ...routes,
  });
  return { ...render(<App />), user: userEvent.setup() };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const transcript = () => screen.getByLabelText("English Transcript") as HTMLTextAreaElement;
const first = () => screen.getByLabelText("First Sentence Start Time") as HTMLInputElement;
const last = () => screen.getByLabelText("Last Sentence Start Time") as HTMLInputElement;
const banner = () => screen.getByRole("region", { name: "Guest mode" });
const imports = () => fake.requests.filter((r) => r.method === "POST" && r.path === IMPORT);
const refreshes = () => fake.to("/api/guest/session").filter((r) => r.method === "GET");

async function importLink(user: User) {
  await screen.findByRole("region", { name: "Guest mode" });
  await user.click(screen.getByRole("radio", { name: "YouTube URL" }));
  await user.type(screen.getByLabelText("YouTube video link"), LINK);
  await user.click(button("Import transcript"));
}

async function signInAccount(user: User) {
  await user.type(await screen.findByLabelText("Email", { selector: "input" }), "x@example.com");
  await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
  await user.click(button("Sign in"));
  await screen.findByRole("button", { name: "Sign out" });
}

describe("offering the import to a guest", () => {
  it("shows imports and audio jobs as two separate counts, and the limits before importing", async () => {
    const { user } = setup({ "GET /api/guest/session": [guestSession({ session_used: 1, session_remaining: 4 })] });
    await screen.findByRole("region", { name: "Guest mode" });
    expect(within(banner()).getByText(/5 audio jobs left/)).toBeTruthy();
    expect(within(banner()).getByText(/4 YouTube imports left · counted separately/)).toBeTruthy();
    expect(within(banner()).queryByText(/YouTube import needs an account/)).toBeNull();

    await user.click(screen.getByRole("radio", { name: "YouTube URL" }));
    const notice = document.getElementById("youtube-guest-limits")?.textContent ?? "";
    expect(notice).toContain("4 guest imports left, counted apart from your audio jobs");
    expect(notice).toContain("1,000 words and 00:10:00 of audio per job");
    expect(notice).toContain("the whole transcript is still imported");
    // Showing the field and typing a link sends nothing.
    await user.type(screen.getByLabelText("YouTube video link"), LINK);
    expect(imports()).toHaveLength(0);
  });

  it("is not offered when the server reports no import for guests", async () => {
    setup({ "GET /api/guest/session": [guestSession(null)] });
    await screen.findByRole("region", { name: "Guest mode" });
    expect(screen.queryByRole("radio", { name: "YouTube URL" })).toBeNull();
    expect(within(banner()).getByText(/YouTube import needs an account/)).toBeTruthy();
  });

  it("is not offered when the import is off on the server", async () => {
    setup(
      { "GET /api/guest/session": [guestSession()] },
      { ...GUEST_META, youtube_import: { enabled: false, provider: null } },
    );
    await screen.findByRole("region", { name: "Guest mode" });
    expect(screen.queryByRole("radio", { name: "YouTube URL" })).toBeNull();
  });
});

describe("a guest import", () => {
  it("fills the form, sends the guest CSRF token once, and refreshes only the import count", async () => {
    const { user } = setup({
      "GET /api/guest/session": [guestSession(), guestSession({ session_used: 1, session_remaining: 4 })],
      [`POST ${IMPORT}`]: [() => json(200, RESULT)],
    });
    await importLink(user);
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    expect([first().value, last().value]).toEqual(["00:00:10", "00:06:10"]);
    expect(imports()).toHaveLength(1);
    expect(imports()[0]?.headers["X-CSRF-Token"]).toBe("guest-csrf");
    expect(imports()[0]?.body).toEqual({ url: LINK });
    await waitFor(() => expect(within(banner()).getByText(/4 YouTube imports left/)).toBeTruthy());
    expect(within(banner()).getByText(/5 audio jobs left/)).toBeTruthy();
    // No job was created by importing.
    expect(fake.requests.some((r) => r.path === "/api/jobs")).toBe(false);
    expect(refreshes()).toHaveLength(2);
  });

  it("sends one request however often Import is pressed", async () => {
    const answer = deferred();
    const { user } = setup({
      "GET /api/guest/session": [guestSession(), guestSession({ session_used: 1, session_remaining: 4 })],
      [`POST ${IMPORT}`]: [answer.handler],
    });
    await importLink(user);
    await user.click(button("Importing…"));
    fireEvent.keyDown(screen.getByLabelText("YouTube video link"), { key: "Enter" });
    expect(imports()).toHaveLength(1);
    await answer.release(json(200, RESULT));
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    await waitFor(() => expect(refreshes()).toHaveLength(2));
    expect(imports()).toHaveLength(1);
  });

  it("explains a used-up import quota, keeps the form and still allows pasting", async () => {
    const message =
      "This guest session has used all 5 of its YouTube imports. You can still paste a transcript, or sign in with your invitation.";
    const { user } = setup({
      "GET /api/guest/session": [
        guestSession(),
        guestSession({ session_used: 5, session_remaining: 0 }),
      ],
      [`POST ${IMPORT}`]: [() => apiError(429, "guest_import_session_quota_exhausted", message)],
    });
    await importLink(user);
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(transcript().value).toBe("");
    await waitFor(() => expect(within(banner()).getByText(/0 YouTube imports left/)).toBeTruthy());
    expect(within(banner()).getAllByRole("status")[0]?.textContent).toContain(
      "used all 5 of its YouTube imports",
    );
    // Audio jobs are untouched, and pasting still works.
    expect(within(banner()).getByText(/5 audio jobs left/)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Paste transcript" }));
    fireEvent.change(transcript(), { target: { value: "Pasted text." } });
    expect(transcript().value).toBe("Pasted text.");
  });

  it("says a cancelled import may still count, and refreshes the count", async () => {
    const answer = deferred();
    const { user } = setup({
      "GET /api/guest/session": [
        guestSession(),
        guestSession({ session_in_progress: 1, session_remaining: 4 }),
      ],
      [`POST ${IMPORT}`]: [answer.handler],
    });
    await importLink(user);
    fireEvent.change(transcript(), { target: { value: "My own text." } });
    expect(screen.getByText(/Import cancelled because you edited the form/).textContent).toContain(
      "It may still count as one of your guest imports.",
    );
    await waitFor(() => expect(refreshes()).toHaveLength(2));
    // The late answer neither fills the form nor triggers another refresh or import.
    await answer.release(json(200, RESULT));
    expect(transcript().value).toBe("My own text.");
    expect(refreshes()).toHaveLength(2);
    expect(imports()).toHaveLength(1);
  });
});

describe("content limits after an import", () => {
  const LONG = Array.from({ length: 120 }, (_, i) => {
    const start = 480 + i * 3000;
    const minutes = Math.floor(start / 60000);
    const seconds = Math.floor((start % 60000) / 1000);
    const millis = start % 1000;
    const time = `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
    return `${time}\nCaption ${i} gradient gradient gradient gradient gradient gradient gradient gradient.`;
  }).join("\n");

  it("keeps the whole transcript, explains the limit and leaves Generate to the server", async () => {
    const message = "Guest jobs can have at most 1,000 words; this transcript has 1,200.";
    const { user } = setup({
      "GET /api/guest/session": [guestSession(), guestSession({ session_used: 1, session_remaining: 4 })],
      [`POST ${IMPORT}`]: [
        () =>
          json(200, {
            ...RESULT,
            transcript: LONG,
            caption_count: 120,
            first_caption_start_ms: 480,
            last_caption_start_ms: 357_480,
            first_sentence_start: "00:00:00",
            last_sentence_start: "00:05:57",
          }),
      ],
      "POST /api/jobs": [
        () =>
          json(422, {
            error: {
              code: "guest_word_limit_exceeded",
              message,
              fields: [{ field: "transcript", message }],
            },
          }),
      ],
    });
    await importLink(user);
    await waitFor(() => expect(transcript().value).toBe(LONG)); // nothing cut
    expect([first().value, last().value]).toEqual(["00:00:00", "00:05:57"]); // not clamped
    expect(screen.getByText(/Over the guest limits:/).parentElement?.textContent).toContain(
      "about 1,200 words (at most 1,000)",
    );
    expect(screen.getByText(/Nothing was cut and no time was changed/)).toBeTruthy();
    expect(button("Generate audio")).toHaveProperty("disabled", false);

    await user.click(button("Generate audio"));
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
    const create = fake.requests.find((r) => r.path === "/api/jobs");
    expect(create?.body?.transcript).toBe(LONG);
    expect(create?.body?.timing_mode).toBe("timed");
  });

  it("notes an audio length over the limit, which a faster speed can fix", async () => {
    const { user } = setup({
      "GET /api/guest/session": [guestSession(), guestSession({ session_used: 1, session_remaining: 4 })],
      [`POST ${IMPORT}`]: [
        () =>
          json(200, {
            ...RESULT,
            transcript: "0:00.480\nHello there.\n14:30.480\nGoodbye.",
            caption_count: 2,
            first_caption_start_ms: 480,
            last_caption_start_ms: 870_480,
            first_sentence_start: "00:00:00",
            last_sentence_start: "00:14:30",
          }),
      ],
    });
    await importLink(user);
    await waitFor(() => expect(last().value).toBe("00:14:30"));
    expect(screen.getByText(/Over the guest limits:/).parentElement?.textContent).toContain(
      "00:14:30 of audio (at most 00:10:00)",
    );
    await user.click(screen.getByRole("radio", { name: "2x" }));
    expect(screen.queryByText(/Over the guest limits:/)).toBeNull();
    expect(last().value).toBe("00:14:30");
  });

  it("submits the transcript as edited, with its milliseconds, timed or plain", async () => {
    const queued = {
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
    const { user } = setup({
      "GET /api/guest/session": [
        guestSession(),
        guestSession({ session_used: 1, session_remaining: 4 }),
        always(guestSession({ session_used: 1, session_remaining: 4 })),
      ],
      [`POST ${IMPORT}`]: [() => json(200, RESULT)],
      "POST /api/jobs": [() => json(202, queued), () => json(202, queued)],
      "GET /api/jobs/job-1": [always(() => json(200, queued))],
    });
    await importLink(user);
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    const edited = IMPORTED_TRANSCRIPT.replace("Bye!", "Goodbye, everyone!");
    fireEvent.change(transcript(), { target: { value: edited } });
    await user.click(button("Generate audio"));
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({
      transcript: edited,
      timing_mode: "timed",
      first_sentence_start: "00:00:10",
      last_sentence_start: "00:06:10",
    });
    await user.click(screen.getByRole("checkbox", { name: /Ignore the timestamps/ }));
    await user.click(button("Generate audio"));
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(2));
    const plain = fake.to("/api/jobs")[1]?.body;
    expect(plain?.transcript).toBe(edited);
    expect(plain && "timing_mode" in plain).toBe(false);
    expect(imports()).toHaveLength(1);
  });
});

describe("late import answers never act on a newer identity", () => {
  it("a late success after leaving guest mode fills nothing for the account", async () => {
    const answer = deferred();
    const { user } = setup({
      "GET /api/guest/session": [guestSession()],
      [`POST ${IMPORT}`]: [answer.handler],
      "DELETE /api/guest/session": [noContent],
      "POST /api/auth/login": [authenticated()],
    });
    await importLink(user);
    await user.click(button("Leave guest mode"));
    await signInAccount(user);

    await answer.release(json(200, RESULT));
    expect(transcript().value).toBe("");
    expect(screen.queryByText(/Imported 3 English captions/)).toBeNull();
    // No guest quota refresh for the account either.
    expect(refreshes()).toHaveLength(1);
  });

  it("a late 401 of a guest import does not sign out the account that signed in", async () => {
    const answer = deferred();
    const { user } = setup({
      "GET /api/guest/session": [guestSession()],
      [`POST ${IMPORT}`]: [answer.handler],
      "DELETE /api/guest/session": [noContent],
      "POST /api/auth/login": [authenticated()],
    });
    await importLink(user);
    await user.click(button("Leave guest mode"));
    await signInAccount(user);

    await answer.release(notAuthenticated());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText(/session has ended/)).toBeNull();
  });

  it("a late answer of the previous guest session neither fills nor recounts the new one", async () => {
    const answer = deferred();
    const { user } = setup({
      "GET /api/guest/session": [guestSession()],
      [`POST ${IMPORT}`]: [answer.handler],
      "DELETE /api/guest/session": [noContent],
      "POST /api/guest/session": [() => json(201, guestBody({}, "g-2", "csrf-2"))],
    });
    await importLink(user);
    await user.click(button("Leave guest mode"));
    await user.click(await screen.findByRole("button", { name: "Try as guest" }));
    await screen.findByRole("region", { name: "Guest mode" });

    await answer.release(json(200, RESULT));
    expect(transcript().value).toBe("");
    expect(within(banner()).getByText(/5 YouTube imports left/)).toBeTruthy();
    expect(refreshes()).toHaveLength(1);
  });

  it("restoring a guest session on reload imports nothing", async () => {
    setup({ "GET /api/guest/session": [guestSession({ session_used: 2, session_remaining: 3 })] });
    await screen.findByRole("region", { name: "Guest mode" });
    expect(within(banner()).getByText(/3 YouTube imports left/)).toBeTruthy();
    expect(imports()).toHaveLength(0);
  });
});
