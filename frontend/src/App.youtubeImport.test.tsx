import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { setCsrfToken } from "./api/client";
import {
  META,
  OTHER_USER,
  USER,
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
  window.localStorage.clear();
  window.sessionStorage.clear();
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

const importOn = () =>
  json(200, { ...META, youtube_import: { enabled: true, provider: "supadata" } });
const imported = (body: object = RESULT) => () => json(200, body);

/** A response the test releases when it wants: the import is "in flight" until then. */
function deferred() {
  let release: (response: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { handler: () => promise, release };
}

function setup(routes: Routes = {}, metaHandler = importOn) {
  fake = installAuthFetch({
    "GET /api/meta": [metaHandler],
    "GET /api/auth/me": [meResponse()],
    // The job panel follows a created job; only tests that submit one get there.
    "GET /api/jobs/job-1": [always(() => json(200, JOB))],
    ...routes,
  });
  return { ...render(<App />), user: userEvent.setup() };
}

const transcript = () => screen.getByLabelText("English Transcript") as HTMLTextAreaElement;
const first = () => screen.getByLabelText("First Sentence Start Time") as HTMLInputElement;
const last = () => screen.getByLabelText("Last Sentence Start Time") as HTMLInputElement;
const link = () => screen.getByLabelText("YouTube video link") as HTMLInputElement;
const importButton = () => screen.getByRole("button", { name: /Import transcript|Importing/ });
const generate = () => screen.getByRole("button", { name: "Generate audio" });

const isDisabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;
const isChecked = (element: HTMLElement) => (element as HTMLInputElement).checked;
/** The text of the elements an element's aria-describedby points to. */
const description = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

async function openYouTube(user: User) {
  await screen.findByText("Ada");
  await user.click(screen.getByRole("radio", { name: "YouTube URL" }));
}

async function importLink(user: User, url = LINK) {
  await user.clear(link());
  await user.type(link(), url);
  await user.click(importButton());
}

describe("when the server does not offer the import", () => {
  it("shows only the pasted transcript, which still creates a job", async () => {
    const { user } = setup({ "POST /api/jobs": [() => json(202, JOB)] }, () => json(200, META));
    await screen.findByText("Ada");
    expect(screen.queryByRole("radio", { name: "YouTube URL" })).toBeNull();
    expect(screen.queryByLabelText("YouTube video link")).toBeNull();
    await user.type(transcript(), "Spring Boot uses JSON.");
    await user.type(first(), "000010");
    await user.type(last(), "000610");
    await user.click(generate());
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body?.transcript).toBe("Spring Boot uses JSON.");
  });
});

describe("pasting stays the default", () => {
  it("starts on Paste transcript and works without touching the import", async () => {
    const { user } = setup({ "POST /api/jobs": [() => json(202, JOB)] });
    await screen.findByText("Ada");
    expect(isChecked(screen.getByRole("radio", { name: "Paste transcript" }))).toBe(true);
    expect(screen.queryByLabelText("YouTube video link")).toBeNull();
    await user.type(transcript(), "Hello there.");
    await user.type(first(), "000001");
    await user.type(last(), "000005");
    await user.click(generate());
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to(IMPORT)).toHaveLength(0);
  });
});

describe("importing a YouTube video's captions", () => {
  it("sends nothing when the field appears or a link is pasted", async () => {
    const { user } = setup();
    await openYouTube(user);
    link().focus();
    await user.paste(LINK);
    expect(link().value).toBe(LINK);
    expect(fake.to(IMPORT)).toHaveLength(0);
    expect(screen.getByText(/The link is sent to Supadata/)).toBeTruthy();
    expect(description(link())).toMatch(/sent to Supadata to fetch the English captions/);
  });

  it("fills the transcript with millisecond timestamps and the start times, and creates no job", async () => {
    const { user } = setup({ [`POST ${IMPORT}`]: [imported()] });
    await openYouTube(user);
    await importLink(user);

    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    expect(first().value).toBe("00:00:10");
    expect(last().value).toBe("00:06:10");
    expect(screen.getByLabelText("Audio length preview").textContent).toContain("00:06:00");
    expect(await screen.findByText(/Imported 3 English captions/)).toBeTruthy();
    const [request] = fake.to(IMPORT);
    expect(request?.body).toEqual({ url: LINK });
    expect(request?.headers["X-CSRF-Token"]).toBe("csrf-1");
    // Importing only fills the form.
    expect(fake.to("/api/jobs")).toHaveLength(0);
  });

  it("submits the transcript as edited after the import", async () => {
    const { user } = setup({
      [`POST ${IMPORT}`]: [imported()],
      "POST /api/jobs": [() => json(202, JOB)],
    });
    await openYouTube(user);
    await importLink(user);
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));

    await user.clear(transcript());
    await user.type(transcript(), "0:10.480{Enter}Welcome back, everyone.");
    await user.click(generate());
    await waitFor(() => expect(fake.to("/api/jobs")).toHaveLength(1));
    expect(fake.to("/api/jobs")[0]?.body).toMatchObject({
      transcript: "0:10.480\nWelcome back, everyone.",
      first_sentence_start: "00:00:10",
      last_sentence_start: "00:06:10",
    });
  });

  it("sends one request however often Import is pressed, and Generate waits", async () => {
    const pending = deferred();
    const { user } = setup({ [`POST ${IMPORT}`]: [pending.handler] });
    await openYouTube(user);
    await importLink(user);
    expect(isDisabled(importButton())).toBe(true);
    expect(importButton().textContent).toContain("Importing…");
    expect(isDisabled(generate())).toBe(true);
    expect(screen.getByText(/Importing captions/)).toBeTruthy();
    await user.click(importButton());
    link().focus();
    await user.keyboard("{Enter}");
    expect(fake.to(IMPORT)).toHaveLength(1);

    pending.release(json(200, RESULT));
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    expect(isDisabled(importButton())).toBe(false);
    expect(isDisabled(generate())).toBe(false);
  });

  it("imports on Enter in the link field instead of submitting the form", async () => {
    const { user } = setup({ [`POST ${IMPORT}`]: [imported()] });
    await openYouTube(user);
    await user.type(link(), `${LINK}{Enter}`);
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    expect(fake.to("/api/jobs")).toHaveLength(0);
  });

  it("can be used with the keyboard only", async () => {
    const { user } = setup({ [`POST ${IMPORT}`]: [imported()] });
    await screen.findByText("Ada");
    screen.getByRole("radio", { name: "Paste transcript" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(isChecked(screen.getByRole("radio", { name: "YouTube URL" }))).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(link());
    await user.keyboard(LINK);
    await user.tab();
    expect(document.activeElement).toBe(importButton());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
  });

  it("asks before replacing a transcript or start times already in the form", async () => {
    const { user } = setup({ [`POST ${IMPORT}`]: [imported()] });
    await openYouTube(user);
    await user.type(transcript(), "My own notes.");
    await user.type(first(), "000005");
    await importLink(user);

    const question = screen.getByRole("group", { name: /replaces the transcript/ });
    expect(fake.to(IMPORT)).toHaveLength(0);
    expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Replace and import" }));
    await user.click(within(question).getByRole("button", { name: "Keep my text" }));
    expect(screen.queryByRole("group", { name: /replaces the transcript/ })).toBeNull();
    expect(document.activeElement).toBe(importButton());
    expect(transcript().value).toBe("My own notes.");
    expect(first().value).toBe("00:00:05");
    expect(fake.to(IMPORT)).toHaveLength(0);

    await user.click(importButton());
    await user.click(screen.getByRole("button", { name: "Replace and import" }));
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    expect(first().value).toBe("00:00:10");
    expect(fake.to(IMPORT)).toHaveLength(1);
  });

  it("closes the question with Escape and keeps the form", async () => {
    const { user } = setup();
    await openYouTube(user);
    await user.type(last(), "000610");
    await importLink(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /replaces the transcript/ })).toBeNull();
    expect(last().value).toBe("00:06:10");
    expect(fake.to(IMPORT)).toHaveLength(0);
  });

  it("keeps the form as it was when the import fails, and can be tried again", async () => {
    const { user } = setup({
      [`POST ${IMPORT}`]: [
        () =>
          apiError(422, "youtube_import_no_english_captions", "This video has no English captions."),
        imported(),
      ],
    });
    await openYouTube(user);
    await user.type(transcript(), "Keep me.");
    await importLink(user);
    await user.click(screen.getByRole("button", { name: "Replace and import" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This video has no English captions.");
    expect(alert.textContent).toContain("Nothing in the form was changed.");
    expect(transcript().value).toBe("Keep me.");
    expect(first().value).toBe("");

    await user.click(importButton());
    await user.click(screen.getByRole("button", { name: "Replace and import" }));
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    expect(fake.to(IMPORT)).toHaveLength(2);
  });

  it("marks the link field when the server rejects the link", async () => {
    const { user } = setup({
      [`POST ${IMPORT}`]: [
        () =>
          json(422, {
            error: {
              code: "validation_error",
              message: "The request contains invalid fields.",
              fields: [{ field: "url", message: "Enter the link of a YouTube video." }],
            },
          }),
      ],
    });
    await openYouTube(user);
    await importLink(user, "https://youtube.com.example.org/watch?v=dQw4w9WgXcQ");
    await screen.findByRole("alert");
    expect(link().getAttribute("aria-invalid")).toBe("true");
    expect(description(link())).toMatch(/invalid fields/);
    // Typing a new link clears the error.
    await user.type(link(), "x");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(link().getAttribute("aria-invalid")).toBe("false");
  });

  it("asks for a link instead of sending an empty one", async () => {
    const { user } = setup();
    await openYouTube(user);
    await user.click(importButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a YouTube video link.");
    expect(fake.to(IMPORT)).toHaveLength(0);
  });

  it("stays signed in when the caption service rejects this server's key", async () => {
    const { user } = setup({
      [`POST ${IMPORT}`]: [
        () =>
          apiError(502, "youtube_import_auth_failed", "The caption service rejected the key."),
      ],
    });
    await openYouTube(user);
    await importLink(user);
    expect((await screen.findByRole("alert")).textContent).toContain("rejected the key");
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(transcript()).toBeTruthy();
  });

  it("leaves both start times empty and says so when the captions give no baseline", async () => {
    const { user } = setup({
      [`POST ${IMPORT}`]: [
        imported({
          ...RESULT,
          transcript: "0:04.100\na\n0:04.900\nb",
          caption_count: 2,
          skipped_empty_captions: 2,
          first_sentence_start: null,
          last_sentence_start: null,
        }),
      ],
    });
    await openYouTube(user);
    await importLink(user);
    await waitFor(() => expect(transcript().value).toBe("0:04.100\na\n0:04.900\nb"));
    expect(first().value).toBe("");
    expect(last().value).toBe("");
    expect(screen.getByText(/Set both start times before generating/)).toBeTruthy();
    expect(screen.getByText("2 empty captions were left out.")).toBeTruthy();
  });

  it("shows provider text as plain text, never as markup", async () => {
    const text = '0:00.000\n<img src=x onerror="alert(1)"> <b>bold</b> &amp;';
    const { user, container } = setup({
      [`POST ${IMPORT}`]: [imported({ ...RESULT, transcript: text })],
    });
    await openYouTube(user);
    await importLink(user);
    await waitFor(() => expect(transcript().value).toBe(text));
    expect(container.querySelector("img")).toBeNull();
    // The text sits in the textarea's value; no element was made from it anywhere.
    expect(transcript().children).toHaveLength(0);
    expect(container.querySelector("main b, main [onerror]")).toBeNull();
  });

  it("writes neither the link nor the transcript to browser storage", async () => {
    const { user } = setup({ [`POST ${IMPORT}`]: [imported()] });
    await openYouTube(user);
    await importLink(user);
    await waitFor(() => expect(transcript().value).toBe(IMPORTED_TRANSCRIPT));
    const stored = [window.localStorage, window.sessionStorage]
      .flatMap((storage) => Object.keys(storage).map((key) => storage.getItem(key) ?? ""))
      .join(" ");
    expect(stored).not.toContain("youtu");
    expect(stored).not.toContain("Welcome back");
  });
});

describe("an answer that arrives too late", () => {
  it("does not overwrite what the user typed meanwhile", async () => {
    const pending = deferred();
    const { user } = setup({ [`POST ${IMPORT}`]: [pending.handler] });
    await openYouTube(user);
    await importLink(user);
    await user.type(transcript(), "I typed this.");
    expect(screen.getByText(/Import cancelled because you edited the form/)).toBeTruthy();
    expect(isDisabled(importButton())).toBe(false);

    pending.release(json(200, RESULT));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript().value).toBe("I typed this.");
    expect(first().value).toBe("");
    expect(screen.queryByText(/Imported 3 English captions/)).toBeNull();
  });

  it("does not fill the form after editing a start time", async () => {
    const pending = deferred();
    const { user } = setup({ [`POST ${IMPORT}`]: [pending.handler] });
    await openYouTube(user);
    await importLink(user);
    await user.type(first(), "0000");
    pending.release(json(200, RESULT));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript().value).toBe("");
    expect(first().value).toBe("00:00");
  });

  it("does not fill the form after switching back to pasting", async () => {
    const pending = deferred();
    const { user } = setup({ [`POST ${IMPORT}`]: [pending.handler] });
    await openYouTube(user);
    await importLink(user);
    await user.click(screen.getByRole("radio", { name: "Paste transcript" }));
    expect(isDisabled(generate())).toBe(false);
    pending.release(json(200, RESULT));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript().value).toBe("");
    // Back on the link field, nothing of the dropped import is left.
    await user.click(screen.getByRole("radio", { name: "YouTube URL" }));
    expect(screen.queryByText(/Imported/)).toBeNull();
    expect(isDisabled(importButton())).toBe(false);
  });

  it("is dropped when another link is imported, and only the newer one fills the form", async () => {
    const older = deferred();
    const newer = { ...RESULT, transcript: "0:01.000\nNewer video." };
    const { user } = setup({ [`POST ${IMPORT}`]: [older.handler, imported(newer)] });
    await openYouTube(user);
    await importLink(user);
    await user.type(link(), "x"); // the link changes while the first import runs
    expect(screen.getByText(/Import cancelled because the link changed/)).toBeTruthy();
    await importLink(user, "https://youtu.be/aaaaaaaaaaa");
    await waitFor(() => expect(transcript().value).toBe("0:01.000\nNewer video."));

    older.release(json(200, RESULT));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript().value).toBe("0:01.000\nNewer video.");
    expect(fake.to(IMPORT).map((r) => r.body?.url)).toEqual([LINK, "https://youtu.be/aaaaaaaaaaa"]);
  });

  it("is dropped after signing out, and another user never sees it", async () => {
    const pending = deferred();
    const { user } = setup({
      [`POST ${IMPORT}`]: [pending.handler],
      "POST /api/auth/logout": [noContent],
      "POST /api/auth/login": [authenticated(OTHER_USER, "csrf-2")],
    });
    await openYouTube(user);
    await importLink(user);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });
    pending.release(json(200, RESULT));

    await user.type(screen.getByLabelText("Email", { selector: "input" }), "bao@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Bao");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transcript().value).toBe("");
    expect(first().value).toBe("");
    expect(screen.queryByLabelText("YouTube video link")).toBeNull();
  });

  it("is dropped when the session ends during the import; the old draft comes back", async () => {
    const { user } = setup({
      [`POST ${IMPORT}`]: [notAuthenticated],
      "POST /api/auth/login": [authenticated(USER, "csrf-2")],
    });
    await openYouTube(user);
    await user.type(transcript(), "My draft.");
    await importLink(user);
    await user.click(screen.getByRole("button", { name: "Replace and import" }));
    await screen.findByRole("heading", { name: "Sign in to MyDubb" });
    expect(screen.getByText(/session has expired/)).toBeTruthy();

    await user.type(screen.getByLabelText("Email", { selector: "input" }), "ada@example.com");
    await user.type(screen.getByLabelText("Password", { selector: "input" }), "pw-123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Ada");
    expect(transcript().value).toBe("My draft.");
  });
});
