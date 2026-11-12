// Story 5 integration check against the REAL MyDubb backend and website (React build), with
// Chrome's REAL sign-in window: an ordinary build of the extension (no test hook) calls
// chrome.identity.launchWebAuthFlow, and the window it opens is driven like any page. Mock
// providers, the fake user pool and fake reCAPTCHA siteverify of the e2e stack, a throwaway
// database. Not part of CI: see integration/README.md for how to run it.
//
// What it shows that the fixture tests cannot: the sign-in window shares the Chrome profile's
// mydubb.com cookies, so the extension continues the very guest session of the website (web
// first), the website later opens the guest session the extension started (extension first, the
// website never opened before), and an account created on the website then connects with its
// Free plan numbers.

import { randomUUID } from "node:crypto";

import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";

const ORIGIN = process.env.UAT_ORIGIN ?? "http://127.0.0.1:8105";
const CONTROL = process.env.UAT_CONTROL ?? "http://127.0.0.1:8106";
const EXTENSION_DIR = process.env.UAT_EXTENSION_DIR ?? "";
const PASSWORD = "Passw0rd-story5";
const TRANSCRIPT = "Hello and welcome to the course.\nThis is the second sentence.";

// Google's reCAPTCHA browser script, replaced by a stand-in at its real address (as e2e/ does).
const FAKE_GOOGLE_SCRIPT = `
window.grecaptcha = {
  render: function (target, p) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = "Fake robot check";
    b.addEventListener("click", function () { p.callback("ok-" + Math.random().toString(36).slice(2) + Date.now()); });
    target.append(b);
    return 0;
  },
  reset: function () {},
};
window.mydubbRecaptchaReady();
`;

test.skip(!EXTENSION_DIR, "UAT_EXTENSION_DIR is not set (see integration/README.md)");

async function launch(): Promise<{ context: BrowserContext; worker: Worker; id: string }> {
  // A new, empty Chrome profile each time.
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  await context.route(/^https:\/\/www\.google\.com\/recaptcha\/api\.js/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: FAKE_GOOGLE_SCRIPT }),
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  return { context, worker, id: new URL(worker.url()).host };
}

/** A tab to work on (a static page of the site) and the extension's panel for it. */
async function panelFor(context: BrowserContext, worker: Worker, id: string): Promise<Page> {
  const ids = () => worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id!));
  const before = new Set(await ids());
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/extension-privacy.html`);
  const tabId = (await ids()).find((t) => !before.has(t))!;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html?tabId=${tabId}`);
  // The panel has the server's options (and so its choices) once languages are listed.
  await expect(panel.locator("#target-language option")).not.toHaveCount(0);
  return panel;
}

/** Clicks a panel button that opens Chrome's sign-in window, and returns that window. */
async function signInWindow(context: BrowserContext, panel: Page, button: string): Promise<Page> {
  const [win] = await Promise.all([context.waitForEvent("page"), panel.getByRole("button", { name: button }).click()]);
  await win.waitForLoadState();
  expect(new URL(win.url()).origin).toBe(ORIGIN);
  return win;
}

async function generate(panel: Page) {
  await panel.getByRole("textbox", { name: "English transcript" }).fill(TRANSCRIPT);
  await panel.locator("#first-start").fill("00:00:10");
  await panel.locator("#last-start").fill("00:00:40");
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect(panel.locator("#player-state")).not.toHaveText("");
}

/** The website's guest session as the website itself reports it (cookie of this profile). */
async function webGuest(page: Page): Promise<{ id: string; left: number; csrf: string }> {
  return page.evaluate(async () => {
    const body = await (await fetch("/api/guest/session")).json();
    return { id: body.guest.id, left: body.quota.session_remaining, csrf: body.csrf_token };
  });
}

async function storedAuth(worker: Worker): Promise<{ guest?: true; user: { id: string } } | undefined> {
  return worker.evaluate(
    async () => (await chrome.storage.session.get("auth")).auth as { guest?: true; user: { id: string } } | undefined,
  );
}

test("web first: 2 of 5 on the website, the extension continues and sees 3, then the website sees 2", async () => {
  const { context, worker, id } = await launch();
  try {
    // The website: Try as guest, two jobs, then the tab is closed.
    const web = await context.newPage();
    await web.goto(ORIGIN);
    await web.getByRole("button", { name: "Try as guest" }).click();
    await expect(web.getByText(/Guest mode\./)).toBeVisible();
    const before = await webGuest(web);
    for (let i = 0; i < 2; i += 1) {
      const job = await web.evaluate(async ({ csrf, transcript }) => {
        const response = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ transcript, first_sentence_start: "00:00:10", last_sentence_start: "00:00:40", voice: "AndrewMultilingual" }),
        });
        return (await response.json()).id as string;
      }, { csrf: before.csrf, transcript: TRANSCRIPT });
      await expect.poll(() => web.evaluate(async (j) => (await (await fetch(`/api/jobs/${j}`)).json()).status, job), { timeout: 30_000 }).toBe("completed");
    }
    expect((await webGuest(web)).left).toBe(3);
    await web.close();

    // The extension: Try as guest. The real sign-in window sees the profile's guest cookie.
    const panel = await panelFor(context, worker, id);
    const win = await signInWindow(context, panel, "Try as guest");
    await expect(win.getByText("3 of 5 audio jobs left")).toBeVisible();
    await win.getByRole("button", { name: "Continue in the extension" }).click();
    await expect(panel.locator("#account-status")).toHaveText("Guest session");
    expect((await storedAuth(worker))?.user.id).toBe(`guest:${before.id}`);
    await expect(panel.locator("#allowance")).toHaveText("Guest: 3 of 5 audio jobs left.");

    await generate(panel);
    await expect(panel.locator("#allowance")).toHaveText("Guest: 2 of 5 audio jobs left.");

    // The website, opened again: the same guest session, 2 left.
    const again = await context.newPage();
    await again.goto(ORIGIN);
    await expect(again.getByText(/Guest mode\. 2 audio jobs left/)).toBeVisible();
    expect((await webGuest(again)).id).toBe(before.id);
  } finally {
    await context.close();
  }
});

test("extension first, website never opened: cancel, start the guest session, then the website opens it", async () => {
  const { context, worker, id } = await launch();
  try {
    const panel = await panelFor(context, worker, id);
    // Closing the sign-in window connects nothing.
    const cancelled = await signInWindow(context, panel, "Try as guest");
    await expect(cancelled.getByRole("heading", { name: "Try MyDubb as a guest" })).toBeVisible();
    await cancelled.close();
    await expect(panel.locator("#account-error")).toContainText("closed before connecting");
    expect(await storedAuth(worker)).toBeUndefined();

    const win = await signInWindow(context, panel, "Try as guest");
    await win.getByRole("button", { name: "Start guest session" }).click();
    await expect(panel.locator("#account-status")).toHaveText("Guest session");
    await expect(panel.locator("#allowance")).toHaveText("Guest: 5 of 5 audio jobs left.");
    await generate(panel);
    await expect(panel.locator("#allowance")).toHaveText("Guest: 4 of 5 audio jobs left.");

    // Reconnecting the same guest gives no new job.
    await panel.locator("#header-details > summary").click();
    await panel.getByRole("button", { name: "Disconnect" }).click();
    const back = await signInWindow(context, panel, "Try as guest");
    await back.getByRole("button", { name: "Continue in the extension" }).click();
    await expect(panel.locator("#allowance")).toHaveText("Guest: 4 of 5 audio jobs left.");

    const web = await context.newPage();
    await web.goto(ORIGIN);
    await expect(web.getByText(/Guest mode\. 4 audio jobs left/)).toBeVisible();
    expect(`guest:${(await webGuest(web)).id}`).toBe((await storedAuth(worker))?.user.id);
  } finally {
    await context.close();
  }
});

test("Create a MyDubb account on the website, verify, Connect: the panel shows the Free plan", async () => {
  const { context, worker, id } = await launch();
  const email = `story5-${randomUUID().slice(0, 8)}@example.com`;
  try {
    const panel = await panelFor(context, worker, id);
    const [signup] = await Promise.all([context.waitForEvent("page"), panel.getByRole("link", { name: "Create a MyDubb account" }).click()]);
    await expect(signup.getByRole("heading", { name: "Create your account" })).toBeVisible();
    expect(new URL(signup.url()).pathname).toBe("/signup");
    await signup.getByLabel("Email").fill(email);
    await signup.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await signup.getByRole("button", { name: "Fake robot check" }).click();
    await signup.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(signup.getByRole("heading", { name: "Verify your email" })).toBeVisible();
    const codes = await (await fetch(`${CONTROL}/codes/${encodeURIComponent(email)}`)).json();
    await signup.getByLabel("Verification code").fill(codes.signup_code);
    await signup.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(signup.getByText(/Your email is verified/)).toBeVisible();

    // Back in the panel: Connect, sign in on mydubb.com in the sign-in window, approve.
    const win = await signInWindow(context, panel, "Connect to MyDubb");
    await win.getByLabel("Email").fill(email);
    await win.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await win.getByRole("button", { name: "Sign in", exact: true }).click();
    await win.getByRole("button", { name: "Connect extension" }).click();
    await expect(panel.locator("#account-status")).toHaveText(`Connected as ${email}`);
    await expect(panel.locator("#allowance")).toHaveText("Free plan: 20 of 20 Generates left today (counts start again at 00:00 UTC).");
    await generate(panel);
    await expect(panel.locator("#allowance")).toHaveText("Free plan: 19 of 20 Generates left today (counts start again at 00:00 UTC).");
  } finally {
    await context.close();
  }
});
