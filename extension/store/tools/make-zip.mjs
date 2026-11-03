// Packs a build into a Chrome Web Store upload ZIP with manifest.json at the root.
//
//   node store/tools/make-zip.mjs            packs dist/ (the ordinary build, no key) as
//                                            release/mydubb-extension-<version>-draft.zip: what the first DRAFT
//                                            upload needs to get the Item ID and public key. NOT release-ready.
//   node store/tools/make-zip.mjs --release  packs dist-release/ (`node build.mjs --release`) as
//                                            release/mydubb-extension-<version>.zip, only when
//                                            `check-dist --release` passes (the verified key is in it)
//
// Both run check-dist first, refuse anything that is not a plain production file, and read the ZIP
// back to compare every entry with the build. The ZIP is deterministic (sorted names, fixed
// timestamps). Nothing here reads or writes a private key. release/ is git-ignored.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { checkDist } from "../../check-dist.mjs";
import { readZip, writeZip } from "./zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const release = process.argv.includes("--release");
const dist = join(root, release ? "dist-release" : "dist");

const check = spawnSync(process.execPath, [join(root, "check-dist.mjs"), ...(release ? ["--release"] : [])], { cwd: root, stdio: "inherit" });
if (check.status !== 0) {
  console.error(`check-dist${release ? " --release" : ""} failed; no ZIP written.`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const names = walk(dist).map((full) => relative(dist, full).split("\\").join("/"));
const forbidden = /(\.map$|\.test\.|dist-test|\.env|\.pem$|\.key$|\.md$|node_modules)/i;
const bad = names.filter((name) => forbidden.test(name));
if (bad.length > 0) {
  console.error(`Not a production file, refusing: ${bad.join(", ")}`);
  process.exit(1);
}
if (!names.includes("manifest.json")) {
  console.error("manifest.json is not at the root of the build.");
  process.exit(1);
}

const entries = names.map((name) => ({ name, data: readFileSync(join(dist, name)) }));
const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
const zip = writeZip(entries);

// Read it back: same names, same bytes, manifest at the root, and the same checks on the extracted files.
const back = readZip(zip);
if (back.length !== entries.length || back.some((e) => !entries.find((o) => o.name === e.name && o.data.equals(e.data)))) {
  console.error("The ZIP does not match the build it was made from.");
  process.exit(1);
}

const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `mydubb-extension-${manifest.version}${release ? "" : "-draft"}.zip`);
writeFileSync(out, zip);
console.log(`Wrote ${out} (${zip.length} bytes)\n${[...names].sort().map((f) => `  ${f}`).join("\n")}`);

// Is this package release-ready? Same conditions as check-dist --release, on the packed build.
const { problems, missing } = checkDist({ dir: dist, origin: process.env.MYDUBB_ORIGIN || "https://mydubb.com", release: true });
if (problems.length + missing.length > 0) {
  console.log(`\nDRAFT, NOT RELEASE-READY:\n- ${[...problems, ...missing].join("\n- ")}`);
} else {
  console.log("\nRelease conditions of check-dist --release are met. The dashboard steps (listing, privacy, review) are separate.");
}
