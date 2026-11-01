// Packs the production build (dist/) into a Chrome Web Store upload ZIP with manifest.json at the
// root. Run `npm run build && npm run check:dist` first; this script runs check:dist again and
// refuses anything that is not a plain production file.
//
//   node store/tools/make-zip.mjs            writes release/mydubb-extension-<version>.zip
//   node store/tools/make-zip.mjs --release  also fails while the build is not release-ready
//
// The ZIP is deterministic (sorted names, fixed timestamps), so the same dist/ gives the same file.
// It never reads or writes a private key. release/ is git-ignored.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(root, "dist");
const strict = process.argv.includes("--release");

const check = spawnSync(process.execPath, [join(root, "check-dist.mjs")], { cwd: root, stdio: "inherit" });
if (check.status !== 0) {
  console.error("check:dist failed; no ZIP written.");
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const files = walk(dist)
  .map((full) => relative(dist, full).split("\\").join("/"))
  .sort();

const forbidden = /(\.map$|\.test\.|(^|\/)dist-test|\.env|\.pem$|\.key$|\.md$|(^|\/)node_modules\/)/i;
const bad = files.filter((name) => forbidden.test(name));
if (bad.length > 0) {
  console.error(`Not a production file, refusing: ${bad.join(", ")}`);
  process.exit(1);
}
if (!files.includes("manifest.json")) {
  console.error("manifest.json is not at the root of dist/.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const notReady = [];
if (!manifest.icons || !manifest.icons["128"]) notReady.push("manifest has no 128 px icon");
if (!manifest.key) notReady.push("manifest has no release key (stable ID not set up)");
if (/prototype/i.test(`${manifest.name} ${manifest.description}`)) notReady.push('name or description still says "Prototype"');
for (const icon of Object.values(manifest.icons ?? {})) {
  if (!files.includes(icon)) notReady.push(`icon file missing: ${icon}`);
}

const DOS_DATE = (1 << 5) | 1; // 1980-01-01
const local = [];
const central = [];
let offset = 0;
for (const name of files) {
  const data = readFileSync(join(dist, name));
  const packed = deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  local.push(head, nameBuf, packed);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(packed.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);
  offset += head.length + nameBuf.length + packed.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const outDir = join(root, "release");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `mydubb-extension-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...local, ...central, end]));

console.log(`Wrote ${out}\n${files.map((f) => `  ${f}`).join("\n")}`);
if (notReady.length > 0) {
  console.log(`\nDRAFT, NOT RELEASE-READY:\n- ${notReady.join("\n- ")}`);
  if (strict) process.exit(1);
} else {
  console.log("\nRelease-ready checks passed (these cover the package only, not the dashboard steps).");
}
