// Renders the master SVGs to PNG with the Chromium that Playwright already installs for the
// extension's browser tests. Usage: node store/tools/render-icons.mjs  (from extension/)
// Output: store/branding/png/icon-{16,32,48,128}.png (128 = 96 px artwork + 16 px transparent
// padding per side, as the Chrome Web Store asks) and store/branding/preview.html's inputs.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "../branding");
const master = readFileSync(join(here, "mydubb-icon.svg"), "utf8");
const small = readFileSync(join(here, "mydubb-icon-small.svg"), "utf8");
const out = join(here, "png");
mkdirSync(out, { recursive: true });

// size: output edge in px; art: artwork edge inside it; svg: which master to use.
const targets = [
  { size: 16, art: 16, svg: small },
  { size: 32, art: 32, svg: small },
  { size: 48, art: 48, svg: master },
  { size: 128, art: 96, svg: master },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { size, art, svg } of targets) {
    const pad = (size - art) / 2;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{position:absolute;left:${pad}px;top:${pad}px;width:${art}px;height:${art}px}</style>${svg}`,
    );
    await page.screenshot({ path: join(out, `icon-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${targets.length} PNGs to ${out}`);
