import { randomInt } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createUser, escapes, fillSignIn, overflow, startJob, studio } from "./authHelpers";

// "Try as guest" against the real backend (mock providers, in-memory user pool stand-in). Each test
// sends its own client address in the stack's CLIENT_IP_HEADER, so tests never share a network
// quota; the server, not the browser, decides every limit.

const IP_HEADER = "x-e2e-client-ip";
const randomAddress = () => `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;

async function asClient(page: Page, address = randomAddress()) {
  await page.setExtraHTTPHeaders({ [IP_HEADER]: address });
  return address;
}

const banner = (page: Page) => page.getByRole("region", { name: "Guest mode" });

async function startGuest(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try as guest" }).click();
  await expect(banner(page)).toBeVisible();
}

async function runJob(page: Page, transcript = "Spring Boot uses JSON.") {
  await startJob(page, transcript);
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByRole("heading", { name: "Your audio" })).toBeVisible({ timeout: 30_000 });
}

test("a guest creates, plays and downloads audio, and sees the jobs left", async ({ page }) => {
  await asClient(page);
  await page.goto("/");
  await expect(page.getByText("No invitation yet? Try MyDubb as a guest")).toBeVisible();
  // Starting a session calls no provider and creates no job: only the session request is sent.
  const started = page.waitForResponse((r) => r.url().endsWith("/api/guest/session"));
  await page.getByRole("button", { name: "Try as guest" }).click();
  expect((await started).status()).toBe(201);

  await expect(banner(page)).toContainText(
    "5 audio jobs left · up to 1,000 words and 10 minutes of audio per job",
  );
  await expect(page.getByText("Guest", { exact: true })).toBeVisible();
  // YouTube import is enabled on this stack: a guest has it too, with its own count
  // (guestImport.spec.ts).
  await expect(page.getByRole("radio", { name: "YouTube URL" })).toBeVisible();
  await expect(banner(page)).toContainText("5 YouTube imports left");

  await runJob(page);
  await expect(page.locator("audio")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download MP3/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^mydubb-.*\.mp3$/);
  await expect(banner(page)).toContainText("4 audio jobs left");

  // A reload keeps the guest session (an HttpOnly cookie) and its count.
  await page.reload();
  await expect(banner(page)).toContainText("4 audio jobs left");
  const stored = await page.evaluate(() => [
    ...Object.keys(window.sessionStorage),
    ...Object.keys(window.localStorage).filter((key) => key !== "mydubb-theme"),
  ]);
  expect(stored).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("the sixth job of a guest session is refused with a way to sign in", async ({ page }) => {
  test.setTimeout(150_000);
  await asClient(page);
  await startGuest(page);
  for (let index = 0; index < 5; index += 1) await runJob(page, `Guest job number ${index + 1}.`);
  await expect(banner(page)).toContainText("0 audio jobs left");
  await expect(banner(page)).toContainText("This guest session has used all 5 of its jobs");

  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByRole("alert")).toContainText("This guest session has used all 5");
  await page.getByRole("button", { name: "Sign in with an invitation" }).first().click();
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();
});

test("guests on one network share its quota; another network is separate", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const address = await asClient(page);
  // Four other guest sessions from the same network complete 20 jobs (API only, own cookies).
  const others = await browser.newContext({
    extraHTTPHeaders: { [IP_HEADER]: address },
    baseURL: testInfo.project.use.baseURL,
  });
  try {
    for (let session = 0; session < 4; session += 1) {
      await others.clearCookies();
      const start = await others.request.post("/api/guest/session");
      expect(start.status()).toBe(201);
      const csrf = (await start.json()).csrf_token as string;
      // One job at a time: the quota is what is tested, not the small stack's job capacity
      // (other tests run jobs on the same instance meanwhile).
      for (let job = 0; job < 5; job += 1) {
        const created = await others.request.post("/api/jobs", {
          headers: { "X-CSRF-Token": csrf },
          data: {
            transcript: "Shared network job.",
            first_sentence_start: "00:00:05",
            last_sentence_start: "00:00:25",
            voice: "AndrewMultilingual",
          },
        });
        expect(created.status()).toBe(202);
        const id = (await created.json()).id as string;
        await expect
          .poll(async () => (await (await others.request.get(`/api/jobs/${id}`)).json()).status, {
            timeout: 60_000,
          })
          .toBe("completed");
      }
    }
  } finally {
    await others.close();
  }

  await startGuest(page);
  await expect(banner(page)).toContainText("0 audio jobs left");
  await expect(banner(page)).toContainText("everyone on the same network shares this limit");
  await startJob(page);
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByRole("alert")).toContainText("Guests on your network have used all 20");

  // The same guest session from another network can still create jobs.
  await asClient(page, randomAddress());
  await page.reload();
  await expect(banner(page)).toContainText("5 audio jobs left");
});

test("audio longer than 10 minutes is refused before anything runs", async ({ page }) => {
  await asClient(page);
  await startGuest(page);
  await studio(page).fill("Short transcript, long stretch.");
  const first = page.getByLabel("First Sentence Start Time");
  const last = page.getByLabel("Last Sentence Start Time");
  await first.fill("00:00:00");
  await last.fill("00:05:01");
  await page.getByRole("radio", { name: "0.5x" }).check();
  await expect(page.getByText(/Choose a shorter stretch/)).toBeVisible();

  const refused = page.waitForResponse((r) => r.url().endsWith("/api/jobs"));
  await page.getByRole("button", { name: "Generate audio" }).click();
  expect((await refused).status()).toBe(422);
  await expect(page.getByText(/Guest audio can be at most 10:00 long/).first()).toBeVisible();
  await expect(last).toHaveValue("00:05:01"); // never adjusted
  await expect(banner(page)).toContainText("5 audio jobs left");

  // Exactly 10 minutes (5 minutes at 0.5x) is accepted.
  await last.fill("00:05:00");
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByRole("heading", { name: "Your audio" })).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toContainText("4 audio jobs left");
});

test("a word count over the limit is refused by the server", async ({ page }) => {
  await asClient(page);
  await startGuest(page);
  const long = Array.from({ length: 1001 }, (_, i) => `word${i}`).join(" ");
  await startJob(page, long);
  await expect(page.getByText(/About 1,001 of 1,000 words/)).toBeVisible();
  await page.getByRole("button", { name: "Generate audio" }).click();
  await expect(page.getByText(/Guest jobs can have at most 1,000 words/).first()).toBeVisible();
  await expect(banner(page)).toContainText("5 audio jobs left");
});

test("leaving guest mode, then signing in, starts from an empty form", async ({ page }) => {
  await asClient(page);
  await startGuest(page);
  await studio(page).fill("A guest draft that an account must never see");
  await page.getByRole("button", { name: "Leave guest mode" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to MyDubb" })).toBeVisible();

  const user = await createUser();
  await fillSignIn(page, user);
  await expect(studio(page)).toBeVisible();
  await expect(studio(page)).toHaveValue("");
  await expect(banner(page)).toHaveCount(0);
  // An account sees YouTube import again (enabled on this stack).
  await expect(page.getByRole("radio", { name: "YouTube URL" })).toBeVisible();
});

test("the guest entry fits the sign-in card on narrow screens", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Try as guest" })).toBeVisible();
    expect(await overflow(page), `${width}px`).toBeLessThanOrEqual(0);
    expect(await escapes(page), `${width}px`).toEqual([]);
  }
});
