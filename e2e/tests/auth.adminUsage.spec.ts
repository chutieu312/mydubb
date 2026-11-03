import { expect, test, type Page } from "@playwright/test";

import {
  createUser,
  overflow,
  setAdminRole,
  signInAs,
  startJob,
  studio,
  type TestUser,
} from "./authHelpers";

// Usage & Costs through the real stack: routes, sessions, the Content-Security-Policy, PostgreSQL
// and the job pipeline with mock providers (their requests are labelled mock, never cost).

const PAGE = "/admin/usage";

async function runMockJob(page: Page): Promise<string> {
  await startJob(page, "Spring Boot uses JSON.");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate audio" }).click();
  const job = (await (await created).json()) as { id: string };
  await expect(page.getByRole("heading", { name: "Your audio", exact: true })).toBeVisible({
    timeout: 45_000,
  });
  return job.id;
}

async function admin(page: Page): Promise<TestUser> {
  const user = await createUser({ name: "Po" });
  await signInAs(page, user);
  await setAdminRole(user.email, true);
  await page.reload();
  await expect(studio(page)).toBeVisible();
  return user;
}

test("an ordinary user gets no link, no page and no report", async ({ page }) => {
  await signInAs(page, await createUser());
  await expect(page.getByRole("link", { name: "Usage & Costs" })).toHaveCount(0);

  await page.goto(PAGE);
  await expect(page.getByText("This page is for MyDubb administrators.")).toBeVisible();
  await expect(page.getByText("Reference cost — not an invoice.")).toHaveCount(0);
  const refused = await page.request.get("/api/admin/usage/summary");
  expect(refused.status()).toBe(403);
  expect(refused.headers()["cache-control"]).toBe("no-store");

  await page.getByRole("link", { name: "Back to Studio" }).click();
  await expect(studio(page)).toBeVisible();
});

test("nobody signed in sees the sign-in form on the page's address", async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.getByLabel("Email")).toBeVisible();
  expect((await page.request.get("/api/admin/usage/jobs")).status()).toBe(401);
});

test("an administrator reads a real job's usage, then loses access on the next request", async ({
  page,
}, testInfo) => {
  const user = await admin(page);
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  const jobId = await runMockJob(page);

  // The draft of this page's memory, kept while looking at the report.
  const draft = "Still here after visiting the report.";
  await studio(page).fill(draft);

  await page.getByRole("link", { name: "Usage & Costs" }).click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Usage & Costs" })).toBeVisible();
  await expect(page.getByText("Reference cost — not an invoice.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Jobs with usage" })).toBeVisible();
  expect(page.url()).not.toContain("Still");

  // One job, by its id; only Apply asks.
  let requests = 0;
  const count = (url: string) => {
    if (url.includes("/api/admin/usage/")) requests += 1;
  };
  page.on("request", (request) => count(request.url()));
  await page.getByLabel("Job ID").fill(jobId);
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "Apply" }).click();
  const row = page.getByRole("row").filter({ hasText: jobId });
  await expect(row).toBeVisible();
  await expect(row.getByText("Mock: not billed")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "View usage" })).toHaveCount(1);
  await expect(page.getByText("No usage with a reference price here.")).toBeVisible();

  // A reload and a direct address show the same thing.
  await page.reload();
  await expect(row).toBeVisible();
  await expect(page.getByLabel("Job ID")).toHaveValue(jobId);

  await row.getByRole("button", { name: `View usage of job ${jobId}` }).click();
  const detail = page.getByRole("region", { name: new RegExp(`Usage of job ${jobId}`) });
  await expect(detail.getByRole("heading", { name: /Provider requests/ })).toBeVisible();
  await expect(detail.getByText("mock-not-billed").first()).toBeVisible();
  await expect(detail.getByText("Mock: not billed").first()).toBeVisible();
  await expect(detail.locator("audio")).toHaveCount(0);

  await page.goBack();
  await expect(detail).toHaveCount(0);
  await expect(row).toBeVisible();

  await expect(await overflow(page)).toBeLessThanOrEqual(0);
  // The other appearance works the same, and comes through a reload.
  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(page.getByRole("button", { name: "Light mode" })).toBeVisible();
  await expect(row).toBeVisible();
  await testInfo.attach("usage page, dark", { body: await page.screenshot(), contentType: "image/png" });

  // Revoked: the next request refuses, the figures go, the session stays.
  await setAdminRole(user.email, false);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText(/administrator access has ended/)).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Usage & Costs" })).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");

  expect(violations).toEqual([]);
});

test("the report does not cost the Studio its draft, job or audio", async ({ page }) => {
  await admin(page);
  await runMockJob(page);
  const draft = "A draft that stays in page memory only.";
  await studio(page).fill(draft);
  const player = page.locator("audio");
  await expect(player).toBeAttached();
  await player.evaluate((audio: HTMLAudioElement) => audio.play().catch(() => undefined));

  await page.getByRole("link", { name: "Usage & Costs" }).click();
  await expect(page.getByText("Reference cost — not an invoice.")).toBeVisible();
  await expect(studio(page)).toBeHidden();
  expect(await player.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(draft);

  await page.goBack();
  await expect(studio(page)).toHaveValue(draft);
  await expect(page.getByRole("heading", { name: "Your audio", exact: true })).toBeVisible();
  await expect(player).toBeVisible();

  // Forward again; signing out clears what the page held.
  await page.goForward();
  await expect(page.getByText("Reference cost — not an invoice.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByText("Reference cost — not an invoice.")).toHaveCount(0);
});
