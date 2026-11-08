// Where the page's user activation comes from, under Chrome's strict autoplay policy (the user's
// input on the page is needed, no exception). The page records its own activation every 250 ms in
// its title, read only at the end (Playwright reads a title, like any evaluate, with a user gesture).
// Finding: an injection by the service worker (no gesture) gives none; the lab's Scan, a real click,
// injects with that click's gesture and the page frame becomes user-activated.
import { expect, openWithLab, site, test } from "./harness";

test.use({ autoplay: "user-activation" });

test("autoplay policy: where the page's user activation comes from", async ({ context, worker, extensionId, server }) => {
  await context.addInitScript(() => {
    const t0 = performance.now();
    const marks: string[] = [];
    let last = "";
    window.setInterval(() => {
      const now = `${navigator.userActivation.hasBeenActive ? "A" : "-"}${document.documentElement.dataset.step ?? ""}`;
      if (now !== last) marks.push(`${Math.round(performance.now() - t0)}ms:${now}`);
      last = now;
      document.title = marks.join(" ");
    }, 250);
    window.addEventListener("load", () => {
      window.setTimeout(() => {
        const v = document.querySelector("video");
        v?.play().then(
          () => marks.push("page-play:ok"),
          (e: Error) => marks.push(`page-play:${e.name}`),
        );
      }, 300);
    });
  });
  const { page, lab, tabId } = await openWithLab(context, worker, extensionId, site(server.port, "/direct.html"), true);
  await lab.waitForTimeout(2000);
  // An injection from the service worker, which never has a user gesture.
  await worker.evaluate(
    (id) =>
      chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          document.documentElement.dataset.step = "[worker-injected]";
          return navigator.userActivation.hasBeenActive;
        },
      }),
    tabId,
  );
  await lab.waitForTimeout(1500);
  await worker.evaluate(
    (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => void (document.documentElement.dataset.step = "[before-scan]") }),
    tabId,
  );
  await lab.waitForTimeout(1000);
  // Then the lab's Scan, clicked for real.
  await lab.getByRole("button", { name: "Scan this tab" }).click();
  await expect(lab.locator("#decision")).not.toBeEmpty();
  await lab.waitForTimeout(1500);
  const timeline = await page.title();
  console.log("page timeline:", timeline);
  expect(timeline).toMatch(/page-play:NotAllowedError/);
  expect(timeline).toMatch(/ms:-\[worker-injected\]/);
  expect(timeline).toMatch(/ms:-\[before-scan\] \d+ms:A\[before-scan\]$/);
});
