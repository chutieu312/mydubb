import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "@playwright/test";

import { escapes, overflow, studio, theme } from "../tests/authHelpers";
import { textContrast } from "../tests/contrast";
import {
  isSameOrigin,
  liveUsersFrom,
  parseLiveEnv,
  parseLoopbackUrl,
  safeDecode,
  scrub,
  secretForms,
  type LiveUser,
} from "./core.mjs";

// LIVE browser acceptance: real Chromium, the real built UI, the real backend and a real Cognito
// DEV user pool, two pre-onboarded, email-verified users, mock providers (no Azure).
//
// Credentials (e2e/.env.live, or the file named by LIVE_ENV_FILE) never reach a message:
// 1. they are typed with keyboard.insertText after focusing the field, so no Playwright call that
//    can fail or wait carries them (a failed `fill(value)` prints the value in its call log);
// 2. assertions compare them in code and assert on booleans only;
// 3. every failure message is still scrubbed of all their forms (raw, JSON-escaped, URL-encoded).
// Every context only reaches the UI's own origin, and is signed out before it is closed, also
// when a test failed (afterAll / finally).

const envFile = process.env.LIVE_ENV_FILE
  ? resolve(process.env.LIVE_ENV_FILE)
  : fileURLToPath(new URL("../.env.live", import.meta.url));
if (!existsSync(envFile)) throw new Error("The live credentials file does not exist (see live/README.md)");
const { user1, user2, warnings } = liveUsersFrom(parseLiveEnv(readFileSync(envFile, "utf8")));
for (const warning of warnings) console.log(warning);
const secrets = secretForms([user1, user2]);
const marker = () => `LIVE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

test.describe.configure({ mode: "serial" });

/** A test whose failures can never show a credential. */
function live(name: string, body: () => Promise<void>) {
  test(name, async () => {
    try {
      await body();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(scrub(text, secrets).split("\n").slice(0, 8).join("\n"));
    }
  });
}

const watch = { consoleLeaks: 0, foreignRequests: 0, secretOutsideLogin: 0, secretInUrl: 0 };
const cleanup = { signedOut: 0, withoutSession: 0, failed: 0 };

let origin = "";
let browser: Browser;
const open = new Set<BrowserContext>();

function monitor(page: Page) {
  page.on("console", (message) => {
    if (secrets.some((secret) => message.text().includes(secret))) watch.consoleLeaks++;
  });
  page.on("request", (request) => {
    const url = request.url();
    if (secrets.some((secret) => safeDecode(url).includes(secret))) watch.secretInUrl++;
    const body = request.postData() ?? "";
    const isLogin = isSameOrigin(url, origin) && new URL(url).pathname === "/api/auth/login";
    if (!isLogin && secrets.some((secret) => body.includes(secret))) watch.secretOutsideLogin++;
  });
}

/** A browser profile that can only reach the UI's own origin; everything else is aborted. */
async function newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ ...options, baseURL: origin });
  await context.route("**/*", (route) => {
    if (isSameOrigin(route.request().url(), origin)) return route.continue();
    watch.foreignRequests++;
    return route.abort("blockedbyclient");
  });
  open.add(context);
  return context;
}

async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  monitor(page);
  return page;
}

/**
 * Best-effort sign out of whatever session this profile holds, then close it. Never throws, so a
 * cleanup problem cannot hide the error of the test that failed.
 */
async function closeContext(context: BrowserContext) {
  if (!open.delete(context)) return;
  try {
    const me = await context.request.get("/api/auth/me", { timeout: 15_000 });
    if (me.status() === 401) {
      cleanup.withoutSession++;
    } else if (me.status() === 200) {
      const { csrf_token: csrf } = (await me.json()) as { csrf_token?: string };
      const out = await context.request.post("/api/auth/logout", {
        headers: { "X-CSRF-Token": csrf ?? "", Origin: origin },
        timeout: 15_000,
      });
      if (out.status() === 204 || out.status() === 401) cleanup.signedOut++;
      else cleanup.failed++;
    } else {
      cleanup.failed++;
    }
  } catch {
    cleanup.failed++;
  }
  await context.close().catch(() => undefined);
}

let ctx1: BrowserContext;
let ctx2: BrowserContext;
let page1: Page;
let page2: Page;
const state = { account1: "", account2: "", job1: "", job2: "", marker1: marker(), marker2: marker() };

test.beforeAll(async ({ browser: b, baseURL }) => {
  browser = b;
  origin = parseLoopbackUrl(baseURL!, "LIVE_UI_URL").origin;
  ctx1 = await newContext();
  ctx2 = await newContext();
  page1 = await newPage(ctx1);
  page2 = await newPage(ctx2);
});

test.afterAll(async () => {
  for (const context of [...open]) await closeContext(context);
  console.log(
    `live cleanup: ${cleanup.signedOut} session(s) signed out, ` +
      `${cleanup.withoutSession} profile(s) without a session, ${cleanup.failed} failed`,
  );
});

const account = async (page: Page) =>
  ((await page.locator(".header .account").textContent()) ?? "").replace("Signed in as", "").trim();

/**
 * Types a credential like a user would, without putting it into any Playwright call that could
 * fail or wait (and print its arguments). On any problem only the field's name is reported.
 */
async function typeSecret(page: Page, field: Locator, value: string, label: string) {
  try {
    await field.click();
    await field.fill("");
    await page.keyboard.insertText(value);
    const typed = await field.evaluate((element) => (element as HTMLInputElement).value.length);
    if (typed !== value.length) throw new Error("incomplete");
  } catch {
    throw new Error(`could not type the ${label}`);
  }
}

/**
 * Signs in on a page that shows the sign-in form; fails with the screen reached instead. Only an
 * error inside the form counts: a notice above it (e.g. "session has expired") is already there.
 */
async function submitSignIn(page: Page, user: LiveUser) {
  await expect(page.getByLabel("Email")).toBeVisible();
  await typeSecret(page, page.getByLabel("Email"), user.email, "email");
  await typeSecret(page, page.getByLabel("Password", { exact: true }), user.password, "password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const outcome = await Promise.race([
    studio(page).waitFor({ timeout: 45_000 }).then(() => "studio"),
    page.getByRole("heading", { name: "Set your password" }).waitFor({ timeout: 45_000 }).then(() => "set-password"),
    page.getByRole("heading", { name: "Verify your email" }).waitFor({ timeout: 45_000 }).then(() => "verify-email"),
    page.locator(".gate-form form [role=alert]").waitFor({ timeout: 45_000 }).then(() => "error"),
  ]);
  if (outcome !== "studio") {
    const detail = outcome === "error" ? ((await page.locator(".gate-form form [role=alert]").textContent()) ?? "") : outcome;
    throw new Error(`sign-in did not reach the Studio: ${detail}`);
  }
}

async function signIn(page: Page, user: LiveUser) {
  await page.goto("/");
  await submitSignIn(page, user);
}

async function signOut(page: Page) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/auth/logout" && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  expect((await response).status()).toBe(204);
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
}

/** Runs a mock job to completion; checks the player and the download. Returns the job id. */
async function runJob(page: Page, text: string, voice: RegExp): Promise<string> {
  await studio(page).fill(`${text} Spring Boot uses JSON.`);
  await page.getByLabel("First Sentence Start Time").fill("00:00:05");
  await page.getByLabel("Last Sentence Start Time").fill("00:00:25");
  await page.getByLabel(voice).check();
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/jobs" && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  const response = await created;
  expect(response.status()).toBe(202);
  expect(response.request().headers()["x-csrf-token"]).toBeTruthy();
  const id = ((await response.json()) as { id: string }).id;

  await expect(page.locator(".stage.done", { hasText: "Completed" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Mock sample ready")).toBeVisible();
  const audio = page.locator("audio");
  await expect(audio).toHaveCount(1);
  await expect
    .poll(() => audio.evaluate((el) => (el as HTMLAudioElement).readyState >= 1 && (el as HTMLAudioElement).duration > 0))
    .toBe(true);
  const href = await page.getByRole("link", { name: "Download MP3" }).getAttribute("href");
  const file = await page.request.get(href!);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("audio/mpeg");
  expect(file.headers()["content-disposition"]).toContain("attachment");
  return id;
}

const statusOf = async (page: Page, path: string) => (await page.request.get(path)).status();
const jobPaths = (id: string) => [`/api/jobs/${id}`, `/api/jobs/${id}/result`, `/api/jobs/${id}/result/audio`];

live("L01 the real UI talks to the real backend: email + password, mock providers", async () => {
  await page1.goto("/");
  const meta = (await (await page1.request.get("/api/meta")).json()) as {
    auth: { mode: string; self_registration: boolean };
    providers: Record<string, string>;
  };
  // Credentials are typed only after this: a backend that is not email + password with mock
  // providers stops the run here (serial mode skips the rest).
  expect(meta.auth.mode).toBe("cognito");
  expect(meta.auth.self_registration).toBe(false);
  expect(Object.values(meta.providers)).toEqual(["mock", "mock", "mock"]);
  await expect(page1.getByLabel("Email")).toBeVisible();
  await expect(page1.getByLabel("Access Code")).toHaveCount(0);
  await expect(page1.getByText("Access is currently by invitation only.")).toBeVisible();
  await expect(page1.getByText(/sign up|create (an )?account|register/i)).toHaveCount(0);
});

live("L02 user 1 signs in; the session cookie is HttpOnly and nothing is stored in the browser", async () => {
  await signIn(page1, user1);
  state.account1 = await account(page1);
  expect(state.account1.length).toBeGreaterThan(0);

  expect(await page1.evaluate(() => document.cookie)).toBe("");
  const cookie = (await ctx1.cookies()).find((c) => c.name === "mydubb_auth");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  const stored = await page1.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(secrets.some((secret) => stored.includes(secret))).toBe(false);
  expect(/csrf|challenge|token/i.test(stored)).toBe(false);
});

live("L03 a reload restores the same user's session", async () => {
  await page1.reload();
  await expect(studio(page1)).toBeVisible();
  expect((await account(page1)) === state.account1).toBe(true);
});

live("L04 user 1 runs a mock job: completed, player loads, download works", async () => {
  state.job1 = await runJob(page1, state.marker1, /Emma Multilingual/);
  expect(state.job1.length).toBeGreaterThan(0);
});

live("L05 Light and Dark in the signed-in Studio keep the job and stay readable", async () => {
  const targets = [page1.locator(".hero h1"), page1.locator(".panel-title"), page1.getByRole("button", { name: "Generate audio" })];
  for (const mode of ["light", "dark"] as const) {
    if ((await theme(page1)) !== mode) await page1.locator(".header .pill").click();
    expect(await theme(page1)).toBe(mode);
    await expect(page1.getByText("Mock sample ready")).toBeVisible();
    for (const target of targets) expect(await textContrast(target)).toBeGreaterThanOrEqual(4.5);
    expect(await overflow(page1)).toBeLessThanOrEqual(0);
  }
  await page1.screenshot({
    path: "test-results/live-shots/desktop-studio-dark.png",
    fullPage: true,
    mask: [page1.locator(".header .account"), page1.locator("#transcript"), page1.locator(".translation")],
  });
  if ((await theme(page1)) !== "light") await page1.locator(".header .pill").click();
});

live("L06 user 1 signs out: no authenticated UI or API access remains", async () => {
  await signOut(page1);
  await page1.reload();
  await expect(page1.getByLabel("Email")).toBeVisible();
  await expect(studio(page1)).toHaveCount(0);
  expect(await statusOf(page1, "/api/auth/me")).toBe(401);
  for (const path of jobPaths(state.job1)) expect(await statusOf(page1, path), "signed-out job access").toBe(401);
});

live("L07 user 2 signs in in the same browser and sees nothing of user 1", async () => {
  await signIn(page1, user2);
  state.account2 = await account(page1);
  expect(state.account2.length).toBeGreaterThan(0);
  expect(state.account2 === state.account1).toBe(false);
  await expect(studio(page1)).toHaveValue("");
  await expect(page1.locator(".stage")).toHaveCount(0);
  expect((await page1.locator("body").innerText()).includes(state.marker1)).toBe(false);
});

live("L08 user 2 runs a mock job: completed, player loads, download works", async () => {
  state.job2 = await runJob(page1, state.marker2, /Andrew Multilingual/);
  expect(state.job2).not.toBe(state.job1);
});

live("L09 user 2 cannot reach user 1's job, result or audio", async () => {
  for (const path of jobPaths(state.job1)) expect(await statusOf(page1, path), "user 2 -> user 1's job").toBe(404);
  for (const path of jobPaths(state.job2)) expect(await statusOf(page1, path), "user 2 -> own job").toBe(200);
});

live("L10 the reverse: user 1 (new browser profile) cannot reach user 2's job; own job is still there", async () => {
  await signIn(page2, user1);
  expect((await account(page2)) === state.account1).toBe(true);
  for (const path of jobPaths(state.job2)) expect(await statusOf(page2, path), "user 1 -> user 2's job").toBe(404);
  for (const path of jobPaths(state.job1)) expect(await statusOf(page2, path), "user 1 -> own job").toBe(200);
  await expect(studio(page2)).toHaveValue("");
  expect((await page2.locator("body").innerText()).includes(state.marker2)).toBe(false);
});

live("L11 an expired session: the same user gets the draft back, another user does not", async () => {
  // Page A (user 1) holds an unsent draft. Page B, same browser profile, signs out: the server
  // session ends, so page A finds out on its next request.
  const draft = marker();
  const pageB = await newPage(ctx2);
  await studio(page2).fill(`${draft} unsent draft`);
  await page2.getByLabel("First Sentence Start Time").fill("00:00:05");
  await page2.getByLabel("Last Sentence Start Time").fill("00:00:25");

  await pageB.goto("/");
  await expect(studio(pageB)).toBeVisible();
  await signOut(pageB);

  await page2.getByRole("button", { name: "Generate audio" }).click();
  await expect(page2.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
  await expect(page2.getByRole("alert")).toContainText("session has expired");

  // Same user, same page (no reload, the page memory is kept): the draft is back.
  await submitSignIn(page2, user1);
  expect((await studio(page2).inputValue()).includes(draft)).toBe(true);

  // Expire again, then user 2 signs in on that page: nothing of user 1's draft is shown.
  await pageB.goto("/");
  await expect(studio(pageB)).toBeVisible();
  await signOut(pageB);
  await page2.getByRole("button", { name: "Generate audio" }).click();
  await expect(page2.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
  await submitSignIn(page2, user2);
  expect((await studio(page2).inputValue()).includes(draft)).toBe(false);
  expect((await studio(page2).inputValue()) === "").toBe(true);
  await pageB.close();
});

live("L12 mobile viewport (390 px): sign in screen and Studio in Light and Dark", async () => {
  const mobile = await newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  try {
    const page = await newPage(mobile);
    await page.goto("/");
    await expect(page.getByLabel("Email")).toBeVisible();
    for (const mode of ["light", "dark"] as const) {
      if ((await theme(page)) !== mode) await page.locator(".header .pill").click();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await escapes(page)).toEqual([]);
      for (const target of [page.locator(".gate-form h2"), page.locator(".button.primary").first()]) {
        expect(await textContrast(target)).toBeGreaterThanOrEqual(4.5);
      }
      // Taken before anything is typed.
      await page.screenshot({ path: `test-results/live-shots/mobile-sign-in-${mode}.png`, fullPage: true });
    }
    if ((await theme(page)) !== "light") await page.locator(".header .pill").click();

    await submitSignIn(page, user2);
    for (const mode of ["light", "dark"] as const) {
      if ((await theme(page)) !== mode) await page.locator(".header .pill").click();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await escapes(page)).toEqual([]);
      await expect(studio(page)).toHaveValue("");
      await page.screenshot({
        path: `test-results/live-shots/mobile-studio-${mode}.png`,
        fullPage: true,
        mask: [page.locator(".header .account")],
      });
    }
    await signOut(page);
  } finally {
    await closeContext(mobile);
  }
});

live("L13 every remaining session is signed out through the UI", async () => {
  for (const page of [page1, page2]) {
    await page.goto("/");
    // Wait until the page has decided (Studio or sign in) before looking at it.
    await expect(studio(page).or(page.getByLabel("Email"))).toBeVisible();
    if (await studio(page).isVisible()) await signOut(page);
    await page.reload();
    await expect(page.getByLabel("Email")).toBeVisible();
    expect(await statusOf(page, "/api/auth/me")).toBe(401);
  }
});

live("L14 privacy: no credential in the console, a URL, storage, or a request other than sign in; no foreign origin", async () => {
  expect(watch.consoleLeaks).toBe(0);
  expect(watch.secretInUrl).toBe(0);
  expect(watch.secretOutsideLogin).toBe(0);
  expect(watch.foreignRequests).toBe(0);
});
