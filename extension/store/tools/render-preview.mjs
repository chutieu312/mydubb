// Draws store/branding/preview.png for Product Owner review: the PNG icons at their real size
// and enlarged, on light and dark backgrounds (toolbar, extensions page, Store icon).
// Run render-icons.mjs first. Usage: node store/tools/render-preview.mjs  (from extension/)
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "../branding");
const uri = (n) => `data:image/png;base64,${readFileSync(join(here, "png", `icon-${n}.png`)).toString("base64")}`;
const icons = Object.fromEntries([16, 32, 48, 128].map((n) => [n, uri(n)]));

const row = (bg, fg, label) => `
  <section style="background:${bg};color:${fg}">
    <h2>${label}</h2>
    <div class="r">
      <figure><img src="${icons[16]}" width="16" height="16"><figcaption>16 (toolbar / favicon)</figcaption></figure>
      <figure><img src="${icons[32]}" width="32" height="32"><figcaption>32 (toolbar @2x)</figcaption></figure>
      <figure><img src="${icons[48]}" width="48" height="48"><figcaption>48 (extensions page)</figcaption></figure>
      <figure><img src="${icons[128]}" width="128" height="128"><figcaption>128 (Store icon, art 96 + 16 padding)</figcaption></figure>
      <figure><img src="${icons[16]}" width="64" height="64" style="image-rendering:pixelated"><figcaption>16 enlarged 4x</figcaption></figure>
      <figure><img src="${icons[32]}" width="96" height="96" style="image-rendering:pixelated"><figcaption>32 enlarged 3x</figcaption></figure>
    </div>
  </section>`;

const html = `<style>
 body{margin:0;font:13px system-ui,sans-serif;width:1000px}
 section{padding:14px 20px} h2{font:600 14px system-ui;margin:0 0 10px}
 .r{display:flex;gap:28px;align-items:flex-end} figure{margin:0;text-align:center} figcaption{margin-top:6px;font-size:11px;max-width:130px}
</style>
${row("#ffffff", "#202124", "Light toolbar / page (#ffffff)")}
${row("#dee1e6", "#202124", "Chrome light frame (#dee1e6)")}
${row("#202124", "#e8eaed", "Chrome dark toolbar (#202124)")}
${row("#101e27", "#edf9f5", "MyDubb dark panel (#101e27)")}
${row("#fff9ee", "#193e49", "MyDubb light panel (#fff9ee)")}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 400 } });
  await page.setContent(html);
  await page.screenshot({ path: join(here, "preview.png"), fullPage: true });
} finally {
  await browser.close();
}
console.log("Wrote store/branding/preview.png");
