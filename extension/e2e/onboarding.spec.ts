// Story 5 in the real extension build, against the fake MyDubb server of harness.ts: the ways in
// before connecting (Connect to MyDubb, Create a MyDubb account, Try as guest), a guest who
// generates and listens on an ordinary page, and a guest who then connects an account.
// Local evidence only: the fake stands in for mydubb.com (the same guest session on the website
// and in the extension is shown against the real backend by the integration check, see
// docs/EXTENSION_AUTH.md "Guests"), and a test hook stands in for Chrome's sign-in window.

import type { Page } from "@playwright/test";
import {
  MYDUBB,
  META_ONBOARDING,
  allowConnect,
  expect,
  fillTimes,
  openPanel,
  openWebPage,
  playerSessions,
  test,
  webUrl,
} from "./harness";

const GENERATE = "Generate audio";

async function noSideScroll(panel: Page) {
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("not connected: the three ways in, each only when MyDubb offers it, light and dark, narrow", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  const { tabId } = await openWebPage(context, worker, webUrl("onboard-1"));
  // Sign-up and guests off: Connect only, no link to a sign-up that is off.
  let panel = await openPanel(context, extensionId, tabId);
  await expect(panel.getByRole("button", { name: "Connect to MyDubb" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Create a MyDubb account" })).toBeHidden();
  await expect(panel.getByRole("button", { name: "Try as guest" })).toBeHidden();
  await panel.close();

  mydubb.meta = META_ONBOARDING;
  panel = await openPanel(context, extensionId, tabId);
  const onboarding = panel.getByRole("region", { name: "Connect MyDubb to generate audio" });
  await expect(onboarding.getByRole("button", { name: "Connect to MyDubb" })).toBeVisible();
  const signup = onboarding.getByRole("link", { name: "Create a MyDubb account" });
  await expect(signup).toBeVisible();
  await expect(signup).toHaveAttribute("href", `${MYDUBB}/signup`);
  await expect(signup).toHaveAttribute("target", "_blank");
  await expect(onboarding).toContainText("verify your email, then come back here and choose Connect to MyDubb");
  await expect(onboarding.getByRole("button", { name: "Try as guest" })).toBeVisible();
  await expect(onboarding).toContainText("up to 5 audio jobs of up to 1,000 words and 10 minutes each");
  // Nothing is asked of MyDubb but its options until the user chooses.
  expect(mydubb.requests.map((r) => r.path)).toEqual(["/api/meta", "/api/meta"]);

  for (const scheme of ["light", "dark"] as const) {
    await panel.emulateMedia({ colorScheme: scheme });
    for (const width of [320, 390]) {
      await panel.setViewportSize({ width, height: 800 });
      await noSideScroll(panel);
      const box = (await onboarding.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await panel.screenshot({ path: test.info().outputPath(`onboarding-${scheme}-${width}.png`) });
    }
  }
});

test("Try as guest: mode=guest, then Paste, Generate and listen on a page without video", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  mydubb.meta = META_ONBOARDING;
  // Web first: the website's guest session has used 2 of its 5 jobs already.
  mydubb.guestSession = { id: "6f1c1d6e-5a8b-4b8e-9d3a-2a1c3e4f5a6b", used: 2, limit: 5 };
  const { tabId } = await openWebPage(context, worker, webUrl("onboard-2"));
  const panel = await openPanel(context, extensionId, tabId);
  const opened: string[] = [];
  await panel.exposeFunction("mydubbE2ESeen", (url: string) => opened.push(url));
  await allowConnect(panel, mydubb, extensionId);
  await panel.evaluate(() => {
    const g = globalThis as unknown as {
      mydubbE2EAuthFlow: (url: string) => Promise<string>;
      mydubbE2ESeen: (url: string) => Promise<void>;
    };
    const approve = g.mydubbE2EAuthFlow;
    g.mydubbE2EAuthFlow = async (url) => {
      await g.mydubbE2ESeen(url);
      return approve(url);
    };
  });
  await panel.getByRole("button", { name: "Try as guest" }).click();
  await expect(panel.locator("#account-status")).toHaveText("Guest session");
  expect(new URL(opened[0]!).searchParams.get("mode")).toBe("guest");
  await expect(panel.locator("#allowance")).toHaveText("Guest: 3 of 5 audio jobs left.");
  // The way to an account stays; Try as guest is not offered twice.
  await expect(panel.getByRole("region", { name: "Keep dubbing with a MyDubb account" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Try as guest" })).toBeHidden();

  await panel.getByRole("textbox", { name: "English transcript" }).fill("Hello and welcome.\nThis is the second sentence.");
  await fillTimes(panel);
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  // The guest's bearer token went with it, and nothing else identifies the guest.
  const [post] = mydubb.posts("/api/jobs");
  expect(post?.headers.authorization).toMatch(/^Bearer /);
  expect(post?.headers.cookie).toBeUndefined();
  expect(JSON.stringify(post?.body)).not.toContain("guest");
  await expect(panel.locator("#allowance")).toHaveText("Guest: 2 of 5 audio jobs left.");
  await panel.getByRole("button", { name: "Play MyDubb audio" }).click();
  await expect.poll(async () => (await playerSessions(worker))[0]?.paused).toBe(false);

  // The token stays in the extension's trusted storage only, never in the page.
  const page = context.pages().find((p) => p.url().includes("onboard-2"))!;
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toMatch(/Bearer|guest:/);
});

test("a guest with nothing left is pointed to an account; Connect replaces the guest in the panel", async ({
  context,
  worker,
  extensionId,
  mydubb,
}) => {
  mydubb.meta = META_ONBOARDING;
  mydubb.guestSession = { id: "6f1c1d6e-5a8b-4b8e-9d3a-2a1c3e4f5a6b", used: 4, limit: 5 };
  const { tabId } = await openWebPage(context, worker, webUrl("onboard-3"));
  const panel = await openPanel(context, extensionId, tabId);
  await allowConnect(panel, mydubb, extensionId);
  await panel.getByRole("button", { name: "Try as guest" }).click();
  await expect(panel.locator("#allowance")).toHaveText("Guest: 1 of 5 audio jobs left.");
  await panel.getByRole("textbox", { name: "English transcript" }).fill("Hello and welcome.\nThis is the second sentence.");
  await fillTimes(panel);
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible();
  await expect(panel.locator("#allowance")).toHaveText(
    "Guest: no audio jobs left. Create a MyDubb account to keep dubbing, or connect the account you have.",
  );
  // One more: refused by the server, never sent twice, and both ways to an account are there.
  await panel.getByRole("button", { name: GENERATE }).click();
  await expect(panel.locator("#form-error")).toHaveText("This guest session has used all 5 of its jobs.");
  expect(mydubb.posts("/api/jobs")).toHaveLength(2);
  await expect(panel.getByRole("link", { name: "Create a MyDubb account" })).toBeVisible();

  // Connect to MyDubb: the account replaces the guest, with its own Free plan numbers; the
  // guest's result goes from the panel and its token is ended (the website's guest session stays).
  const guestToken = [...mydubb.tokens.keys()][0]!;
  await panel.getByRole("button", { name: "Connect to MyDubb" }).click();
  await expect(panel.locator("#account-status")).toHaveText("Connected as Lan");
  await expect(panel.locator("#allowance")).toHaveText("Free plan: 20 of 20 Generates left today (counts start again at 00:00 UTC).");
  await expect(panel.locator("#translation")).toBeHidden();
  await expect.poll(() => mydubb.tokens.has(guestToken)).toBe(false);
  await expect.poll(async () => (await playerSessions(worker)).length).toBe(0);
  await expect(panel.locator("#onboarding")).toBeHidden();
});
