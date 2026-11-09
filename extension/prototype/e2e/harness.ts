// Harness of the Sync prototype's browser tests: the prototype's test build (dist-prototype-test/)
// in Playwright's Chromium, the local fixture server (server.ts) under site.test / player.test /
// blocked.test, and the lab page opened as a tab for the fixture's tab id. Fixture evidence only:
// no real site is contacted by these tests.

import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFixtureServer } from "./server";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..", "..", "dist-prototype-test");
export const OUT_DIR = join(here, "..", "..", "test-results", "prototype-reports");

type Fixtures = {
  /** "allowed": media plays without a gesture; "user-activation": Chrome's policy needing the user's input on the page, with no exception. */
  autoplay: "allowed" | "user-activation";
  server: { port: number };
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
};

export const test = base.extend<Fixtures>({
  autoplay: ["allowed", { option: true }],
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const server = await startFixtureServer();
    await use(server);
    await server.close();
  },
  context: async ({ autoplay }, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--host-resolver-rules=MAP *.test 127.0.0.1",
        // Playwright's Chromium does not refuse play() by itself; the "Play refused" tests ask for the
        // policy that needs the user's input on the page (Chrome's default adds exceptions to it).
        `--autoplay-policy=${autoplay === "allowed" ? "no-user-gesture-required" : "document-user-activation-required"}`,
      ],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker")));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
});

export { expect };

export const site = (port: number, path: string) => `http://site.test:${port}${path}`;

/**
 * Opens the page, then the lab for its tab (the lab is a tab here; in Chrome it is the side panel).
 * `untouched`: no page.evaluate before the test acts. Playwright evaluates with a user gesture, which
 * gives the page the user activation that Chrome's autoplay policy asks for.
 */
export async function openWithLab(context: BrowserContext, worker: Worker, extensionId: string, url: string, untouched = false) {
  const page = await context.newPage();
  await page.goto(url);
  if (untouched) await page.waitForTimeout(1000);
  else await expect.poll(() => page.evaluate(() => document.querySelector("video")?.readyState ?? 4)).toBeGreaterThan(0);
  const tabId = await worker.evaluate(async (href) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === href)?.id ?? -1;
  }, page.url());
  expect(tabId).toBeGreaterThan(-1);
  const lab = await context.newPage();
  await lab.goto(`chrome-extension://${extensionId}/lab.html?tabId=${tabId}`);
  await expect.poll(() => lab.evaluate(() => (document.getElementById("audio") as HTMLAudioElement).readyState)).toBeGreaterThan(0);
  return { page, lab, tabId };
}

export async function scan(lab: Page) {
  await lab.getByRole("button", { name: "Scan this tab" }).click();
}

/**
 * The lab's Scan without a user gesture, asked by the service worker. Playwright's evaluate gives the
 * lab a transient activation (5 s) that an extension call would carry into the page: none in the 6 s before.
 */
export async function scanWithoutGesture(lab: Page, worker: Worker, tabId: number) {
  await lab.waitForTimeout(6000);
  await worker.evaluate((id) => chrome.runtime.sendMessage({ type: "proto:scan", tabId: id }), tabId);
}

export const decision = (lab: Page) => lab.locator("#decision");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Report = any;

export const report = (lab: Page): Promise<Report> =>
  lab.evaluate(() => (globalThis as unknown as { protoReport(): unknown }).protoReport());

/** Keeps the lab's report of a test as evidence (test-results/prototype-reports/, not committed). */
export async function keepReport(lab: Page, name: string): Promise<Report> {
  const r = await report(lab);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(r, null, 2));
  return r;
}

export async function syncOn(lab: Page, rate: string) {
  await lab.locator("#rate").selectOption(rate);
  await lab.getByRole("button", { name: "Turn Sync on" }).click();
  await expect(lab.locator("#sync-status")).toContainText("ON · Paused");
}

export const audioState = (lab: Page) =>
  lab.evaluate(() => {
    const a = document.getElementById("audio") as HTMLAudioElement;
    return { paused: a.paused, t: a.currentTime };
  });

export const videoState = (page: Page, index = 0) =>
  page.evaluate((i) => (window as unknown as { fixture: { state(i: number): { paused: boolean; t: number; rate: number; muted: boolean; src: string } } }).fixture.state(i), index);

export const wait = (page: Page, ms: number) => page.waitForTimeout(ms);
