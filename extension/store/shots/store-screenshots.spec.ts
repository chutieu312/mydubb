// Makes the Chrome Web Store screenshots (1280x800 PNG) in store/screenshots/.
//
// The panel is the real side panel of the test build, driven against the fake MyDubb server with
// a synthetic lecture page and invented sample text; the image puts its rendering beside a short
// caption. Chrome's own browser frame (where the side panel docks) is not part of it, because
// Playwright cannot capture browser UI. See store/RELEASE-PACKAGE.md.
import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectAccount, expect, openLecture, openPanel, sendTranscriptSelection, test } from "../../e2e/harness";

const out = join(dirname(fileURLToPath(import.meta.url)), "../screenshots");
const READY = "Ready. Press play when you want to listen.";
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 724;

const EN = [
  "What does ACID compliance mean?",
  "The A stands for Atomicity.",
  "The entire transaction succeeds, or the entire thing fails.",
];
const VI = "ACID compliance nghĩa là gì?\nChữ A là viết tắt của Atomicity.\nToàn bộ giao dịch thành công hoặc toàn bộ giao dịch thất bại.";

interface Shot {
  file: string;
  title: string;
  text: string;
  /** Top of the panel window, in panel pixels. */
  from: number;
}

/** The whole panel as one tall image (device scale 2), and where its blocks are. */
async function snapshot(panel: Page) {
  const cdp = await panel.context().newCDPSession(panel);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: PANEL_WIDTH, height: 2600, deviceScaleFactor: 2, mobile: false });
  await panel.emulateMedia({ colorScheme: "dark" });
  await panel.evaluate(() => window.scrollTo(0, 0));
  const top = async (selector: string) => (await panel.locator(selector).first().boundingBox())!.y;
  // The player block does not exist before a result is loaded.
  const bottom = async (selector: string) => {
    const box = await panel.locator(selector).first().boundingBox({ timeout: 500 }).catch(() => null);
    return box ? box.y + box.height : 0;
  };
  const image = await panel.screenshot({ type: "png", fullPage: true });
  const places = {
    translate: await top("section[aria-labelledby=dub-heading]"),
    audio: await top("section.audio-card"),
    floatingEnd: await bottom("#player-floating"),
    height: await panel.evaluate(() => document.documentElement.scrollHeight),
  };
  await cdp.detach();
  return { uri: `data:image/png;base64,${image.toString("base64")}`, places };
}

async function compose(shots: { shot: Shot; uri: string; lectureUri?: string }[]) {
  const browser = await chromium.launch();
  try {
    for (const { shot, uri, lectureUri } of shots) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>
        *{box-sizing:border-box}
        body{margin:0;width:1280px;height:800px;overflow:hidden;font:16px/1.5 system-ui,"Segoe UI",sans-serif;color:#edf9f5;
          background:linear-gradient(135deg,#101e27 0%,#1a2e38 100%);position:relative}
        .copy{position:absolute;left:72px;top:96px;width:640px}
        .chip{display:inline-block;font:600 14px system-ui;letter-spacing:.04em;color:#102d28;background:#7be0c5;border-radius:999px;padding:4px 14px}
        h1{font:700 44px/1.15 system-ui,"Segoe UI",sans-serif;margin:20px 0 14px;text-wrap:balance}
        p{font-size:21px;line-height:1.5;color:#b0c8c8;margin:0;text-wrap:pretty}
        .floating{position:absolute;left:72px;top:440px}
        .floating img{width:340px;display:block;border-radius:14px;box-shadow:0 12px 36px #00000066}
        .floating span{display:block;margin-top:12px;font-size:15px;color:#7f9ea3}
        .panel{position:absolute;right:72px;top:38px;width:${PANEL_WIDTH}px;height:${PANEL_HEIGHT}px;border-radius:18px;overflow:hidden;
          border:1px solid #38515c;box-shadow:0 18px 50px #00000066;background:#101e27}
        .panel img{width:${PANEL_WIDTH}px;display:block;margin-top:-${shot.from}px}
        .note{position:absolute;left:72px;bottom:30px;font-size:14px;color:#7f9ea3}
      </style>
      <div class="copy"><span class="chip">${shot.file.slice(0, 2)}</span><h1>${shot.title}</h1><p>${shot.text}</p></div>
      ${lectureUri ? `<div class="floating"><img src="${lectureUri}"><span>The floating player on the lecture page</span></div>` : ""}
      <div class="panel"><img src="${uri}"></div>
      <div class="note">Sample text. MyDubb is an independent service, not affiliated with Udemy, Microsoft or Google.</div>`);
      await page.screenshot({ path: join(out, shot.file), type: "png", clip: { x: 0, y: 0, width: 1280, height: 800 } });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

test("Store screenshots from the real one-page panel", async ({ context, worker, extensionId, mydubb }) => {
  mkdirSync(out, { recursive: true });
  const { page, tabId } = await openLecture(context, worker, 901, "?seconds=120");
  // Invented sample passage in the fixture's transcript element (no real course content).
  await page.evaluate((lines) => {
    const box = document.getElementById("transcript")!;
    const paragraph = document.createElement("p");
    lines.forEach((line, i) => {
      if (i > 0) paragraph.append(document.createElement("br"));
      paragraph.append(line);
    });
    box.replaceChildren(paragraph);
  }, EN);
  const panel = await openPanel(context, extensionId, tabId);
  await panel.setViewportSize({ width: PANEL_WIDTH, height: 900 });
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await panel.getByLabel("First sentence starts").fill("000010");
  await panel.getByLabel("Last sentence starts").fill("000056");
  await panel.getByRole("radio", { name: "1.5x", exact: true }).check();
  await expect(panel.locator("#transcript")).toHaveValue(EN.join("\n"));

  const before = await snapshot(panel);

  mydubb.translations["job-1"] = VI;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(panel.getByText(READY)).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator("#translation")).toHaveText(VI);
  const loaded = await snapshot(panel);

  await panel.getByRole("button", { name: "Sync with video" }).click();
  await panel.getByRole("button", { name: "Turn on sync" }).click();
  await expect(panel.locator("#sync-status")).toHaveText("ON · Paused");
  await panel.getByRole("button", { name: "Show floating player" }).click();
  await expect(page.getByRole("region", { name: "MyDubb audio player" })).toBeVisible();
  const synced = await snapshot(panel);

  // Only the floating player itself (the synthetic lecture page around it is not shown).
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  const lectureCdp = await context.newCDPSession(page);
  await lectureCdp.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 600, deviceScaleFactor: 3, mobile: false });
  const lecture = (await page.getByRole("region", { name: "MyDubb audio player" }).screenshot({ type: "png" })).toString("base64");
  await lectureCdp.detach();

  const keep = (n: number) => Math.max(0, n - 10);
  await compose([
    {
      shot: {
        file: "01-send-the-transcript.png",
        title: "Send the transcript to MyDubb",
        text: "Right-click a passage on the lecture page. Check the text and the start times in the panel.",
        from: 0,
      },
      uri: before.uri,
    },
    {
      shot: {
        file: "02-choose-language-voice-speed.png",
        title: "Choose language, voice and speed",
        text: "Then press Generate audio. Your text is processed by Microsoft Azure.",
        from: keep(before.places.translate),
      },
      uri: before.uri,
    },
    {
      shot: {
        file: "03-read-and-listen.png",
        title: "Read the translation, then listen",
        text: "The translation is shown with the audio, before you press Play. Nothing plays by itself.",
        from: keep(loaded.places.audio),
      },
      uri: loaded.uri,
    },
    {
      shot: {
        file: "04-sync-with-video.png",
        title: "Optional: sync with the video",
        text: "Sync lines the audio up with the lecture video over the passage you sent: an estimate, not word by word. The floating player stays on the lecture page.",
        from: Math.max(keep(synced.places.audio), Math.min(synced.places.floatingEnd + 24 - PANEL_HEIGHT, synced.places.height - PANEL_HEIGHT)),
      },
      uri: synced.uri,
      lectureUri: `data:image/png;base64,${lecture}`,
    },
  ]);
});
