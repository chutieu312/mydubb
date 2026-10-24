import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import {
  OTHER_USER,
  USER,
  always,
  apiError,
  authenticated,
  installAuthFetch,
  json,
  meResponse,
  meta,
  metaWith,
  newPasswordRequired,
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

function setup(routes: Routes) {
  fake = installAuthFetch({ "GET /api/meta": [meta], ...routes });
  return { ...render(<App />), user: userEvent.setup() };
}

const JOB = {
  id: "job-1",
  status: "queued",
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
  error: null,
};

const field = (name: string) => screen.getByLabelText(name, { selector: "input" });
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const transcript = () => screen.getByLabelText("English Transcript") as HTMLTextAreaElement;

async function signInAs(user: User) {
  await user.type(await screen.findByLabelText("Email", { selector: "input" }), "x@example.com");
  await user.type(field("Password"), "pw-123456");
  await user.click(button("Sign in"));
}

async function submitJob(user: User, text = "Spring Boot uses JSON.") {
  await user.type(await screen.findByLabelText("English Transcript"), text);
  await user.type(screen.getByLabelText("First Sentence Start Time"), "00:00:05");
  await user.type(screen.getByLabelText("Last Sentence Start Time"), "00:00:25");
  await user.click(button("Generate audio"));
}

const signedInSession: Routes = {
  "GET /api/auth/me": [meResponse()],
};

describe("choosing the sign-in UI from /api/meta", () => {
  it("shows email + password in cognito mode and never calls the Access Code endpoint", async () => {
    setup({ "GET /api/auth/me": [notAuthenticated] });

    expect(await screen.findByLabelText("Email", { selector: "input" })).toBeTruthy();
    expect(screen.queryByLabelText("Access Code")).toBeNull();
    expect(fake.requests.map((r) => r.path)).not.toContain("/api/session");
  });

  it("shows the Access Code form in access_code mode and never calls /api/auth", async () => {
    setup({
      "GET /api/meta": [
        metaWith({ mode: "access_code", self_registration: false, password_reset: false }),
      ],
      "GET /api/session": [notAuthenticated],
    });

    expect(await screen.findByLabelText("Access Code")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(fake.requests.every((r) => !r.path.startsWith("/api/auth/"))).toBe(true);
  });

  it.each([
    ["no auth section", undefined],
    ["an unknown mode", { mode: "oauth" }],
    ["a null mode", { mode: null }],
    ["an auth section that is not an object", "cognito"],
  ])("offers no sign in at all when metadata has %s", async (_name, auth) => {
    setup({ "GET /api/meta": [metaWith(auth)] });

    expect((await screen.findByRole("alert")).textContent).toContain("cannot tell how to sign you in");
    expect(button("Try again")).toBeTruthy();
    expect(screen.queryByLabelText("Access Code")).toBeNull();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("English Transcript")).toBeNull();
    expect(fake.requests.map((r) => r.path)).toEqual(["/api/meta"]);
  });

  it("offers no sign in when metadata cannot be loaded, and loads it again on request", async () => {
    const { user } = setup({
      "GET /api/meta": [() => apiError(500, "internal_error", "Failed to load."), meta],
      "GET /api/auth/me": [notAuthenticated],
    });

    expect((await screen.findByRole("alert")).textContent).toBe("Failed to load.");
    expect(screen.queryByLabelText("Email")).toBeNull();

    await user.click(button("Try again"));
    expect(await screen.findByLabelText("Email", { selector: "input" })).toBeTruthy();
  });

  it("does not offer Forgot password when the backend says there is no password reset", async () => {
    setup({
      "GET /api/meta": [
        metaWith({ mode: "cognito", self_registration: false, password_reset: false }),
      ],
      "GET /api/auth/me": [notAuthenticated],
    });
    await screen.findByLabelText("Email", { selector: "input" });
    expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
  });
});

describe("restoring a session on reload", () => {
  it("opens the Studio with the account name and keeps the CSRF token for jobs", async () => {
    const { user } = setup({
      ...signedInSession,
      "POST /api/jobs": [() => json(202, JOB)],
      "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    });

    expect(await screen.findByText("Ada")).toBeTruthy();
    expect(button("Sign out")).toBeTruthy();
    await submitJob(user);

    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.headers["X-CSRF-Token"]).toBe("csrf-1");
  });

  it("shows the email when the account has no display name", async () => {
    setup({ "GET /api/auth/me": [meResponse({ ...USER, display_name: null })] });
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
  });

  it("shows the sign in form when the session is gone (401)", async () => {
    setup({ "GET /api/auth/me": [notAuthenticated] });
    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not claim signed out when the session check itself fails", async () => {
    const { user } = setup({
      "GET /api/meta": [meta, meta],
      "GET /api/auth/me": [() => apiError(503, "http_error", "Unavailable."), meResponse()],
    });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "We could not check your session. Please try again.",
    );
    expect(screen.queryByLabelText("Email")).toBeNull();

    await user.click(button("Try again"));
    expect(await screen.findByText("Ada")).toBeTruthy();
  });

  it("does not trust a /me answer that is missing the CSRF token", async () => {
    setup({ "GET /api/auth/me": [() => json(200, { user: USER, expires_at: "2030-01-01T00:00:00Z" })] });

    expect((await screen.findByRole("alert")).textContent).toContain("could not check your session");
    expect(screen.queryByLabelText("English Transcript")).toBeNull();
  });
});

describe("signing in", () => {
  it("opens the Studio after sign in and sends the new CSRF token", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "POST /api/auth/login": [authenticated(USER, "csrf-new")],
      "POST /api/jobs": [() => json(202, JOB)],
      "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    });

    await signInAs(user);
    expect(await screen.findByText("Ada")).toBeTruthy();
    await submitJob(user);

    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.headers["X-CSRF-Token"]).toBe("csrf-new");
  });

  it("works through the temporary password step", async () => {
    const { user } = setup({
      "GET /api/auth/me": [notAuthenticated],
      "POST /api/auth/login": [newPasswordRequired],
      "POST /api/auth/new-password": [authenticated()],
    });

    await signInAs(user);
    await user.type(await screen.findByLabelText("New password", { selector: "input" }), "Str0ngPassword");
    await user.type(field("Confirm password"), "Str0ngPassword");
    await user.click(button("Set password"));

    expect(await screen.findByText("Ada")).toBeTruthy();
  });
});

describe("session expiry", () => {
  it("returns to sign in with a notice when a job request answers 401, and drops the CSRF token", async () => {
    const { user } = setup({
      ...signedInSession,
      "POST /api/jobs": [notAuthenticated, () => json(202, JOB)],
      "POST /api/auth/login": [authenticated(USER, "csrf-2")],
      "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    });
    await screen.findByText("Ada");

    await submitJob(user);

    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("session has expired");
    expect(screen.queryByText("Ada")).toBeNull();

    await signInAs(user);
    await screen.findByText("Ada");
    await user.click(button("Generate audio"));
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(2));
    expect(fake.to("/api/jobs")[1]?.headers["X-CSRF-Token"]).toBe("csrf-2");
  });
});

describe("the unsent draft", () => {
  async function expire(user: User) {
    await submitJob(user, "My unsent draft");
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });
  }

  it("comes back when the same user signs in again after the session expired", async () => {
    const { user } = setup({
      ...signedInSession,
      "POST /api/jobs": [notAuthenticated],
      "POST /api/auth/login": [authenticated(USER, "csrf-2")],
    });
    await screen.findByText("Ada");
    await expire(user);

    await signInAs(user);
    await screen.findByText("Ada");

    expect(transcript().value).toBe("My unsent draft");
    expect((screen.getByLabelText("First Sentence Start Time") as HTMLInputElement).value).toBe("00:00:05");
  });

  it("is dropped, never shown, when another user signs in", async () => {
    const { user } = setup({
      ...signedInSession,
      "POST /api/jobs": [notAuthenticated],
      "POST /api/auth/login": [authenticated(OTHER_USER, "csrf-b"), authenticated(USER, "csrf-c")],
      "POST /api/auth/logout": [noContent],
    });
    await screen.findByText("Ada");
    await expire(user);

    await signInAs(user);
    await screen.findByText("Bao");
    expect(transcript().value).toBe("");

    // Nothing of the first user comes back later either.
    await user.click(button("Sign out"));
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });
    await signInAs(user);
    await screen.findByText("Ada");
    expect(transcript().value).toBe("");
  });

  it("is discarded by an explicit sign out", async () => {
    const { user } = setup({
      ...signedInSession,
      "POST /api/auth/logout": [noContent],
      "POST /api/auth/login": [authenticated(USER, "csrf-2")],
    });
    await screen.findByText("Ada");
    await user.type(transcript(), "Will not survive sign out");

    await user.click(button("Sign out"));
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });
    await signInAs(user);
    await screen.findByText("Ada");

    expect(transcript().value).toBe("");
  });

  it("is never written to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { user } = setup({ ...signedInSession });
    await screen.findByText("Ada");

    await user.type(transcript(), "Secret transcript text");

    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("sign out", () => {
  const logoutButton = () => button(/sign(ing)? out/i);

  it("signs out only after the server confirms, sending the CSRF token", async () => {
    const { user } = setup({ ...signedInSession, "POST /api/auth/logout": [noContent] });
    await screen.findByText("Ada");

    await user.click(logoutButton());

    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(fake.to("/api/auth/logout")[0]?.headers["X-CSRF-Token"]).toBe("csrf-1");
    expect(screen.queryByText("Ada")).toBeNull();
  });

  it("treats an already invalid session (401) as signed out", async () => {
    const { user } = setup({ ...signedInSession, "POST /api/auth/logout": [notAuthenticated] });
    await screen.findByText("Ada");

    await user.click(logoutButton());

    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
  });

  it.each([
    ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
    ["a server error", () => apiError(503, "http_error", "Unavailable.")],
    ["a CSRF rejection", () => apiError(403, "csrf_failed", "CSRF validation failed.")],
    ["a 200 instead of 204", () => json(200, {})],
  ])("stays signed in after %s and a retry works", async (_name, failure) => {
    const { user } = setup({
      ...signedInSession,
      "POST /api/auth/logout": [failure, noContent],
    });
    await screen.findByText("Ada");

    await user.click(logoutButton());

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Sign out failed; you are still signed in.",
    );
    expect(screen.getByLabelText("English Transcript")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(logoutButton()).toHaveProperty("disabled", false);

    await user.click(logoutButton());
    expect(await screen.findByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
    expect(fake.to("/api/auth/logout").map((r) => r.headers["X-CSRF-Token"])).toEqual([
      "csrf-1",
      "csrf-1",
    ]);
  });

  it("sends one request while a sign out is pending", async () => {
    let finish: (response: Response) => void = () => {};
    const { user } = setup({
      ...signedInSession,
      "POST /api/auth/logout": [() => new Promise<Response>((resolve) => (finish = resolve))],
    });
    await screen.findByText("Ada");

    const signOut = logoutButton();
    await user.click(signOut);
    await user.click(signOut);

    expect(fake.to("/api/auth/logout")).toHaveLength(1);
    finish(new Response(null, { status: 204 }));
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });
  });
});

describe("two accounts in turn", () => {
  it("does not show the first user's job or draft to the second", async () => {
    const { user } = setup({
      ...signedInSession,
      "POST /api/jobs": [() => json(202, JOB)],
      "GET /api/jobs/job-1": [always(() => json(200, JOB))],
      "POST /api/auth/logout": [noContent],
      "POST /api/auth/login": [authenticated(OTHER_USER, "csrf-b")],
    });
    await screen.findByText("Ada");
    await submitJob(user, "Ada's transcript");
    await screen.findByText(/job-1|queued|Queued/i);

    await user.click(button("Sign out"));
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });
    await signInAs(user);
    await screen.findByText("Bao");

    expect(transcript().value).toBe("");
    expect(screen.queryByText(/Ada's transcript/)).toBeNull();
    expect(fake.to("/api/jobs/job-1").length).toBeGreaterThan(0); // Ada's polling stopped with her page
    const pollsBefore = fake.to("/api/jobs/job-1").length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.to("/api/jobs/job-1").length).toBe(pollsBefore);
  });
});
