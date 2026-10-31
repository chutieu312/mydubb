// Builds the unpacked extension into dist/: three IIFE bundles plus the static files.
// `node build.mjs --e2e` builds dist-test/ for the browser tests: identical, plus a hook in the
// service worker that lets a test trigger the "Send to MyDubb" handler (a native context menu
// cannot be clicked by Playwright). The hook is compiled out of dist/.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const e2e = process.argv.includes("--e2e");
const outdir = join(root, e2e ? "dist-test" : "dist");

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
  define: { __MYDUBB_E2E__: String(e2e) },
  logLevel: "warning",
});

cpSync(join(root, "static"), outdir, { recursive: true });
console.log(`Built extension: ${outdir}`);
