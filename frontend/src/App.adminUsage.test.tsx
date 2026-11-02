import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import type { ServiceUsage, UsageAttempt, UsageJob, UsageSummary } from "./api/usageApi";
import { apiError, json, META, notAuthenticated, session, USER } from "./test/authFetch.testkit";

type Handler = (url: URL) => Response | Promise<Response>;

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const META_WITH_LANGUAGES = {
  ...META,
  target_languages: [
    { id: "vietnamese", label: "Vietnamese", noun: "Vietnamese", translator_language: "vi" },
    { id: "japanese", label: "Japanese", noun: "Japanese", translator_language: "ja" },
  ],
  default_target_language: "vietnamese",
};

const usage = (service: string, values: Partial<ServiceUsage> = {}): ServiceUsage => ({
  service,
  requests: 0,
  mock_requests: 0,
  actual_requests: 0,
  actual_characters: 0,
  estimated_requests: 0,
  estimated_characters: 0,
  unknown_requests: 0,
  unknown_sent_characters: 0,
  none_requests: 0,
  outcomes: {},
  unpriced_characters: 0,
  reference_cost: "0",
  ...values,
});

const LINE = {
  service: "translator",
  sku: "S1",
  meter: "S1 Characters",
  region: "westus2",
  unit: "1M characters",
  price: "10.00",
  currency: "USD",
  effective_from: "2025-05-01",
  checked_on: "2026-11-01",
  source: "https://prices.example/api",
  characters: 26900,
  amount: "0.269",
};

const filtersOf = (url: URL) => ({
  since: url.searchParams.get("since") ?? "",
  until: url.searchParams.get("until") ?? "",
  language: url.searchParams.get("language"),
  job_id: url.searchParams.get("job_id"),
});

const summaryOf = (url: URL, values: Partial<UsageSummary> = {}): UsageSummary => ({
  generated_at: "2026-11-01T12:00:00Z",
  filters: filtersOf(url),
  first_usage_at: "2026-10-20T09:00:00Z",
  jobs_total: 7,
  statuses: { completed: 4, failed: 3 },
  complete: 3,
  incomplete: 4,
  reasons: { usage_unknown: 2, no_ending_recorded: 1 },
  jobs_with_mock: 1,
  jobs_without_usage: 2,
  services: [
    usage("translator", {
      requests: 6,
      actual_requests: 5,
      actual_characters: 26900,
      unknown_requests: 1,
      unknown_sent_characters: 600,
      outcomes: { ok: 5, timeout: 1 },
      reference_cost: "0.269",
    }),
    usage("speech", {
      requests: 8,
      estimated_requests: 7,
      estimated_characters: 48300,
      unknown_requests: 1,
      mock_requests: 2,
      reference_cost: "0.7245",
    }),
  ],
  reference_cost: {
    currency: "USD",
    known_total: "0.9935",
    partial: true,
    partial_reasons: ["unknown_usage", "incomplete_jobs"],
    lines: [LINE],
  },
  ...values,
});

const jobRow = (values: Partial<UsageJob> = {}): UsageJob => ({
  job_id: JOB_ID,
  started_at: "2026-10-30T09:00:00.123456Z",
  finished_at: null,
  language: "japanese",
  voice: "AndrewMultilingual",
  speed_percent: 150,
  timing_mode: "timed",
  status: "failed",
  outcome: "failed",
  error_code: "speech_timeout",
  providers: "real",
  complete: false,
  reasons: ["usage_unknown"],
  services: [
    usage("translator", { actual_requests: 1, actual_characters: 4950 }),
    usage("speech", { unknown_requests: 1 }),
  ],
  reference_cost: {
    currency: "USD",
    known_total: "0.0495",
    partial: true,
    partial_reasons: ["unknown_usage"],
    lines: [LINE],
  },
  baseline_seconds: 300,
  target_audio_seconds: "200.000",
  final_audio_seconds: null,
  audio_processing_ms: null,
  mp3_bytes: null,
  ...values,
});

const attempt = (seq: number, values: Partial<UsageAttempt> = {}): UsageAttempt => ({
  seq,
  service: "speech",
  provider_kind: "azure",
  outcome: "timeout",
  http_status: null,
  error_code: "speech_timeout",
  started_at: "2026-10-30T09:00:01Z",
  elapsed_ms: 30000,
  usage_amount: null,
  usage_unit: "characters",
  usage_basis: "unknown",
  usage_method: "azure-speech-ssml-characters-v1",
  reference_cost: null,
  no_cost_reason: "unknown_usage",
  ...values,
});

const jobsOf = (url: URL, jobs: UsageJob[] = [jobRow()], next: string | null = null) => ({
  generated_at: "2026-11-01T12:00:01Z",
  filters: filtersOf(url),
  jobs,
  next_cursor: next,
});

interface Fake {
  calls: string[];
  to: (path: string) => URL[];
}

/** The backend behind `fetch`; an unknown request is a test failure, as in the other App tests. */
function installBackend(overrides: Record<string, Handler> = {}): Fake {
  const calls: string[] = [];
  const unexpected: string[] = [];
  const routes: Record<string, Handler> = {
    "GET /api/meta": () => json(200, META_WITH_LANGUAGES),
    "GET /api/auth/me": () => json(200, session()),
    "GET /api/admin/session": () => json(200, { role: "admin" }),
    "POST /api/auth/logout": () => new Response(null, { status: 204 }),
    "GET /api/admin/usage/summary": (url) => json(200, summaryOf(url)),
    "GET /api/admin/usage/jobs": (url) => json(200, jobsOf(url)),
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${url.pathname}${url.search}`);
      const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
      if (!route) {
        unexpected.push(url.pathname);
        throw new Error(`Unexpected request: ${url.pathname}`);
      }
      return route(url);
    }),
  );
  fakeUnexpected = unexpected;
  return {
    calls,
    to: (path) =>
      calls
        .map((call) => new URL(call, "http://localhost"))
        .filter((url) => url.pathname === path),
  };
}

let fakeUnexpected: string[] = [];

function deferred() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function open(path = "/admin/usage") {
  window.history.replaceState(null, "", path);
  render(<App />);
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  expect(fakeUnexpected).toEqual([]);
  fakeUnexpected = [];
});

const SUMMARY = "/api/admin/usage/summary";
const JOBS = "/api/admin/usage/jobs";
const usageLink = () => screen.queryByRole("link", { name: "Usage & Costs" });
const summaryLoaded = () => screen.findByText("Jobs with usage");
const back = async () => {
  await act(async () => {
    window.history.back();
    await new Promise((done) => window.addEventListener("popstate", done, { once: true }));
  });
};

describe("who sees Usage & Costs", () => {
  it("offers it to an administrator, asking the server once per identity", async () => {
    const fake = installBackend();
    const user = open("/");
    expect(await screen.findByRole("link", { name: "Usage & Costs" })).toBeTruthy();

    await user.click(usageLink() as HTMLElement);
    await summaryLoaded();
    expect(window.location.pathname).toBe("/admin/usage");
    await user.click(screen.getByRole("link", { name: "Studio" }));
    await user.click(usageLink() as HTMLElement);
    await summaryLoaded();
    expect(fake.to("/api/admin/session")).toHaveLength(1);
    // Nothing about the role was added to what the session endpoint returns or sends.
    expect(fake.to("/api/auth/me")).toHaveLength(1);
  });

  it("does not offer it to an ordinary user, and a direct address shows no report", async () => {
    const fake = installBackend({
      "GET /api/admin/session": () => apiError(403, "admin_required", "No."),
    });
    open();
    expect(await screen.findByText("This page is for MyDubb administrators.")).toBeTruthy();
    expect(usageLink()).toBeNull();
    expect(fake.to(SUMMARY)).toEqual([]);
    expect(fake.to(JOBS)).toEqual([]);
    expect(screen.getByRole("link", { name: "Back to Studio" })).toBeTruthy();
  });

  it("does not ask for a guest", async () => {
    const guest = {
      status: "guest",
      guest: { id: "g-1" },
      csrf_token: "c",
      expires_at: "2030-01-01T00:00:00Z",
      quota: {
        session_limit: 1,
        session_used: 0,
        session_in_progress: 0,
        session_remaining: 1,
        ip_limit: 1,
        ip_used: 0,
        ip_in_progress: 0,
        ip_remaining: 1,
        ip_retry_after_seconds: null,
        ip_window_seconds: 3600,
        max_words: 100,
        max_output_seconds: 60,
      },
      imports: null,
    };
    const fake = installBackend({
      "GET /api/meta": () =>
        json(200, {
          ...META_WITH_LANGUAGES,
          guest_access: {
            enabled: true,
            jobs_per_session: 1,
            jobs_per_ip: 1,
            ip_window_seconds: 3600,
            max_words: 100,
            max_output_seconds: 60,
            session_ttl_seconds: 3600,
          },
        }),
      "GET /api/auth/me": () => notAuthenticated(),
      "GET /api/guest/session": () => json(200, guest),
    });
    open();
    expect(await screen.findByText("This page is for MyDubb administrators.")).toBeTruthy();
    expect(usageLink()).toBeNull();
    expect(fake.to("/api/admin/session")).toEqual([]);
    expect(fake.to(SUMMARY)).toEqual([]);
  });

  it("does not ask in Access Code mode", async () => {
    const fake = installBackend({
      "GET /api/meta": () =>
        json(200, {
          ...META_WITH_LANGUAGES,
          auth: { mode: "access_code", self_registration: false, password_reset: false },
        }),
      "GET /api/session": () =>
        json(200, { authenticated: true, csrf_token: "c", expires_at: "2030-01-01T00:00:00Z" }),
    });
    open();
    expect(await screen.findByText("This page is for MyDubb administrators.")).toBeTruthy();
    expect(fake.to("/api/admin/session")).toEqual([]);
  });

  it("shows the sign-in form to nobody signed in, with no report request", async () => {
    const fake = installBackend({ "GET /api/auth/me": () => notAuthenticated() });
    open();
    expect(await screen.findByLabelText("Email", { selector: "input" })).toBeTruthy();
    expect(fake.to("/api/admin/session")).toEqual([]);
    expect(fake.to(SUMMARY)).toEqual([]);
  });

  it("says so when the check itself fails, and can try again", async () => {
    let attempts = 0;
    const fake = installBackend({
      "GET /api/admin/session": () => {
        attempts += 1;
        return attempts === 1
          ? apiError(500, "internal_error", "Oops.")
          : json(200, { role: "admin" });
      },
    });
    const user = open();
    await screen.findByText(/could not check your administrator access/);
    expect(fake.to(SUMMARY)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await summaryLoaded();
  });
});

describe("what the page shows", () => {
  it("always says what the cost is, and marks a figure that is not a total", async () => {
    installBackend();
    open();
    await summaryLoaded();
    expect(screen.getByText("Reference cost — not an invoice.")).toBeTruthy();

    const cost = within(screen.getByRole("region", { name: "Reference cost" }));
    expect(cost.getByText("USD 0.9935")).toBeTruthy();
    expect(cost.getByText("at least")).toBeTruthy();
    expect(cost.getByText(/A lower bound of known usage, not a total/)).toBeTruthy();
    expect(cost.getByText(/requests with unknown usage, incomplete jobs/)).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("completed 4, failed 3")).toBeTruthy();
    expect(screen.getByText("Requests with unknown usage: 2")).toBeTruthy();
    expect(screen.getAllByText(/a size sent, not a billing figure/).length).toBeGreaterThan(0);
    expect(screen.getByText("2026-10-20 09:00:00 UTC")).toBeTruthy();
    expect(screen.getByText(/It is not when recording was deployed/)).toBeTruthy();
    expect(screen.getByText(/Matched on when the job was created/)).toBeTruthy();
    expect(screen.getByText(/USD 10.00 \/ 1M characters/)).toBeTruthy();
    expect(screen.getByText("2025-05-01")).toBeTruthy();
    expect(screen.getByText("2026-11-01")).toBeTruthy();
  });

  it("does not call a complete figure a lower bound", async () => {
    installBackend({
      "GET /api/admin/usage/summary": (url) =>
        json(
          200,
          summaryOf(url, {
            reference_cost: {
              currency: "USD",
              known_total: "0.000075",
              partial: false,
              partial_reasons: [],
              lines: [],
            },
          }),
        ),
    });
    open();
    await summaryLoaded();
    const cost = within(screen.getByRole("region", { name: "Reference cost" }));
    expect(cost.getByText("USD 0.0001")).toBeTruthy();
    expect(cost.queryByText("at least")).toBeNull();
    expect(cost.queryByText(/lower bound/)).toBeNull();
    expect(screen.getByText("No usage with a reference price here.")).toBeTruthy();
  });

  it("keeps what is not known apart from zero in a job row", async () => {
    installBackend();
    open();
    expect(await screen.findByText(JOB_ID)).toBeTruthy();
    const row = screen.getByText(JOB_ID).closest("tr") as HTMLElement;
    expect(within(row).getByText("2026-10-30 09:00:00 UTC")).toBeTruthy();
    expect(within(row).getByText("Japanese")).toBeTruthy();
    expect(within(row).getByText("AndrewMultilingual")).toBeTruthy();
    expect(within(row).getByText("1.5x")).toBeTruthy();
    expect(within(row).getByText("timed")).toBeTruthy();
    expect(within(row).getByText("Incomplete")).toBeTruthy();
    expect(within(row).getByText("Requests with unknown usage")).toBeTruthy();
    expect(within(row).getByText("4,950 chars actual")).toBeTruthy();
    expect(within(row).getByText("1 unknown req.")).toBeTruthy();
    expect(within(row).getByText("USD 0.0495")).toBeTruthy();
    expect(within(row).getByText("200.000 s")).toBeTruthy();
    expect(within(row).getAllByText("Not recorded")).toHaveLength(3); // final, processing, MP3
    expect(within(row).queryByText(/^0( s| ms| bytes)?$/)).toBeNull();
  });

  it("says a mock job is not billed and never adds the two services", async () => {
    installBackend({
      "GET /api/admin/usage/jobs": (url) =>
        json(
          200,
          jobsOf(url, [
            jobRow({
              providers: "mock",
              complete: true,
              reasons: [],
              services: [usage("translator", { mock_requests: 1 }), usage("speech", { mock_requests: 1 })],
              reference_cost: {
                currency: "USD",
                known_total: "0",
                partial: false,
                partial_reasons: [],
                lines: [],
              },
            }),
          ]),
        ),
    });
    open();
    const row = (await screen.findByText(JOB_ID)).closest("tr") as HTMLElement;
    expect(within(row).getByText("Mock: not billed")).toBeTruthy();
    expect(within(row).getAllByText("1 mock req.")).toHaveLength(2);
    expect(within(row).getByText("Complete")).toBeTruthy();
  });

  it("tells an empty database from filters with no result, and from loading", async () => {
    const empty = deferred();
    installBackend({
      "GET /api/admin/usage/summary": () => empty.promise,
      "GET /api/admin/usage/jobs": (url) => json(200, jobsOf(url, [])),
    });
    open();
    expect(await screen.findByText("Loading the summary…")).toBeTruthy();
    expect(screen.queryByText("Jobs with usage")).toBeNull();
    const url = new URL("http://x/?since=a&until=b");
    await act(async () => {
      empty.resolve(
        json(200, summaryOf(url, { jobs_total: 0, first_usage_at: null, statuses: {} })),
      );
    });
    expect(await screen.findByText("No usage has been recorded in the database yet.")).toBeTruthy();
    expect(screen.getByText("No job with a usage record matches these filters.")).toBeTruthy();
    cleanup();

    installBackend({
      "GET /api/admin/usage/summary": (u) => json(200, summaryOf(u, { jobs_total: 0, statuses: {} })),
      "GET /api/admin/usage/jobs": (u) => json(200, jobsOf(u, [])),
    });
    open(`/admin/usage?job_id=${JOB_ID}`);
    expect(await screen.findByText("No job with a usage record matches these filters.")).toBeTruthy();
    expect(screen.queryByText("No usage has been recorded in the database yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Look this job ID up in any period" })).toBeTruthy();
  });

  it("shows an error, not an empty report, and retries only what failed", async () => {
    let calls = 0;
    const fake = installBackend({
      "GET /api/admin/usage/summary": (url) => {
        calls += 1;
        return calls === 1
          ? apiError(503, "usage_report_timeout", "The usage report took too long.")
          : json(200, summaryOf(url));
      },
    });
    const user = open();
    expect(await screen.findByText("The usage report took too long.")).toBeTruthy();
    expect(screen.queryByText("Jobs with usage")).toBeNull();
    expect(screen.queryByText("USD 0.0000")).toBeNull();
    await screen.findByText(JOB_ID); // the jobs answered
    const jobCalls = fake.to(JOBS).length;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await summaryLoaded();
    expect(screen.queryByText("The usage report took too long.")).toBeNull();
    expect(fake.to(JOBS)).toHaveLength(jobCalls);
  });

  it("explains filters the server refused, without a pointless retry", async () => {
    const refused = () =>
      json(422, {
        error: {
          code: "validation_error",
          message: "The request contains invalid fields.",
          fields: [{ field: "since", message: "Must be an ISO date or date and time." }],
        },
      });
    installBackend({
      "GET /api/admin/usage/summary": refused,
      "GET /api/admin/usage/jobs": refused,
    });
    open("/admin/usage?since=nonsense&until=2026-10-02");
    expect(await screen.findAllByText(/since: Must be an ISO date/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("Jobs with usage")).toBeNull();
  });
});

describe("filters and refreshing", () => {
  const PERIOD = "since=2026-10-01T00%3A00%3A00Z&until=2026-10-08T00%3A00%3A00Z";

  it("loads once on entry with an explicit period, and never on its own", async () => {
    const fake = installBackend();
    open();
    await summaryLoaded();
    await screen.findByText(JOB_ID);
    const [first] = fake.to(SUMMARY);
    const since = first?.searchParams.get("since") ?? "";
    const until = first?.searchParams.get("until") ?? "";
    expect(Date.parse(until) - Date.parse(since)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(fake.to(JOBS)[0]?.searchParams.get("since")).toBe(since);

    const before = fake.calls.length;
    // Coming back to the tab or window reads nothing.
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(fake.calls).toHaveLength(before);
  });

  it("asks nothing while typing; Apply asks, and the old figures are gone at once", async () => {
    const later = deferred();
    let held = false;
    const fake = installBackend({
      "GET /api/admin/usage/summary": (url) =>
        url.searchParams.get("language") === "japanese" && !held
          ? ((held = true), later.promise)
          : json(200, summaryOf(url)),
    });
    const user = open(`/admin/usage?${PERIOD}`);
    await summaryLoaded();
    const before = fake.calls.length;

    await user.type(screen.getByLabelText("Job ID"), "abc");
    await user.clear(screen.getByLabelText("Job ID"));
    await user.selectOptions(screen.getByLabelText("Language"), "japanese");
    expect(fake.calls).toHaveLength(before);

    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(new URLSearchParams(window.location.search).get("language")).toBe("japanese");
    // New filters on screen, and no figure of the previous ones under them.
    expect(screen.queryByText("Jobs with usage")).toBeNull();
    expect(await screen.findByText("Loading the summary…")).toBeTruthy();

    await act(async () => {
      later.resolve(json(200, summaryOf(new URL("http://x/"), { jobs_total: 123 })));
    });
    expect(await screen.findByText("123")).toBeTruthy();
  });

  it("refuses bad filters without asking", async () => {
    const fake = installBackend();
    const user = open(`/admin/usage?${PERIOD}`);
    await summaryLoaded();
    const before = fake.calls.length;
    const until = screen.getByLabelText("Until (UTC, exclusive)") as HTMLInputElement;
    await user.clear(until);
    await user.type(until, "2026-12-01T00:00:00");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("The period can be at most 31 days.")).toBeTruthy();
    expect(until.getAttribute("aria-invalid")).toBe("true");
    expect(until.getAttribute("aria-describedby")).toBe("usage-until-error");

    await user.clear(until);
    await user.type(until, "2026-10-08T00:00:00");
    await user.type(screen.getByLabelText("Job ID"), "abc");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Enter a full job ID.")).toBeTruthy();
    expect(fake.calls).toHaveLength(before);
  });

  it("sends the times as UTC whatever the field shows", async () => {
    const fake = installBackend();
    const user = open(`/admin/usage?${PERIOD}`);
    await summaryLoaded();
    const since = screen.getByLabelText("Since (UTC, inclusive)") as HTMLInputElement;
    expect(since.value).toMatch(/^2026-10-01T00:00/);
    await user.clear(since);
    await user.type(since, "2026-10-02T08:30:00");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(fake.to(SUMMARY).at(-1)?.searchParams.get("since")).toBe("2026-10-02T08:30:00Z"),
    );
  });

  it("drops an answer that arrives after the filters changed", async () => {
    const slow = deferred();
    const slowJobs = deferred();
    installBackend({
      "GET /api/admin/usage/summary": (url) =>
        url.searchParams.get("language") ? json(200, summaryOf(url, { jobs_total: 2 })) : slow.promise,
      "GET /api/admin/usage/jobs": (url) =>
        url.searchParams.get("language")
          ? json(200, jobsOf(url, [jobRow({ job_id: OTHER_JOB_ID })]))
          : slowJobs.promise,
    });
    const user = open(`/admin/usage?${PERIOD}`);
    await screen.findByText("Loading the summary…");
    await user.selectOptions(screen.getByLabelText("Language"), "japanese");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(OTHER_JOB_ID)).toBeTruthy();
    const jobsCard = within(screen.getByRole("region", { name: "Jobs with usage" }));
    expect(await jobsCard.findByText("2")).toBeTruthy();

    await act(async () => {
      slow.resolve(json(200, summaryOf(new URL("http://x/"), { jobs_total: 999 })));
      slowJobs.resolve(json(200, jobsOf(new URL("http://x/"))));
    });
    expect(screen.queryByText("999")).toBeNull();
    expect(screen.queryByText(JOB_ID)).toBeNull();
    expect(screen.getByText(OTHER_JOB_ID)).toBeTruthy();
  });

  it("Refresh reads again and goes back to the first page, on the same address", async () => {
    const fake = installBackend({
      "GET /api/admin/usage/jobs": (url) =>
        json(200, jobsOf(url, [jobRow()], url.searchParams.get("cursor") ? null : "c2")),
    });
    const user = open(`/admin/usage?${PERIOD}`);
    await screen.findByText(JOB_ID);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Page 2");
    const address = window.location.href;
    const summaries = fake.to(SUMMARY).length;

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Page 1");
    expect(fake.to(JOBS).at(-1)?.searchParams.get("cursor")).toBeNull();
    expect(fake.to(SUMMARY)).toHaveLength(summaries + 1);
    expect(window.location.href).toBe(address);

    // Apply with nothing changed also reads again, with no new history entry.
    const entries = window.history.length;
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(fake.to(SUMMARY)).toHaveLength(summaries + 2));
    expect(window.history.length).toBe(entries);
  });

  it("pages through jobs with the cursor the server gave, and a filter restarts", async () => {
    const fake = installBackend({
      "GET /api/admin/usage/jobs": (url) => {
        const cursor = url.searchParams.get("cursor");
        return cursor === "c2"
          ? json(200, jobsOf(url, [jobRow({ job_id: OTHER_JOB_ID })]))
          : json(200, jobsOf(url, [jobRow()], "c2"));
      },
    });
    const user = open(`/admin/usage?${PERIOD}`);
    await screen.findByText(JOB_ID);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(OTHER_JOB_ID)).toBeTruthy();
    expect(screen.queryByText(JOB_ID)).toBeNull();
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    // The summary is the whole period: a page of jobs does not read it again.
    expect(fake.to(SUMMARY)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText(JOB_ID)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(OTHER_JOB_ID);

    await user.selectOptions(screen.getByLabelText("Language"), "japanese");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(JOB_ID)).toBeTruthy();
    expect(fake.to(JOBS).at(-1)?.searchParams.get("cursor")).toBeNull();
    expect(fake.to(JOBS).at(-1)?.searchParams.get("language")).toBe("japanese");
  });
});

describe("a job's usage", () => {
  const detailOf = (url: URL) => ({
    generated_at: "2026-11-01T12:00:02Z",
    job: jobRow(),
    method_version: 1,
    attempts_total: 3,
    attempts:
      url.searchParams.get("cursor") === "a2"
        ? [attempt(3, { outcome: "http_error", http_status: 429 })]
        : [
            attempt(1, {
              service: "translator",
              outcome: "ok",
              http_status: 200,
              error_code: null,
              elapsed_ms: 900,
              usage_amount: 4950,
              usage_basis: "actual",
              usage_method: "translator-x-metered-usage-v1",
              reference_cost: "0.0495",
              no_cost_reason: null,
            }),
            attempt(2),
          ],
    next_cursor: url.searchParams.get("cursor") === "a2" ? null : "a2",
  });
  const DETAIL = `/api/admin/usage/jobs/${JOB_ID}`;

  it("opens from the table, pages its requests, and offers no transcript or audio", async () => {
    const fake = installBackend({ [`GET ${DETAIL}`]: (url) => json(200, detailOf(url)) });
    const user = open();
    await user.click(await screen.findByRole("button", { name: `View usage of job ${JOB_ID}` }));
    expect(new URLSearchParams(window.location.search).get("job")).toBe(JOB_ID);
    const detail = screen.getByRole("region", { name: new RegExp(`Usage of job ${JOB_ID}`) });
    expect(await within(detail).findByText("translator-x-metered-usage-v1")).toBeTruthy();
    expect(within(detail).getByText("4,950 characters")).toBeTruthy();
    expect(within(detail).getByText("Actual")).toBeTruthy();
    expect(within(detail).getByText("HTTP 200")).toBeTruthy();
    expect(within(detail).getByText("No HTTP status")).toBeTruthy();
    expect(within(detail).getByText("900 ms")).toBeTruthy();
    expect(within(detail).getByText("Unknown usage: not assumed free")).toBeTruthy();
    expect(within(detail).getByText("(3 in this job)")).toBeTruthy();
    expect(document.activeElement).toBe(within(detail).getByRole("heading", { level: 2 }));
    expect(detail.querySelector("audio")).toBeNull();
    expect(within(detail).queryByText(/transcript/i)).toBeNull();

    const nav = within(detail).getByRole("navigation", { name: "Provider request pages" });
    await user.click(within(nav).getByRole("button", { name: "Next" }));
    expect(await within(detail).findByText("HTTP 429")).toBeTruthy();
    expect(within(detail).queryByText("HTTP 200")).toBeNull();
    // The job's own figures are the same on every page of requests.
    expect(within(detail).getByText("(3 in this job)")).toBeTruthy();
    expect(within(detail).getAllByText("USD 0.0495").length).toBeGreaterThan(0);

    // Opening and paging a job does not read the period again.
    expect(fake.to(SUMMARY)).toHaveLength(1);
    expect(fake.to(JOBS)).toHaveLength(1);

    await user.click(within(detail).getByRole("button", { name: "Close" }));
    expect(new URLSearchParams(window.location.search).get("job")).toBeNull();
    expect(screen.queryByRole("region", { name: /Usage of job/ })).toBeNull();
  });

  it("explains a job with no usage record", async () => {
    installBackend({
      [`GET ${DETAIL}`]: () => apiError(404, "job_usage_not_found", "No usage record."),
    });
    open(`/admin/usage?job=${JOB_ID}`);
    expect(await screen.findByText(/No usage record is stored for this job ID/)).toBeTruthy();
    expect(screen.getByText(/does not mean the job was free/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("drops the answer of a job no longer open", async () => {
    const slow = deferred();
    installBackend({
      [`GET ${DETAIL}`]: () => slow.promise,
      [`GET /api/admin/usage/jobs/${OTHER_JOB_ID}`]: (url) =>
        json(200, { ...detailOf(url), job: jobRow({ job_id: OTHER_JOB_ID, voice: "Second" }) }),
      "GET /api/admin/usage/jobs": (url) =>
        json(200, jobsOf(url, [jobRow(), jobRow({ job_id: OTHER_JOB_ID })])),
    });
    const user = open();
    await user.click(await screen.findByRole("button", { name: `View usage of job ${JOB_ID}` }));
    await screen.findByText("Loading this job's usage…");
    await user.click(screen.getByRole("button", { name: `View usage of job ${OTHER_JOB_ID}` }));
    const detail = screen.getByRole("region", { name: new RegExp(`Usage of job ${OTHER_JOB_ID}`) });
    expect(await within(detail).findByText("Providers")).toBeTruthy();
    await act(async () => {
      slow.resolve(json(200, detailOf(new URL("http://x/"))));
    });
    expect(screen.getByRole("region", { name: new RegExp(`Usage of job ${OTHER_JOB_ID}`) })).toBeTruthy();
    expect(screen.queryByRole("region", { name: new RegExp(`Usage of job ${JOB_ID}`) })).toBeNull();
  });
});

describe("losing access", () => {
  it("a 401 ends the session: sign-in form, no figures, no filters left in the address", async () => {
    let calls = 0;
    installBackend({
      "GET /api/admin/usage/summary": (url) => {
        calls += 1;
        return calls === 1 ? json(200, summaryOf(url)) : notAuthenticated();
      },
    });
    const user = open("/admin/usage?since=2026-10-01&until=2026-10-02");
    await summaryLoaded();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByLabelText("Email", { selector: "input" })).toBeTruthy();
    expect(screen.getByText(/session has expired or ended/)).toBeTruthy();
    expect(screen.queryByText("Jobs with usage")).toBeNull();
    expect(screen.queryByText(JOB_ID)).toBeNull();
    expect(window.location.pathname).toBe("/admin/usage");
    expect(window.location.search).toBe("");
  });

  it("a 403 ends the access only: still signed in, figures gone, Studio still there", async () => {
    let calls = 0;
    const fake = installBackend({
      "GET /api/admin/usage/summary": (url) => {
        calls += 1;
        return calls === 1
          ? json(200, summaryOf(url))
          : apiError(403, "admin_required", "This requires an administrator.");
      },
    });
    const user = open("/admin/usage?since=2026-10-01&until=2026-10-02");
    await summaryLoaded();
    await screen.findByText(JOB_ID);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/administrator access has ended/)).toBeTruthy();
    expect(screen.getByText(/You are still signed in/)).toBeTruthy();
    expect(screen.queryByText("Jobs with usage")).toBeNull();
    expect(screen.queryByText(JOB_ID)).toBeNull();
    expect(usageLink()).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(window.location.search).toBe("");
    // Not asked again on its own.
    expect(fake.to("/api/admin/session")).toHaveLength(1);

    await user.click(screen.getByRole("link", { name: "Back to Studio" }));
    expect(await screen.findByLabelText("English Transcript")).toBeTruthy();
    expect(screen.queryByText("Reference cost — not an invoice.")).toBeNull();
  });

  it("a late answer after sign-out brings nothing back, for anyone", async () => {
    const slow = deferred();
    const slowJobs = deferred();
    installBackend({
      "GET /api/auth/me": () => json(200, session(USER, "csrf-1")),
      "GET /api/admin/usage/summary": () => slow.promise,
      "GET /api/admin/usage/jobs": () => slowJobs.promise,
    });
    const user = open("/admin/usage?since=2026-10-01&until=2026-10-02");
    await screen.findByText("Loading the summary…");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Email", { selector: "input" });
    expect(window.location.search).toBe("");

    await act(async () => {
      slow.resolve(json(200, summaryOf(new URL("http://x/"))));
      slowJobs.resolve(json(200, jobsOf(new URL("http://x/"))));
    });
    expect(screen.queryByText("Jobs with usage")).toBeNull();
    expect(screen.queryByText(JOB_ID)).toBeNull();
    expect(usageLink()).toBeNull();
  });

  it("an ordinary user signing in next sees no report", async () => {
    let signedIn = false;
    installBackend({
      "GET /api/auth/me": () => json(200, session()),
      "GET /api/admin/session": () =>
        signedIn ? apiError(403, "admin_required", "No.") : json(200, { role: "admin" }),
      "POST /api/auth/login": () => {
        signedIn = true;
        return json(200, { status: "authenticated", ...session({ ...USER, id: "u-2" }, "csrf-2") });
      },
    });
    const user = open();
    await summaryLoaded();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.type(await screen.findByLabelText("Email", { selector: "input" }), "b@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("This page is for MyDubb administrators.")).toBeTruthy();
    expect(screen.queryByText("Jobs with usage")).toBeNull();
    expect(usageLink()).toBeNull();
  });
});

describe("moving between the pages", () => {
  it("keeps the Studio form, with nothing new in the address or in storage", async () => {
    const fake = installBackend();
    const user = open("/");
    const secret = "A private transcript that must stay in page memory.";
    const transcript = (await screen.findByLabelText("English Transcript")) as HTMLTextAreaElement;
    await user.type(transcript, secret);
    await user.type(screen.getByLabelText("First Sentence Start Time"), "00:00:05");

    await user.click(await screen.findByRole("link", { name: "Usage & Costs" }));
    await summaryLoaded();
    expect(screen.getByRole("heading", { level: 1, name: "Usage & Costs" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "English Transcript" })).toBeNull(); // hidden from everyone
    expect(window.location.href).not.toContain("transcript");
    expect(fake.calls.join(" ")).not.toContain("private");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);

    await user.click(screen.getByRole("link", { name: "Back to Studio" }));
    const again = (await screen.findByLabelText("English Transcript")) as HTMLTextAreaElement;
    expect(again).toBe(transcript); // the same field: still mounted
    expect(again.value).toBe(secret);
    expect((screen.getByLabelText("First Sentence Start Time") as HTMLInputElement).value).toBe(
      "00:00:05",
    );
    expect(screen.getByRole("heading", { level: 1 })).toBe(document.activeElement);
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByText("Reference cost — not an invoice.")).toBeNull();
  });

  it("follows Back and Forward: filters, an open job and the page itself", async () => {
    const fake = installBackend({
      [`GET /api/admin/usage/jobs/${JOB_ID}`]: () =>
        apiError(404, "job_usage_not_found", "No usage record."),
    });
    const user = open("/");
    await user.click(await screen.findByRole("link", { name: "Usage & Costs" }));
    await summaryLoaded();
    await user.selectOptions(screen.getByLabelText("Language"), "japanese");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(fake.to(SUMMARY).at(-1)?.searchParams.get("language")).toBe("japanese"),
    );
    await screen.findByText("Jobs with usage");
    await user.click(await screen.findByRole("button", { name: `View usage of job ${JOB_ID}` }));
    await screen.findByText(/No usage record is stored/);

    await back(); // the job closes; the same filters are not read again
    expect(screen.queryByText(/No usage record is stored/)).toBeNull();
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("japanese");
    const summaries = fake.to(SUMMARY).length;

    await back(); // the filters go back, in the form and in the request
    await waitFor(() => expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe(""));
    await waitFor(() => expect(fake.to(SUMMARY)).toHaveLength(summaries + 1));
    expect(fake.to(SUMMARY).at(-1)?.searchParams.get("language")).toBeNull();

    await back(); // the Studio
    expect(await screen.findByLabelText("English Transcript")).toBeTruthy();
    expect(screen.queryByText("Reference cost — not an invoice.")).toBeNull();
  });

  it("a direct address with filters and a job reads exactly those", async () => {
    const fake = installBackend({
      [`GET /api/admin/usage/jobs/${JOB_ID}`]: () =>
        apiError(404, "job_usage_not_found", "No usage record."),
    });
    open(
      `/admin/usage?since=2026-10-01T00%3A00%3A00Z&until=2026-10-02T00%3A00%3A00Z&language=japanese&job=${JOB_ID}`,
    );
    await summaryLoaded();
    await screen.findByText(/No usage record is stored/);
    const request = fake.to(SUMMARY)[0];
    expect(request?.searchParams.get("since")).toBe("2026-10-01T00:00:00Z");
    expect(request?.searchParams.get("language")).toBe("japanese");
    expect((screen.getByLabelText("Language") as HTMLSelectElement).value).toBe("japanese");
    expect((screen.getByLabelText("Until (UTC, exclusive)") as HTMLInputElement).value).toMatch(
      /^2026-10-02T00:00/,
    );
    expect(document.title).toBe("Usage & Costs · MyDubb");
  });

  it("leaves a click with a modifier to the browser", async () => {
    installBackend();
    const user = open("/");
    const link = await screen.findByRole("link", { name: "Usage & Costs" });
    expect(link.getAttribute("href")).toBe("/admin/usage");
    await user.keyboard("{Control>}");
    await user.click(link);
    await user.keyboard("{/Control}");
    expect(window.location.pathname).toBe("/");
  });

  it("does not touch /extension/connect or add links for a non-administrator", async () => {
    installBackend({ "GET /api/admin/session": () => apiError(403, "admin_required", "No.") });
    open("/");
    await screen.findByLabelText("English Transcript");
    await waitFor(() => expect(usageLink()).toBeNull());
    expect(screen.queryByRole("navigation", { name: "Administrator" })).toBeNull();
  });
});

describe("the page's own storage and styling rules", () => {
  it("stores nothing of the report in the browser", async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    installBackend();
    open();
    await summaryLoaded();
    await screen.findByText(JOB_ID);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("uses no inline style, which the Content-Security-Policy would block", async () => {
    installBackend();
    open();
    await summaryLoaded();
    await screen.findByText(JOB_ID);
    expect(document.querySelectorAll("[style]")).toHaveLength(0);
  });
});
