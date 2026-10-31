// Checks the unpacked production build (dist/) before it can be loaded or shared: no test hook,
// no test server, and exactly the permissions the README documents. Run after `npm run build`.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const problems = [];
const expectedOrigin = process.env.MYDUBB_ORIGIN || "https://mydubb.com";

for (const name of readdirSync(dist)) {
  const text = readFileSync(join(dist, name), "utf8");
  for (const banned of ["mydubbE2E", "mydubb.test", "__MYDUBB_"]) {
    if (text.includes(banned)) problems.push(`${name} contains ${banned}`);
  }
}

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const permissions = [...(manifest.permissions ?? [])].sort().join(",");
if (permissions !== "contextMenus,identity,sidePanel,storage") problems.push(`permissions: ${permissions}`);
const hosts = JSON.stringify(manifest.host_permissions ?? []);
if (hosts !== JSON.stringify([`${expectedOrigin}/*`])) problems.push(`host_permissions: ${hosts}`);
for (const key of ["optional_permissions", "optional_host_permissions", "externally_connectable", "web_accessible_resources", "key"]) {
  if (key in manifest) problems.push(`manifest has ${key}`);
}
const scripts = manifest.content_scripts ?? [];
if (scripts.length !== 1 || JSON.stringify(scripts[0].matches) !== JSON.stringify(["https://www.udemy.com/*"]) || scripts[0].all_frames !== false) {
  problems.push("content_scripts changed");
}

if (problems.length > 0) {
  console.error(`dist/ check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`dist/ check passed (MyDubb server ${expectedOrigin}).`);
