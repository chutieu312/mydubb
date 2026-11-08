// Builds the Sync prototype (development only, Story 2 prototype phase) into dist-prototype/: a
// separate unpacked extension, never part of dist/ or the Chrome Web Store package. It reuses the
// MyDubb Sync modules from ../src unchanged.
//
//   node prototype/build.mjs          dist-prototype/       for Load unpacked (activeTab, scripting, sidePanel; per-site access on request)
//   node prototype/build.mjs --e2e    dist-prototype-test/  for the prototype's browser tests: the same, plus
//                                     host access to the fixture origins site.test and player.test (not
//                                     blocked.test, which stays inaccessible) and to https pages (the opt-in
//                                     live probes), because Playwright can neither click the toolbar button
//                                     (activeTab) nor answer Chrome's permission prompt.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const e2e = process.argv.includes("--e2e");
const outdir = join(here, "..", e2e ? "dist-prototype-test" : "dist-prototype");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: {
    background: join(here, "src/background.ts"),
    probe: join(here, "src/probe.ts"),
    lab: join(here, "src/lab.ts"),
  },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome116",
  legalComments: "none",
  // The shared modules read these; the prototype has no MyDubb server and no test hooks.
  define: { __MYDUBB_E2E__: "false", __MYDUBB_ORIGIN__: JSON.stringify("https://mydubb.invalid") },
  logLevel: "warning",
});

cpSync(join(here, "static"), outdir, { recursive: true });
// The local test audio: the backend's 3 s mock-provider MP3 (CBR, no header frame) ten times over, as
// in the extension's browser tests: a real 30 s MP3 that decodes and seeks.
const mp3 = readFileSync(join(here, "..", "..", "backend", "app", "audio", "fixtures", "mock_audio.mp3"));
writeFileSync(join(outdir, "test-audio.mp3"), Buffer.concat(Array.from({ length: 10 }, () => mp3)));

const manifest = JSON.parse(readFileSync(join(here, "static/manifest.json"), "utf8"));
if (e2e) manifest.host_permissions = ["http://site.test/*", "http://player.test/*", "https://*/*"];
const permissions = [...manifest.permissions].sort().join(",");
if (permissions !== "activeTab,scripting,sidePanel" || "content_scripts" in manifest || (!e2e && "host_permissions" in manifest)) {
  throw new Error(`prototype manifest changed: ${permissions}`);
}
writeFileSync(join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built Sync prototype: ${outdir}`);
