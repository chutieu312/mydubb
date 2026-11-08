// Opt-in probe of real public pages (never in the default run): PROTO_LIVE_URLS="https://a,https://b"
// npx playwright test -c prototype/playwright.config.ts live. It only views the pages (no sign-in,
// nothing typed, nothing sent): scan, then if one video is identified, Play/Pause from MyDubb and a
// short Sync run. Playwright's Chromium has no proprietary codecs (H.264/AAC): a page whose video
// needs them can be found and read here but may not play; the PO's Chrome is the real check.
import { decision, expect, keepReport, openWithLab, scan, site, syncOn, test, wait } from "./harness";

// "local:/embed-loom.html?id=..." is a page of the local fixture server (a real player in a frame).
const urls = (process.env.PROTO_LIVE_URLS ?? "").split(",").filter(Boolean);

for (const entry of urls) {
  test(`live: ${entry.slice(0, 80)}`, async ({ context, worker, extensionId, server }) => {
    test.setTimeout(120_000);
    const url = entry.startsWith("local:") ? site(server.port, entry.slice("local:".length)) : entry;
    const name = `live-${new URL(url).host.replace(/[^a-z0-9.]/gi, "_")}${new URL(url).pathname.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}`;
    const { page, lab } = await openWithLab(context, worker, extensionId, url, true);
    await page.waitForLoadState("load").catch(() => undefined);
    await wait(lab, 6000);
    await scan(lab);
    await expect(decision(lab)).not.toBeEmpty();
    let r = await keepReport(lab, name);
    console.log(`${url}\n  decision: ${r.decision?.text}\n  frames: ${JSON.stringify(r.frames.map((f: { origin: string; videos: unknown[]; iframes: unknown[]; shadowVideos: number; pick: unknown }) => ({ origin: f.origin, videos: f.videos, iframes: f.iframes.length, shadow: f.shadowVideos, pick: f.pick })))}`);
    if (!r.decision?.ok && process.env.PROTO_LIVE_CLICK) {
      // What the lab asks the user to do: start the main video once on the page. A real click in
      // the middle of the largest frame or video (no site-specific selector), then Scan again.
      const target = page.locator("iframe, video").first();
      await target.click({ timeout: 5000 }).catch(() => undefined);
      await wait(lab, 4000);
      await scan(lab);
      await wait(lab, 1000);
      r = await keepReport(lab, name);
      console.log(`  after the user's click: ${r.decision?.text}`);
    }
    if (!r.decision?.ok) return;
    await wait(lab, 1500);
    await lab.getByRole("button", { name: "Play video" }).click();
    await expect(lab.locator("#control-results li")).toHaveCount(1, { timeout: 15_000 });
    await wait(lab, 2000);
    await lab.getByRole("button", { name: "Pause video" }).click();
    await expect(lab.locator("#control-results li")).toHaveCount(2, { timeout: 15_000 });
    r = await keepReport(lab, name);
    console.log(`  control: ${JSON.stringify(r.controlResults)}`);
    if (r.controlResults[0]?.outcome !== "playing") return;
    // R = 1.25: a 38 s span for the 30.5 s test MP3; every step below stays inside it.
    await syncOn(lab, "1.25").catch(() => undefined);
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await wait(lab, 6000);
    await lab.getByRole("button", { name: "+5s" }).nth(1).click();
    await wait(lab, 3000);
    // The page's side, without a site adapter: a seek on the element (as the site's own bar does),
    // then the player's own keyboard shortcut (Space) to pause and play.
    for (const frame of page.frames()) {
      await frame
        .evaluate(() => {
          const v = [...document.querySelectorAll("video")].find((x) => !x.paused);
          if (v) v.currentTime += 4;
        })
        .catch(() => undefined);
    }
    await wait(lab, 3000);
    await page.locator("video").first().click({ trial: true, timeout: 2000 }).catch(() => undefined);
    await page.keyboard.press("Space");
    await wait(lab, 3000);
    const audioAfterPagePause = await lab.evaluate(() => (document.getElementById("audio") as HTMLAudioElement).paused);
    await page.keyboard.press("Space");
    await wait(lab, 3000);
    await lab.getByRole("button", { name: "Pause", exact: true }).click();
    await wait(lab, 1000);
    const state = async () =>
      (
        await Promise.all(
          page.frames().map((f) => f.evaluate(() => [...document.querySelectorAll("video")].map((v) => ({ rate: v.playbackRate, muted: v.muted, paused: v.paused }))).catch(() => [])),
        )
      ).flat();
    const synced = await state();
    await lab.getByRole("button", { name: "Turn Sync off" }).click({ timeout: 2000 }).catch(() => undefined);
    await wait(lab, 1000);
    const released = await state();
    r = await keepReport(lab, name);
    console.log(`  sync: steady ${JSON.stringify(r.sync.steady)} notices ${JSON.stringify(r.sync.notices)}\n  recoveries ${JSON.stringify(r.sync.recoveries)}`);
    console.log(`  audio paused after the page's Space: ${audioAfterPagePause}; video while synced ${JSON.stringify(synced)}, after Sync off ${JSON.stringify(released)}`);
    console.log(`  events: ${r.log.filter((l: string) => l.includes("video event") || l.includes("url") || l.includes("correction")).join(" | ")}`);
    await page.reload();
    await wait(lab, 2000);
    r = await keepReport(lab, name);
    console.log(`  after reload: ${r.log.filter((l: string) => l.includes("binding ended")).join(" | ")}`);
  });
}
