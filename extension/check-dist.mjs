// Checks the unpacked production build before it can be loaded, shared or packed: no test hook, no
// test server, exactly the permissions the README documents, only known file types, and the icons
// the manifest names. Run after `npm run build`.
//
//   node check-dist.mjs             checks dist/ (the ordinary build: it must NOT carry a `key`)
//   node check-dist.mjs --release [--dir dist]   checks dist-release/ (or --dir: shows what the draft build still lacks)
//                                   Release mode checks dist-release/ (built by `node build.mjs --release`): every check
//                                   above, plus the Chrome Web Store conditions. The only `key` it accepts
//                                   is the one in store/release-key.json whose derived ID equals the Store
//                                   Item ID written there; without that file it fails and says what is missing.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { idFromPublicKey } from "./store/tools/key-to-id.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const ICON_SIZES = ["16", "32", "48", "128"];
const ALLOWED_FILES = new Set([
  "manifest.json",
  "background.js",
  "content.js",
  "offscreen.js",
  "sidepanel.js",
  "offscreen.html",
  "sidepanel.html",
  "sidepanel.css",
  ...ICON_SIZES.map((size) => `icons/icon-${size}.png`),
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Width and height from a PNG's IHDR, or null when the file is not a PNG. */
function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const oneLine = (pem) => pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");

/**
 * @param {{ dir: string, origin?: string, release?: boolean, keyFile?: string }} options
 * @returns {{ problems: string[], missing: string[] }} problems: the build is wrong; missing:
 *   a release condition that is not met yet (only in release mode).
 */
export function checkDist({ dir, origin = "https://mydubb.com", release = false, keyFile = join(root, "store/release-key.json") }) {
  const problems = [];
  const missing = [];
  const files = walk(dir).map((full) => relative(dir, full).split("\\").join("/")).sort();

  for (const name of files) {
    if (!ALLOWED_FILES.has(name)) problems.push(`unexpected file ${name}`);
    if (name.endsWith(".png")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    for (const banned of ["mydubbE2E", "mydubb.test", "__MYDUBB_"]) {
      if (text.includes(banned)) problems.push(`${name} contains ${banned}`);
    }
  }

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const permissions = [...(manifest.permissions ?? [])].sort().join(",");
  if (permissions !== "contextMenus,identity,offscreen,sidePanel,storage") problems.push(`permissions: ${permissions}`);
  const hosts = JSON.stringify(manifest.host_permissions ?? []);
  if (hosts !== JSON.stringify([`${origin}/*`])) problems.push(`host_permissions: ${hosts}`);
  for (const key of ["optional_permissions", "optional_host_permissions", "externally_connectable", "web_accessible_resources"]) {
    if (key in manifest) problems.push(`manifest has ${key}`);
  }
  const scripts = manifest.content_scripts ?? [];
  if (scripts.length !== 1 || JSON.stringify(scripts[0].matches) !== JSON.stringify(["https://www.udemy.com/*"]) || scripts[0].all_frames !== false) {
    problems.push("content_scripts changed");
  }

  // Icons: the four sizes, PNG, the size they claim, all present; the toolbar icons name two of them.
  const icons = manifest.icons ?? {};
  if (Object.keys(icons).sort().join(",") !== [...ICON_SIZES].sort().join(",")) problems.push(`icons: ${Object.keys(icons).join(",") || "none"}`);
  const toolbar = manifest.action?.default_icon ?? {};
  const named = [...Object.entries(icons).map(([s, p]) => [`icon ${s}`, s, p]), ...Object.entries(toolbar).map(([s, p]) => [`toolbar icon ${s}`, s, p])];
  for (const [label, size, path] of named) {
    const file = join(dir, String(path));
    if (!existsSync(file)) {
      problems.push(`${label}: ${path} is missing`);
      continue;
    }
    const got = pngSize(file);
    if (!got) problems.push(`${label}: ${path} is not a PNG`);
    else if (got.width !== Number(size) || got.height !== Number(size)) problems.push(`${label}: ${path} is ${got.width}x${got.height}`);
  }
  if (Object.keys(toolbar).sort().join(",") !== "16,32") problems.push("action.default_icon must name the 16 and 32 icons");

  if (!release) {
    if ("key" in manifest) problems.push("manifest has key (only a release build may carry it)");
    return { problems, missing };
  }

  // ---- Release mode: the Chrome Web Store conditions -------------------------------------------
  if (!origin.startsWith("https://") || ["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) problems.push(`release origin is ${origin}`);
  if (/prototype/i.test(`${manifest.name} ${manifest.description}`)) problems.push('name or description still says "Prototype"');
  if (manifest.name !== "MyDubb") problems.push(`name is ${JSON.stringify(manifest.name)}, expected "MyDubb"`);
  if (typeof manifest.description !== "string" || manifest.description.length === 0 || manifest.description.length > 132) {
    problems.push("description must be 1 to 132 characters");
  }
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) problems.push(`version ${manifest.version}`);

  let expected = null;
  try {
    expected = JSON.parse(readFileSync(keyFile, "utf8"));
  } catch {
    missing.push("verified release key: store/release-key.json does not exist (needs the Store Item ID and public key of a draft upload; see store/STABLE-ID.md)");
  }
  if (expected) {
    if (typeof expected.itemId !== "string" || typeof expected.publicKey !== "string") {
      problems.push("store/release-key.json needs itemId and publicKey");
    } else {
      let derived = null;
      try {
        derived = idFromPublicKey(expected.publicKey);
      } catch (error) {
        problems.push(`store/release-key.json public key: ${error.message}`);
      }
      if (derived && derived !== expected.itemId) problems.push(`store/release-key.json: the key gives ID ${derived}, not the Item ID ${expected.itemId}`);
      if (typeof manifest.key !== "string") missing.push("manifest has no key (build with `node build.mjs --release`)");
      else if (oneLine(manifest.key) !== oneLine(expected.publicKey)) problems.push("manifest key is not the verified release key");
    }
  } else if ("key" in manifest) {
    problems.push("manifest has a key but no verified release key is recorded");
  }
  return { problems, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = process.argv.includes("--release");
  const dirArg = process.argv.indexOf("--dir");
  const dir = join(root, dirArg > 0 ? process.argv[dirArg + 1] : release ? "dist-release" : "dist");
  const origin = process.env.MYDUBB_ORIGIN || "https://mydubb.com";
  const label = `${relative(root, dir)}/`;
  if (!existsSync(join(dir, "manifest.json"))) {
    console.error(`${label} has no manifest.json: build it first (node build.mjs${release ? " --release" : ""}).`);
    process.exit(1);
  }
  const { problems, missing } = checkDist({ dir, origin, release });
  if (problems.length > 0) {
    console.error(`${label} check failed:\n- ${problems.join("\n- ")}`);
    if (missing.length > 0) console.error(`Also not release-ready, missing:\n- ${missing.join("\n- ")}`);
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`${label} is NOT release-ready, missing:\n- ${missing.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`${label} check passed${release ? " (release conditions met)" : ""} (MyDubb server ${origin}).`);
}
