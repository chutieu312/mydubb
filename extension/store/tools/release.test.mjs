// Tests for the release tooling: key → ID, the ZIP writer/reader and the check-dist release mode.
// Run with `npm test` (node --test). The key below is a THROWAWAY public key made for this test;
// its private half was never kept. It is not the Store key and says nothing about the real ID.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkDist } from "../../check-dist.mjs";
import { idFromPublicKey } from "./key-to-id.mjs";
import { readZip, writeZip } from "./zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extension = join(here, "../..");

const PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwIXHS2ldFgIAXRy4GiN
JPQ92Y4u0uokemEPQmRBPvdTvVisu/sJIQvopzwB/xhivXQhs+3yMtiZNbzY/X4W
ctcbjGw7L/zkjhvBwazdYuYvys3m3FTfYIMwwVNhIhgD4IH723Y6WQejDSDMMJ/1
hovFe07HC1+qlRTGRjSTSd2VAJx5tQYW3I05A8WoaeR6M+12448kHiLqy+VMrn1c
cm+HucVRxyAjqx4bfgQlW1LqljoWZuN3Nq8q1ajnToWp4yPTgU+k9CMBJTnohQFi
buXyLnZI4Ia0lUy/iLcIUOF2R6AmxJ852FpAtu8QA1bYgyO/AhqQQ8kQtgEGPWoq
eQIDAQAB
-----END PUBLIC KEY-----`;
// SHA-256 of this key's DER, first 32 hex digits 0-f written as a-p; computed with `openssl pkey -pubin -outform DER | sha256sum`.
const ID = "hbjgcopjfmhfdfcibaehgnmdkhkpadpp".slice(0, 32);
const ONE_LINE = PEM.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");

const temp = mkdtempSync(join(tmpdir(), "mydubb-release-test-"));
after(() => rmSync(temp, { recursive: true, force: true }));

let counter = 0;
/** A minimal production-like build folder with the real icons; `edit` may change the manifest. */
function fakeDist(edit = () => {}) {
  const dir = join(temp, `dist-${counter++}`);
  mkdirSync(join(dir, "icons"), { recursive: true });
  cpSync(join(extension, "store/branding/png"), join(dir, "icons"), { recursive: true });
  for (const name of ["background.js", "content.js", "offscreen.js", "sidepanel.js"]) writeFileSync(join(dir, name), "// bundle\n");
  for (const name of ["offscreen.html", "sidepanel.html", "sidepanel.css"]) writeFileSync(join(dir, name), "x\n");
  const manifest = JSON.parse(readFileSync(join(extension, "static/manifest.json"), "utf8"));
  manifest.host_permissions = ["https://mydubb.com/*"];
  edit(manifest, dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}
function keyFile(contents) {
  const file = join(temp, `key-${counter++}.json`);
  writeFileSync(file, JSON.stringify(contents));
  return file;
}
const run = (dir, options = {}) => checkDist({ dir, keyFile: join(temp, "absent.json"), ...options });

describe("key → ID", () => {
  test("matches the openssl derivation, for PEM and for the one-line manifest form", () => {
    assert.equal(idFromPublicKey(PEM), ID);
    assert.equal(idFromPublicKey(ONE_LINE), ID);
    assert.match(ID, /^[a-p]{32}$/);
  });
  test("refuses a private key and text that is not a key", () => {
    assert.throws(() => idFromPublicKey("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"), /private key/);
    assert.throws(() => idFromPublicKey("not a key"));
  });
});

describe("ZIP", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"a":1}') },
    { name: "icons/icon-16.png", data: Buffer.alloc(300, 7) },
    { name: "tiếng-việt.js", data: Buffer.from("// ok") },
  ];
  test("reads back what was written, with manifest.json at the root, and is deterministic", () => {
    const zip = writeZip(entries);
    assert.ok(writeZip([...entries].reverse()).equals(zip));
    const back = readZip(zip);
    assert.deepEqual(back.map((e) => e.name).sort(), entries.map((e) => e.name).sort());
    for (const e of entries) assert.ok(back.find((b) => b.name === e.name).data.equals(e.data));
  });
  test("a damaged entry is detected", () => {
    const zip = Buffer.from(writeZip(entries));
    zip[zip.indexOf(Buffer.from("manifest.json")) + 20] ^= 0xff;
    assert.throws(() => readZip(zip));
  });
});

describe("check-dist, ordinary build", () => {
  test("the real manifest shape passes and carries no key", () => {
    assert.deepEqual(run(fakeDist()), { problems: [], missing: [] });
  });
  test("a key, a test hook, an extra permission, a wrong icon or an unknown file fail", () => {
    assert.match(run(fakeDist((m) => (m.key = ONE_LINE))).problems.join("\n"), /manifest has key/);
    assert.match(run(fakeDist((_, d) => writeFileSync(join(d, "content.js"), "mydubbE2E"))).problems.join("\n"), /contains mydubbE2E/);
    assert.match(run(fakeDist((m) => m.permissions.push("tabs"))).problems.join("\n"), /permissions/);
    assert.match(run(fakeDist((m) => (m.icons["48"] = "icons/icon-16.png"))).problems.join("\n"), /is 16x16/);
    assert.match(run(fakeDist((_, d) => writeFileSync(join(d, "fixture.js"), "x"))).problems.join("\n"), /unexpected file fixture\.js/);
    assert.match(run(fakeDist((m) => delete m.icons["128"])).problems.join("\n"), /icons:/);
  });
});

describe("check-dist --release", () => {
  const release = (dir, file) => run(dir, { release: true, keyFile: file });
  test("without a recorded key it is not release-ready and says what is missing", () => {
    const result = release(fakeDist());
    assert.deepEqual(result.problems, []);
    assert.match(result.missing.join("\n"), /release key/);
  });
  test("the verified key and its Item ID pass; the manifest must carry exactly that key", () => {
    const file = keyFile({ itemId: ID, publicKey: PEM });
    assert.deepEqual(release(fakeDist((m) => (m.key = ONE_LINE)), file), { problems: [], missing: [] });
    assert.match(release(fakeDist(), file).missing.join("\n"), /manifest has no key/);
  });
  test("another key, or a key that does not give the Item ID, fails", () => {
    const file = keyFile({ itemId: ID, publicKey: PEM });
    const other = ONE_LINE.slice(0, -10) + "AAAAAAAAAA";
    assert.ok(release(fakeDist((m) => (m.key = other)), file).problems.length > 0);
    const wrongId = keyFile({ itemId: "a".repeat(32), publicKey: PEM });
    assert.match(release(fakeDist((m) => (m.key = ONE_LINE)), wrongId).problems.join("\n"), /gives ID/);
  });
  test("a key without a recorded verified key fails", () => {
    assert.match(release(fakeDist((m) => (m.key = ONE_LINE))).problems.join("\n"), /no verified release key/);
  });
  test("a prototype name, a long description or a local origin fail", () => {
    const file = keyFile({ itemId: ID, publicKey: PEM });
    assert.match(release(fakeDist((m) => ((m.key = ONE_LINE), (m.name = "MyDubb Prototype"))), file).problems.join("\n"), /Prototype/);
    assert.match(release(fakeDist((m) => ((m.key = ONE_LINE), (m.description = "x".repeat(133)))), file).problems.join("\n"), /132/);
    assert.match(checkDist({ dir: fakeDist((m) => (m.key = ONE_LINE)), origin: "http://localhost:8000", release: true, keyFile: file }).problems.join("\n"), /release origin/);
  });
});
