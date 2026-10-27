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
  meResponse,
  noContent,
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

const GUEST_META = {
  ...META,
  youtube_import: { enabled: true, provider: "mock" },
  guest_access: {
    enabled: true,
    jobs_per_session: 5,
    jobs_per_ip: 20,
    ip_window_seconds: 86400,
    max_words: 1000,
    max_output_seconds: 600,
    session_ttl_seconds: 86400,
  },
};

const quota = (overrides: Record<string, unknown> = {}) => ({
  session_limit: 5,
  session_used: 0,
  session_in_progress: 0,
  session_remaining: 5,
  ip_limit: 20,
  ip_used: 0,
  ip_in_progress: 0,
  ip_remaining: 20,
  ip_window_seconds: 86400,
  ip_retry_after_seconds: null,
  max_words: 1000,
  max_output_seconds: 600,
  ...overrides,
});
const guestBody = (overrides: Record<string, unknown> = {}, id = "g-1", csrf = "guest-csrf") => ({
  status: "guest",
  guest: { id },
  csrf_token: csrf,
  expires_at: "2030-01-01T00:00:00Z",
  quota: quota(overrides),
});
const guestSession =
  (overrides: Record<string, unknown> = {}, status = 200, id = "g-1") =>
  () =>
    json(status, guestBody(overrides, id));

const JOB = {
  id: "job-1",
  status: "failed",
  voice: "AndrewMultilingual",
  first_sentence_start: "00:00:05",
  last_sentence_start: "00:00:25",
  target_duration_seconds: 20,
  target_duration: "00:00:20",
  baseline_duration_seconds: 20,
  speed: 1,
  output_duration_seconds: 20,
  created_at: "2030-01-01T00:00:00Z",
  updated_at: "2030-01-01T00:00:00Z",
  completed_at: null,
  result_expires_at: null,
  error: { code: "translation_unavailable", message: "Translation failed." },
};

function setup(routes: Routes, meta: unknown = GUEST_META) {
  fake = installAuthFetch({ "GET /api/meta": [() => json(200, meta)], ...routes });
  return { ...render(<App />), user: userEvent.setup() };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const transcript = () => screen.getByLabelText("English Transcript") as HTMLTextAreaElement;

async function fillForm(user: User, text = "Spring Boot uses JSON.") {
  fireEvent.change(await screen.findByLabelText("English Transcript"), {
    target: { value: text },
  });
  await user.type(screen.getByLabelText("First Sentence Start Time"), "00:00:05");
  await user.type(screen.getByLabelText("Last Sentence Start Time"), "00:00:25");
}

describe("Try as guest on the sign-in screen", () => {
  it("is not offered when the server does not offer it", async () => {
    setup({ "GET /api/auth/me": [notAuthenticated] }, META);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try as guest" })).toBeNull();
    expect(fake.requests.some((r) => r.path.startsWith("/api/guest"))).toBe(false);
  });

  it("starts a guest session and opens the Studio in guest mode without YouTube import", async () => {
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (release = resolve));
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      // Restore finds none; then the refreshes after submitting and when the job ended.
      "GET /api/guest/session": [notAuthenticated, guestSession(), guestSession()],
      "POST /api/guest/session": [
        async () => {
          await started;
          return json(201, guestBody());
        },
      ],
      "POST /api/jobs": [() => json(202, JOB)],
      "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    });
    await user.click(await screen.findByRole("button", { name: "Try as guest" }));
    expect(button("Starting guest session…")).toHaveProperty("disabled", true);
    release();

    const banner = await screen.findByRole("region", { name: "Guest mode" });
    expect(within(banner).getByText(
        /5 jobs left · up to 1,000 words and 10 minutes of audio per job/,
      )).toBeTruthy();
    expect(screen.getByText("Guest")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "YouTube URL" })).toBeNull();
    expect(screen.queryByText("YouTube URL")).toBeNull();

    await fillForm(user);
    await user.click(button("Generate audio"));
    await screen.findByText("Translation failed.");
    const create = fake.requests.find((r) => r.method === "POST" && r.path === "/api/jobs");
    expect(create?.headers["X-CSRF-Token"]).toBe("guest-csrf");
    // Nothing about the guest is written to persistent browser storage.
    expect(Object.keys(window.sessionStorage)).toEqual([]);
    expect(Object.keys(window.localStorage).filter((k) => k !== "mydubb-theme")).toEqual([]);
  });

  it("shows why a guest session could not start and stays on the sign-in screen", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [notAuthenticated],
      "POST /api/guest/session": [
        () =>
          apiError(
            429,
            "guest_sessions_exhausted",
            "Too many guest sessions were started recently from your network.",
          ),
        () => apiError(500, "internal_error", "Traceback with details"),
      ],
    });
    await user.click(await screen.findByRole("button", { name: "Try as guest" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Too many guest sessions were started recently",
    );
    await user.click(button("Try as guest"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "We could not start a guest session. Please try again.",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});

describe("a guest session on reload", () => {
  it("restores guest mode when there is no account session", async () => {
    setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession({ session_used: 2, session_remaining: 3 })],
    });
    const banner = await screen.findByRole("region", { name: "Guest mode" });
    expect(within(banner).getByText(/3 jobs left/)).toBeTruthy();
  });

  it("shows sign in when neither session exists", async () => {
    setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [notAuthenticated],
    });
    expect(await screen.findByRole("button", { name: "Try as guest" })).toBeTruthy();
  });

  it("never asks for a guest session when the account session is valid", async () => {
    setup({ "GET /api/auth/me": [meResponse()] });
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(fake.requests.some((r) => r.path.startsWith("/api/guest"))).toBe(false);
  });
});

describe("quota in the Studio", () => {
  it("refreshes the remaining jobs from the server when a job ends", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [
        guestSession(),
        guestSession({ session_in_progress: 1, session_remaining: 4 }),
        // The job failed: its place was given back.
        guestSession(),
      ],
      "POST /api/jobs": [() => json(202, JOB)],
      "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    await screen.findByText("Translation failed.");
    await waitFor(() =>
      expect(fake.to("/api/guest/session").filter((r) => r.method === "GET")).toHaveLength(3),
    );
    expect(screen.getByText(/5 jobs left/)).toBeTruthy();
  });

  it("explains a network quota and offers signing in with an invitation", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated, notAuthenticated],
      "GET /api/guest/session": [
        guestSession(),
        guestSession({ ip_used: 20, ip_remaining: 0, ip_retry_after_seconds: 7200 }),
        notAuthenticated,
      ],
      "POST /api/jobs": [
        () =>
          apiError(
            429,
            "guest_ip_quota_exhausted",
            "Guests on your network have used all 20 guest jobs allowed in 24 hours.",
          ),
      ],
      "DELETE /api/guest/session": [noContent],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Guests on your network have used all 20",
    );
    const banner = screen.getByRole("region", { name: "Guest mode" });
    await within(banner).findByText(/everyone on the same network shares this limit/);
    expect(within(banner).getByText(/One frees up in about 120 minutes/)).toBeTruthy();
    expect(within(banner).getByText(/0 jobs left/)).toBeTruthy();

    const signIns = screen.getAllByRole("button", { name: "Sign in with an invitation" });
    expect(signIns).toHaveLength(2); // in the banner and next to the error
    await user.click(signIns[0]!);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    const ended = fake.requests.find((r) => r.method === "DELETE");
    expect(ended?.headers["X-CSRF-Token"]).toBe("guest-csrf");
  });

  it("explains a used-up guest session", async () => {
    setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [
        guestSession({ session_used: 5, session_remaining: 0, ip_used: 5, ip_remaining: 15 }),
      ],
    });
    expect(
      await screen.findByText(/This guest session has used all 5 of its jobs/),
    ).toBeTruthy();
  });

  it("previews the word count without timestamps and warns over the limit", async () => {
    setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    fireEvent.change(transcript(), {
      target: { value: "0:00\nHello there friend —\n0:05\nsecond line" },
    });
    expect(screen.getByText(/About 5 of 1,000 words/)).toBeTruthy();
    fireEvent.change(transcript(), {
      target: { value: Array.from({ length: 1001 }, (_, i) => `w${i}`).join(" ") },
    });
    expect(screen.getByText(/About 1,001 of 1,000 words/).textContent).toContain("shorten it");
    // A preview only: the button stays enabled, the server decides.
    expect(button("Generate audio")).toHaveProperty("disabled", false);
  });
});

describe("identity changes never mix drafts or access", () => {
  it("leaving guest mode discards the guest draft before an account signs in", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
      "DELETE /api/guest/session": [noContent],
      "POST /api/auth/login": [authenticated()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    fireEvent.change(transcript(), { target: { value: "Guest draft text." } });
    await user.click(button("Leave guest mode"));
    await user.type(await screen.findByLabelText("Email", { selector: "input" }), "x@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(button("Sign in"));
    await screen.findByRole("button", { name: "Sign out" });
    expect(transcript().value).toBe("");
    expect(screen.queryByRole("region", { name: "Guest mode" })).toBeNull();
  });

  it("an expired guest session returns to sign in and the draft is not shown to an account", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
      "POST /api/jobs": [notAuthenticated],
      "POST /api/auth/login": [authenticated()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user, "Guest secret transcript.");
    await user.click(button("Generate audio"));
    expect(await screen.findByText(/Your guest session has ended/)).toBeTruthy();
    await user.type(screen.getByLabelText("Email", { selector: "input" }), "x@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(button("Sign in"));
    await screen.findByRole("button", { name: "Sign out" });
    expect(transcript().value).toBe("");
  });

  it("a new guest session does not get the previous guest session's draft", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
      "POST /api/jobs": [notAuthenticated],
      "POST /api/guest/session": [() => json(201, guestBody({}, "g-2", "csrf-2"))],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user, "First guest text.");
    await user.click(button("Generate audio"));
    await user.click(await screen.findByRole("button", { name: "Try as guest" }));
    await screen.findByRole("region", { name: "Guest mode" });
    expect(transcript().value).toBe("");
  });

  it("stays in guest mode when leaving fails", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
      "DELETE /api/guest/session": [() => apiError(503, "http_error", "Unavailable.")],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await user.click(button("Leave guest mode"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Leaving guest mode failed; your guest session is still active.",
    );
    expect(screen.getByRole("region", { name: "Guest mode" })).toBeTruthy();
  });
});

// A response the test releases when it chooses, to reproduce answers that arrive late.
function deferred() {
  let release: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((resolve) => (release = resolve));
  const handler = () => promise;
  return { handler, release: (response: Response) => act(async () => release(response)) };
}

const QUEUED = { ...JOB, status: "queued", error: null };

async function signInAccount(user: User) {
  await user.type(await screen.findByLabelText("Email", { selector: "input" }), "x@example.com");
  await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
  await user.click(button("Sign in"));
  await screen.findByRole("button", { name: "Sign out" });
}

describe("guest audio length limit", () => {
  it("previews the limit and warns when baseline / speed is over it, without blocking", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    expect(screen.getByText(/Guest audio can be at most 00:10:00 long\./)).toBeTruthy();
    // 5 minutes at 0.5x is exactly 10 minutes: allowed.
    await user.type(screen.getByLabelText("First Sentence Start Time"), "000000");
    await user.type(screen.getByLabelText("Last Sentence Start Time"), "000500");
    await user.click(screen.getByRole("radio", { name: "0.5x" }));
    expect(screen.queryByText(/Choose a shorter stretch/)).toBeNull();
    // One second more is over it.
    await user.clear(screen.getByLabelText("Last Sentence Start Time"));
    await user.type(screen.getByLabelText("Last Sentence Start Time"), "000501");
    expect(screen.getByText(/Choose a shorter stretch/)).toBeTruthy();
    expect(button("Generate audio")).toHaveProperty("disabled", false);
  });

  it("shows the server's refusal on the time field and keeps what was typed", async () => {
    const message = "Guest audio can be at most 10:00 long; this job would make 10:02.";
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
      "POST /api/jobs": [
        () =>
          json(422, {
            error: {
              code: "guest_duration_limit_exceeded",
              message,
              fields: [{ field: "last_sentence_start", message }],
            },
          }),
      ],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
    expect((screen.getByLabelText("Last Sentence Start Time") as HTMLInputElement).value).toBe(
      "00:00:25",
    );
  });

  it("is not shown to accounts", async () => {
    setup({ "GET /api/auth/me": [meResponse()] });
    await screen.findByRole("button", { name: "Sign out" });
    expect(screen.queryByText(/Guest audio can be at most/)).toBeNull();
  });
});

describe("late answers never act on a newer identity", () => {
  it("a late 401 of a guest quota refresh does not sign out the account that signed in", async () => {
    const refresh = deferred();
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession(), refresh.handler],
      "POST /api/jobs": [() => json(202, QUEUED)],
      "GET /api/jobs/job-1": [always(() => json(200, QUEUED))],
      "DELETE /api/guest/session": [noContent],
      "POST /api/auth/login": [authenticated()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    await waitFor(() => expect(fake.to("/api/guest/session")).toHaveLength(2));
    await user.click(button("Leave guest mode"));
    await signInAccount(user);

    await refresh.release(notAuthenticated());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText(/session has ended/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Guest mode" })).toBeNull();
  });

  it("a late quota of the previous guest session does not replace the new one", async () => {
    const refresh = deferred();
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession(), refresh.handler],
      "POST /api/jobs": [() => json(202, QUEUED)],
      "GET /api/jobs/job-1": [always(() => json(200, QUEUED))],
      "DELETE /api/guest/session": [noContent],
      "POST /api/guest/session": [() => json(201, guestBody({}, "g-2", "csrf-2"))],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    await waitFor(() => expect(fake.to("/api/guest/session")).toHaveLength(2));
    await user.click(button("Leave guest mode"));
    await user.click(await screen.findByRole("button", { name: "Try as guest" }));
    await screen.findByText(/5 jobs left/);

    await refresh.release(
      json(200, guestBody({ session_used: 4, session_remaining: 1 }, "g-1", "guest-csrf")),
    );
    expect(screen.getByText(/5 jobs left/)).toBeTruthy();
    expect(screen.queryByText(/1 job left/)).toBeNull();
  });

  it("a late 401 of a guest job submission does not sign out the account", async () => {
    const create = deferred();
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
      "POST /api/jobs": [create.handler],
      "DELETE /api/guest/session": [noContent],
      "POST /api/auth/login": [authenticated()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    await user.click(button("Leave guest mode"));
    await signInAccount(user);

    await create.release(notAuthenticated());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText(/session has ended/)).toBeNull();
  });

  it("a late success of a guest job submission shows no job to the account", async () => {
    const create = deferred();
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession()],
      "POST /api/jobs": [create.handler],
      "DELETE /api/guest/session": [noContent],
      "POST /api/auth/login": [authenticated()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    await user.click(button("Leave guest mode"));
    await signInAccount(user);

    await create.release(json(202, QUEUED));
    // No job panel (and no polling of the guest's job, which the stub would flag as unexpected).
    expect(screen.queryByRole("heading", { name: /Creating your audio/ })).toBeNull();
    expect(fake.requests.some((r) => r.path === "/api/jobs/job-1")).toBe(false);
  });

  it("a late answer to leaving guest mode does not sign out an account that signed in", async () => {
    const poll = deferred();
    const leave = deferred();
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [guestSession(), guestSession()],
      "POST /api/jobs": [() => json(202, QUEUED)],
      "GET /api/jobs/job-1": [poll.handler],
      "DELETE /api/guest/session": [leave.handler],
      "POST /api/auth/login": [authenticated()],
    });
    await screen.findByRole("region", { name: "Guest mode" });
    await fillForm(user);
    await user.click(button("Generate audio"));
    await waitFor(() => expect(fake.to("/api/jobs/job-1")).toHaveLength(1));
    await user.click(button("Leave guest mode"));
    // Meanwhile the guest session ends on the server: the job poll answers 401.
    await poll.release(notAuthenticated());
    await signInAccount(user);

    await leave.release(noContent());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try as guest" })).toBeNull();
  });

  it("signing in waits while a guest session is being started", async () => {
    const start = deferred();
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "GET /api/guest/session": [notAuthenticated],
      "POST /api/guest/session": [start.handler],
    });
    await user.type(await screen.findByLabelText("Email", { selector: "input" }), "x@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(button("Try as guest"));
    expect(button("Sign in")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Email", { selector: "input" })).toHaveProperty("disabled", true);
    await start.release(json(201, guestBody()));
    await screen.findByRole("region", { name: "Guest mode" });
    expect(fake.requests.some((r) => r.path === "/api/auth/login")).toBe(false);
  });
});
