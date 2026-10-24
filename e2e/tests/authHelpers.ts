import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

// Helpers for the email + password stack: the real MyDubb backend with an in-memory stand-in for
// the user pool (e2e/fake-cognito/serve.py). The control server plays the administrator who
// invites users and the inbox where verification codes arrive.

export const PASSWORD = "Passw0rd-e2e";

function controlUrl(): string {
  const url = process.env.E2E_CONTROL_URL;
  if (!url) throw new Error("E2E_CONTROL_URL is not set (use e2e/run-e2e.sh)");
  return url;
}

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`E2E control ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

export interface TestUser {
  email: string;
  password: string;
  name: string | null;
}

/** Invites a user. Default: a verified account with a name and a normal password. */
export async function createUser(
  options: {
    name?: string | null;
    temporary?: boolean;
    emailVerified?: boolean;
    password?: string;
    emailLength?: number;
  } = {},
): Promise<TestUser> {
  const local = `e2e-${randomUUID().slice(0, 8)}`;
  const padding = options.emailLength ? "x".repeat(Math.max(0, options.emailLength - local.length - 12)) : "";
  const user: TestUser = {
    email: `${local}${padding}@example.com`,
    password: options.password ?? PASSWORD,
    name: options.name === undefined ? "Ada" : options.name,
  };
  await control("/users", {
    email: user.email,
    password: user.password,
    name: user.name,
    temporary: options.temporary ?? false,
    email_verified: options.emailVerified ?? true,
  });
  return user;
}

export async function codesFor(email: string) {
  return control<{ verification_code: string | null; reset_code: string | null }>(
    `/codes/${encodeURIComponent(email)}`,
  );
}

/** The code the stand-in "emailed", once it exists. */
export async function emailedCode(email: string, kind: "verification_code" | "reset_code") {
  let code: string | null = null;
  await expect
    .poll(async () => (code = (await codesFor(email))[kind]), { message: `waiting for ${kind}` })
    .not.toBeNull();
  return code as unknown as string;
}

export const disableUser = (email: string) => control("/disable", { email });

export const failNext = (
  operation: "InitiateAuth" | "ForgotPassword" | "ConfirmForgotPassword",
  email: string,
  kind: "unavailable" | "rate_limited" = "unavailable",
) => control("/fail-next", { operation, email, kind });

export const studio = (page: Page): Locator => page.getByLabel("English Transcript");

export async function fillSignIn(page: Page, user: Pick<TestUser, "email" | "password">) {
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

export async function signInAs(page: Page, user: TestUser): Promise<void> {
  await page.goto("/");
  await fillSignIn(page, user);
  await expect(studio(page)).toBeVisible();
}

export async function startJob(
  page: Page,
  transcript = "Spring Boot uses JSON.",
  voice: "Andrew Multilingual" | "Emma Multilingual" = "Andrew Multilingual",
) {
  await studio(page).fill(transcript);
  await page.getByLabel("First Sentence Start Time").fill("00:00:05");
  await page.getByLabel("Last Sentence Start Time").fill("00:00:25");
  await page.getByLabel(new RegExp(voice)).check();
}

export const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

export const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
