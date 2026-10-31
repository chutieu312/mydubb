// Builds the unpacked extension into dist/: three IIFE bundles plus the static files.
// `node build.mjs --e2e` builds dist-test/ for the browser tests: identical, plus a hook in the
// service worker that lets a test trigger the "Send to MyDubb" handler (a native context menu
// cannot be clicked by Playwright) and a hook in the panel that stands in for Chrome's sign-in
// window. The hooks are compiled out of dist/.
//
// The MyDubb server the extension talks to is fixed at build time: MYDUBB_ORIGIN (default
// https://mydubb.com; the test build uses https://mydubb.test, which never resolves). It becomes
// the extension's only host permission. Plain http is accepted for localhost only.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const e2e = process.argv.includes("--e2e");
const outdir = join(root, e2e ? "dist-test" : "dist");
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

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: {
    background: join(root, "src/background/index.ts"),
    content: join(root, "src/content/index.ts"),
    sidepanel: join(root, "src/panel/index.ts"),
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
const manifest = JSON.parse(readFileSync(join(root, "static/manifest.json"), "utf8"));
manifest.host_permissions = [`${mydubbOrigin}/*`];
writeFileSync(join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built extension: ${outdir} (MyDubb server ${mydubbOrigin})`);
