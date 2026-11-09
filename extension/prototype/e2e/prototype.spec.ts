// Sync prototype on synthetic fixture pages (local server, see server.ts). Each test keeps the lab's
// report under test-results/prototype-reports/ as the measured evidence. Fixture evidence only: it
// says nothing about Loom or any real site.

import { audioState, decision, expect, keepReport, openWithLab, scan, scanWithoutGesture, site, syncOn, test, videoState, wait } from "./harness";

test.describe("a. direct HTML5 video", () => {
  test("found and read; Play/Pause/seek from MyDubb checked on the element", async ({ context, worker, extensionId, server }) => {
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/direct.html"));
    await scan(lab);
    await expect(decision(lab)).toHaveText("Video identified in the top frame (only-visible).");
    await expect(lab.locator("#video-state")).toContainText("0.00 / 120.00 s");
    await lab.getByRole("button", { name: "Play video" }).click();
    await expect(lab.locator("#control-results")).toContainText("play: accepted → playing");
    expect((await videoState(page)).paused).toBe(false);
    await lab.getByRole("button", { name: "Pause video" }).click();
    await expect(lab.locator("#control-results")).toContainText("pause: accepted → paused");
    const before = (await videoState(page)).t;
    await lab.getByRole("button", { name: "+5s" }).first().click();
    await expect(lab.locator("#control-results")).toContainText("seek +5s: accepted → paused");
    expect((await videoState(page)).t).toBeCloseTo(before + 5, 1);
    // Sync off: MyDubb never touched sound or speed.
    expect(await videoState(page)).toMatchObject({ muted: false, rate: 1 });
    await keepReport(lab, "a-direct-control");
  });

  test("Sync at 1.5x: play, seek both ways, pause/play on the page, rate change ends it", async ({ context, worker, extensionId, server }) => {
    test.setTimeout(90_000);
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/direct.html"));
    await scan(lab);
    await syncOn(lab, "1.5");
    expect(await videoState(page)).toMatchObject({ paused: true, muted: true, rate: 1.5 });
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    await wait(lab, 10_000);
    // MyDubb seek (+5 s of MP3 = +7.5 s of video).
    await lab.getByRole("button", { name: "+5s" }).nth(1).click();
    await wait(lab, 4000);
    await lab.getByRole("button", { name: "−5s" }).nth(1).click();
    await wait(lab, 4000);
    // The page's own seek: the audio follows.
    await page.evaluate(() => {
      const v = document.querySelector("video")!;
      v.currentTime += 6;
    });
    await wait(lab, 4000);
    // The page pauses, then plays: the audio follows both.
    await page.evaluate(() => document.querySelector("video")!.pause());
    await expect.poll(async () => (await audioState(lab)).paused).toBe(true);
    await page.evaluate(() => document.querySelector("video")!.play());
    await expect.poll(async () => (await audioState(lab)).paused).toBe(false);
    await wait(lab, 4000);
    const r = await keepReport(lab, "a-direct-sync");
    expect(r.sync.steady.samples).toBeGreaterThan(20);
    expect(r.sync.steady.maxAbs).toBeLessThan(0.3);
    for (const rec of r.sync.recoveries.filter((x: { label: string }) => ["play", "seek +5s", "seek -5s", "video:user-seek", "video:user-play"].includes(x.label))) {
      expect(rec.alignedAfterMs, rec.label).not.toBeNull();
      expect(rec.alignedAfterMs, rec.label).toBeLessThan(2000);
    }
    // A speed change while it plays steadily: Sync ends, both paused, the video keeps the new speed.
    await page.evaluate(() => (document.querySelector("video")!.playbackRate = 2));
    await expect(lab.locator("#sync-notice")).toContainText("the video speed changed");
    await expect.poll(async () => (await audioState(lab)).paused).toBe(true);
    expect(await videoState(page)).toMatchObject({ paused: true, rate: 2, muted: false });
    await keepReport(lab, "a-direct-sync-rate-change");
  });

  test("buffering: a seek past the loaded part waits for data; the audio waits and both resume aligned", async ({ context, worker, extensionId, server }) => {
    test.setTimeout(60_000);
    // ?slow=1: only the first 40 s of video are there; the rest comes 9 s after the page asked for it.
    const { lab } = await openWithLab(context, worker, extensionId, site(server.port, "/direct.html?slow=1"));
    await scan(lab);
    await syncOn(lab, "2");
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    await wait(lab, 3000);
    // The seek bar to 25 s of MP3 = 50 s of video at 2x, past the loaded 40 s.
    await lab.locator("#a-seek").evaluate((el: HTMLInputElement) => {
      el.value = "25";
      el.dispatchEvent(new Event("change"));
    });
    await expect(lab.locator("#sync-status")).toContainText("ON · Buffering");
    const during = await audioState(lab);
    expect(during.paused).toBe(true);
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing", { timeout: 15_000 });
    await wait(lab, 3000);
    const r = await keepReport(lab, "a-direct-buffering");
    // The seek: the video waits for data (seconds), the audio is held meanwhile ("mixed": not both
    // playing); when the data comes, both play again, aligned within the threshold.
    const seek = r.sync.recoveries.find((x: { label: string }) => x.label === "seek bar");
    expect(seek).toMatchObject({ alignedAfterMs: null, endState: "mixed" });
    const resumed = r.sync.recoveries.find((x: { label: string }) => x.label === "video:buffering-end");
    expect(resumed.alignedAfterMs).toBeLessThan(1000);
    expect(resumed.endState).toBe("both-playing");
    const at = (label: string) => Number(r.sync.operations.find((o: { label: string }) => o.label === label).t);
    expect(at("video:buffering-end") - at("seek bar")).toBeGreaterThan(2);
    expect(r.sync.steady.maxAbs).toBeLessThan(0.3);
  });
});

test.describe("b. several videos and changing players", () => {
  test("a preview beside the main video: not compatible until the user plays one; then content switches end the binding", async ({ context, worker, extensionId, server }) => {
    test.setTimeout(60_000);
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/multi/1"));
    await scan(lab);
    await expect(decision(lab)).toContainText("Not compatible yet: 2 videos and none of them is identified as the main one");
    await expect(lab.locator("#video-state")).toContainText("not bound");
    // The user starts the main video once (here from the page), then scans again.
    await page.evaluate(async () => {
      const v = document.getElementById("main") as HTMLVideoElement;
      await v.play();
      v.pause();
    });
    await scan(lab);
    await expect(decision(lab)).toHaveText("Video identified in the top frame (user-played).");
    await syncOn(lab, "1");
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    // Only the query changes: kept.
    await page.evaluate(() => (window as unknown as { fixture: { query(): void } }).fixture.query());
    await expect(lab.locator("#log")).toContainText("url query changed, binding kept");
    await wait(lab, 1500);
    expect((await audioState(lab)).paused).toBe(false);
    // Content switch (new path, new element): the binding ends, the audio stops.
    await page.evaluate(() => (window as unknown as { fixture: { next(): void } }).fixture.next());
    await expect(decision(lab)).toContainText("The bound video is gone (navigated)");
    expect((await audioState(lab)).paused).toBe(true);
    await keepReport(lab, "b-multi-next");

    // The new main video, played once, then its element gets another source.
    await page.evaluate(async () => {
      const v = document.getElementById("main") as HTMLVideoElement;
      await new Promise((r) => (v.readyState > 0 ? r(null) : v.addEventListener("loadedmetadata", r, { once: true })));
      await v.play();
      v.pause();
    });
    await scan(lab);
    await expect(decision(lab)).toHaveText("Video identified in the top frame (user-played).");
    await syncOn(lab, "1");
    await page.evaluate(() => (window as unknown as { fixture: { swapSource(): void } }).fixture.swapSource());
    await expect(decision(lab)).toContainText("The bound video is gone");
    const r = await keepReport(lab, "b-multi-swap");
    // What the element is left with after the new source (the ownership contract gives back only on the same media).
    const after = await videoState(page);
    r.afterSwap = after;
    expect(after.paused).toBe(true);
  });

  test("a muted looping preview beside the main video is not a candidate and is left alone", async ({ context, worker, extensionId, server }) => {
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/main-and-preview.html"));
    await scan(lab);
    await expect(decision(lab)).toHaveText("Video identified in the top frame (only-visible).");
    await syncOn(lab, "1");
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    // The main video is the synced one; the preview keeps playing as the page made it.
    expect(await videoState(page, 0)).toMatchObject({ paused: false, muted: true });
    expect(await videoState(page, 1)).toMatchObject({ paused: false, muted: true, rate: 1 });
    await keepReport(lab, "b-main-and-preview");
  });

  test("only a background video: nothing to sync", async ({ context, worker, extensionId, server }) => {
    const { lab } = await openWithLab(context, worker, extensionId, site(server.port, "/background.html"));
    await scan(lab);
    await expect(decision(lab)).toHaveText("Not compatible: no video found. 1 muted looping video(s) are taken as a preview or background.");
    await keepReport(lab, "b-background");
  });

  test("navigation or reload of the tab ends the binding", async ({ context, worker, extensionId, server }) => {
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/direct.html"));
    await scan(lab);
    await syncOn(lab, "1");
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    await page.goto(site(server.port, "/other.html"));
    await expect(lab.locator("#log")).toContainText("binding ended: the page went away");
    expect((await audioState(lab)).paused).toBe(true);
    await scan(lab);
    await expect(decision(lab)).toHaveText("Not compatible: no video found.");
    await page.goto(site(server.port, "/direct.html"));
    await scan(lab);
    await expect(decision(lab)).toHaveText("Video identified in the top frame (only-visible).");
    await page.reload();
    await expect(lab.locator("#log")).toContainText("binding ended: the page went away");
    await keepReport(lab, "b-navigation");
  });
});

test.describe("c. player in a cross-origin iframe", () => {
  test("found in the frame; Play/Pause and Sync work through it", async ({ context, worker, extensionId, server }) => {
    test.setTimeout(60_000);
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/embed.html"));
    await scan(lab);
    await expect(decision(lab)).toHaveText(`Video identified in the frame of http://player.test:${server.port} (only-visible).`);
    await lab.getByRole("button", { name: "Play video" }).click();
    await expect(lab.locator("#control-results")).toContainText("play: accepted → playing");
    await lab.getByRole("button", { name: "Pause video" }).click();
    await expect(lab.locator("#control-results")).toContainText("pause: accepted → paused");
    await syncOn(lab, "1.25");
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    await wait(lab, 8000);
    const frame = page.frame({ url: /player\.test/ })!;
    await frame.evaluate(() => {
      const v = document.querySelector("video")!;
      v.currentTime += 5;
    });
    await wait(lab, 4000);
    const r = await keepReport(lab, "c-iframe-sync");
    expect(r.sync.steady.maxAbs).toBeLessThan(0.3);
    const seek = r.sync.recoveries.find((x: { label: string }) => x.label === "video:user-seek");
    expect(seek?.alignedAfterMs).not.toBeNull();
  });

  test("a player that puts its speed back to 1x on play: Sync sets R again and keeps playing", async ({ context, worker, extensionId, server }) => {
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/embed.html?resetRateOnPlay=1"));
    await scan(lab);
    await syncOn(lab, "1.5");
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    await wait(lab, 4000);
    const frame = page.frame({ url: /player\.test/ })!;
    expect(await frame.evaluate(() => document.querySelector("video")!.playbackRate)).toBe(1.5);
    const r = await keepReport(lab, "c-iframe-rate-reset");
    expect(r.trace.map((e: { step: string }) => e.step)).toContain("event:rate-restored");
  });

  test("a muted preview in the page and the player in a frame: the frame's player is taken", async ({ context, worker, extensionId, server }) => {
    const { lab } = await openWithLab(context, worker, extensionId, site(server.port, "/embed-preview.html"));
    await scan(lab);
    await expect(decision(lab)).toHaveText(`Video identified in the frame of http://player.test:${server.port} (only-visible).`);
    await keepReport(lab, "c-preview-and-frame");
  });

  test("a video with sound in the page and another in a frame: not compatible until the user plays one", async ({ context, worker, extensionId, server }) => {
    const { page, lab } = await openWithLab(context, worker, extensionId, site(server.port, "/embed-preview.html"));
    // The page's preview gets its sound on: now it is an ordinary video too.
    await page.evaluate(() => {
      const v = document.getElementById("preview") as HTMLVideoElement;
      v.loop = false;
      v.autoplay = false;
      v.muted = false;
      v.pause();
    });
    await scan(lab);
    await expect(decision(lab)).toHaveText("Not compatible yet: 2 frames each have a video. Play the main video once, then Scan again.");
    const frame = page.frame({ url: /player\.test/ })!;
    await frame.evaluate(async () => {
      const v = document.querySelector("video")!;
      await v.play();
      v.pause();
    });
    await scan(lab);
    await expect(decision(lab)).toHaveText(`Video identified in the frame of http://player.test:${server.port} (user-played).`);
    await keepReport(lab, "c-two-frames");
  });

  test("a large frame without access beside a preview: the preview is not taken", async ({ context, worker, extensionId, server }) => {
    const { lab } = await openWithLab(context, worker, extensionId, site(server.port, "/embed-blocked.html"));
    await scan(lab);
    await expect(decision(lab)).toHaveText(
      "Not compatible: no video found. 1 muted looping video(s) are taken as a preview or background." +
        ` Frames from http://blocked.test:${server.port} are not accessible and may hold a player.`,
    );
    await expect(lab.getByRole("button", { name: `Allow access to http://blocked.test:${server.port}` })).toBeVisible();
    await expect(lab.locator("#video-state")).toContainText("not bound");
    await keepReport(lab, "c-blocked-frame");
  });
});

test.describe("Play refused by Chrome (policy: the user's input on the page is needed)", () => {
  test.use({ autoplay: "user-activation" });

  // The page is never evaluated before the end (see openWithLab): the video state is the lab's.
  test("Play from MyDubb on a video with sound is refused and the video stays paused; Sync (muted) still plays", async ({ context, worker, extensionId, server }) => {
    const { page, lab, tabId } = await openWithLab(context, worker, extensionId, site(server.port, "/direct.html"), true);
    // Injected without a gesture (a click in the lab would give the page user activation).
    await scanWithoutGesture(lab, worker, tabId);
    await expect(decision(lab)).toHaveText("Video identified in the top frame (only-visible).");
    await expect(lab.locator("#video-state")).toContainText("paused");
    // Play video without a gesture too (a click in the lab: see the next test).
    await lab.waitForTimeout(6000);
    await worker.evaluate((id) => chrome.runtime.sendMessage({ type: "proto:play-video", tabId: id }), tabId);
    await expect(lab.locator("#control-results")).toContainText("play: play-blocked → still-paused");
    await expect(lab.locator("#video-state")).toContainText("paused");
    await keepReport(lab, "refused-play");
    // Sync mutes the video before it plays it; a muted video may play without the user's input.
    // Sync on and Play without a gesture as well (as from the offscreen coordinator in MyDubb).
    await worker.evaluate((id) => chrome.runtime.sendMessage({ type: "proto:sync-on", tabId: id }), tabId);
    await expect(lab.locator("#sync-status")).toContainText("ON · Paused");
    await worker.evaluate((id) => chrome.runtime.sendMessage({ type: "proto:play", tabId: id }), tabId);
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    await wait(lab, 3000);
    const r = await keepReport(lab, "refused-play-then-sync");
    expect(r.frames[0].userActivation).toEqual({ hasBeenActive: false, isActive: false });
    expect(r.controlResults[0].activation).toEqual({ hasBeenActive: false, isActive: false });
    expect(r.sync.steady.samples).toBeGreaterThan(3);
    expect(await videoState(page)).toMatchObject({ paused: false, muted: true });
  });

  test("a click on Play video in MyDubb's own page carries user activation to the page frame: not refused", async ({ context, worker, extensionId, server }) => {
    const { lab, tabId } = await openWithLab(context, worker, extensionId, site(server.port, "/direct.html"), true);
    await scanWithoutGesture(lab, worker, tabId);
    await expect(decision(lab)).toHaveText("Video identified in the top frame (only-visible).");
    await lab.waitForTimeout(6000);
    await lab.getByRole("button", { name: "Play video" }).click();
    await expect(lab.locator("#control-results li")).toHaveCount(1);
    const r = await keepReport(lab, "refused-play-lab-click");
    expect(r.frames[0].userActivation.hasBeenActive).toBe(false);
    expect(r.controlResults[0]).toMatchObject({ error: null, outcome: "playing", activation: { hasBeenActive: true, isActive: true } });
  });

  test("Sync in a cross-origin frame under the same policy: the muted play is allowed too", async ({ context, worker, extensionId, server }) => {
    const { page, lab, tabId } = await openWithLab(context, worker, extensionId, site(server.port, "/embed.html"), true);
    await scanWithoutGesture(lab, worker, tabId);
    await expect(lab.locator("#video-state")).toContainText("120.00 s");
    await syncOn(lab, "1.5");
    await lab.getByRole("button", { name: "Play", exact: true }).click();
    await expect(lab.locator("#sync-status")).toContainText("ON · Playing");
    await wait(lab, 3000);
    const r = await keepReport(lab, "refused-play-iframe-sync");
    expect(r.frames.every((f: { userActivation: { hasBeenActive: boolean } }) => !f.userActivation.hasBeenActive)).toBe(true);
    const frame = page.frame({ url: /player\.test/ })!;
    expect(await frame.evaluate(() => document.querySelector("video")!.muted)).toBe(true);
  });
});
