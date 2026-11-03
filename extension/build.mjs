// Builds the unpacked extension into dist/: four IIFE bundles plus the static files.
// `node build.mjs --e2e` builds dist-test/ for the browser tests: identical, plus a hook in the
// service worker that lets a test trigger the "Send to MyDubb" handler (a native context menu
// cannot be clicked by Playwright), a hook in the panel that stands in for Chrome's sign-in
// window, an inspection message in the offscreen document (what is playing) and an open (instead
// of closed) shadow root for the floating player. The hooks are compiled out of dist/.
//
// `node build.mjs --release` builds dist-release/ for the Chrome Web Store: the same bundles, plus the
// verified release `key` from store/release-key.json. It refuses to build without that file or when
// the key does not give the Item ID written next to it (store/STABLE-ID.md), and only for an https
// origin that is not localhost. The ordinary build (no key) is what Load unpacked and the first
// draft upload use; dist/ and dist-release/ are separate folders, so building one never overwrites
// the folder Chrome has loaded.
//
// The MyDubb server the extension talks to is fixed at build time: MYDUBB_ORIGIN (default
// https://mydubb.com; the test build uses https://mydubb.test, which never resolves). It becomes
// the extension's only host permission. Plain http is accepted for localhost only.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { idFromPublicKey } from "./store/tools/key-to-id.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const e2e = process.argv.includes("--e2e");
const release = process.argv.includes("--release");
if (e2e && release) throw new Error("--e2e and --release cannot be combined");
const outdir = join(root, e2e ? "dist-test" : release ? "dist-release" : "dist");
const origin = process.env.MYDUBB_ORIGIN || (e2e ? "https://mydubb.test" : "https://mydubb.com");

function checkedOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MYDUBB_ORIGIN is not a URL: ${value}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.origin !== value || !(url.protocol === "https:" || (local && url.protocol === "http:"))) {
    throw new Error(`MYDUBB_ORIGIN must be an https origin without a path (http only for localhost): ${value}`);
  }
  return url.origin;
}
const mydubbOrigin = checkedOrigin(origin);
if (release && (!mydubbOrigin.startsWith("https://") || ["localhost", "127.0.0.1"].includes(new URL(mydubbOrigin).hostname))) {
  throw new Error(`A release build needs the production https origin, not ${mydubbOrigin}`);
}

// The verified public key and its Store Item ID, or an error saying what is still missing.
function releaseKey() {
  let file;
  try {
    file = JSON.parse(readFileSync(join(root, "store/release-key.json"), "utf8"));
  } catch {
    throw new Error("No verified release key (store/release-key.json): it needs the Store Item ID and public key of a draft upload, see store/STABLE-ID.md.");
  }
  if (typeof file?.itemId !== "string" || typeof file?.publicKey !== "string") throw new Error("store/release-key.json needs itemId and publicKey (strings).");
  const derived = idFromPublicKey(file.publicKey);
  if (derived !== file.itemId) throw new Error(`store/release-key.json: the key gives ID ${derived}, not the Item ID ${file.itemId}.`);
  return file.publicKey.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}
const key = release ? releaseKey() : null;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: {
    background: join(root, "src/background/index.ts"),
    content: join(root, "src/content/index.ts"),
    sidepanel: join(root, "src/panel/index.ts"),
    offscreen: join(root, "src/offscreen/index.ts"),
  },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome116",
  sourcemap: false,
  legalComments: "none",
  minifySyntax: true,
  define: { __MYDUBB_E2E__: String(e2e), __MYDUBB_ORIGIN__: JSON.stringify(mydubbOrigin) },
  logLevel: "warning",
});

cpSync(join(root, "static"), outdir, { recursive: true });
// The icons have one source, the reviewed PNGs of the brand folder (manifest "icons" paths).
cpSync(join(root, "store/branding/png"), join(outdir, "icons"), { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, "static/manifest.json"), "utf8"));
manifest.host_permissions = [`${mydubbOrigin}/*`];
if (key) manifest.key = key;
writeFileSync(join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built extension: ${outdir} (MyDubb server ${mydubbOrigin})`);
