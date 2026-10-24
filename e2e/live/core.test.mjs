// Tests of the live tooling with FAKE data only (no credentials, no network beyond 127.0.0.1).
// Run: cd e2e && npm run test:live-tooling
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isLoopbackHost,
  liveUsersFrom,
  parseLiveEnv,
  parseLoopbackUrl,
  redirectAllowed,
  resolveStatic,
  safeDecode,
  scrub,
  secretForms,
} from "./core.mjs";
import removeLiveOutput, { LIVE_OUTPUT_DIR } from "./teardown.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("local targets only", () => {
  test("accepts plain http on loopback addresses", () => {
    for (const url of ["http://127.0.0.1:5199", "http://localhost:3000/", "http://[::1]:8080", "http://127.4.5.6"]) {
      assert.ok(parseLoopbackUrl(url, "X"), url);
    }
  });

  test("rejects anything else, naming the variable only", () => {
    for (const url of [
      "https://127.0.0.1:5199",
      "http://mydubb.com",
      "http://192.168.1.2:5199",
      "http://0.0.0.0:5199",
      "http://127.0.0.1.evil.example",
      "http://localhost.evil.example",
      "http://user:pw@127.0.0.1:5199",
      "http://127.0.0.1:5199/path",
      "http://127.0.0.1:5199/?q=1",
      "http://127.0.0.1:5199/#x",
      "ftp://127.0.0.1",
      "not a url",
      "",
    ]) {
      assert.throws(() => parseLoopbackUrl(url, "LIVE_UI_URL"), /^Error: LIVE_UI_URL /, url);
    }
    assert.equal(isLoopbackHost("127.0.0.256"), false);
    assert.equal(isLoopbackHost("127.0.0"), false);
  });

  test("lets a redirect through only if it stays on the browser's origin", () => {
    const origin = "http://127.0.0.1:5199";
    assert.equal(redirectAllowed("/api/ok", origin), true);
    assert.equal(redirectAllowed("http://127.0.0.1:5199/x", origin), true);
    assert.equal(redirectAllowed(undefined, origin), true);
    for (const location of [
      "https://mydubb.com/",
      "//evil.example/x",
      "http://127.0.0.1:9999/",
      "http://localhost:5199/", // another origin, even if loopback
      "javascript:alert(1)",
      "http://[",
    ]) {
      assert.equal(redirectAllowed(location, origin), false, location);
    }
  });

  test("decodes malformed URLs without throwing", () => {
    assert.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
    assert.equal(safeDecode("a%20b"), "a b");
  });
});

describe("static files stay inside dist", () => {
  let root;
  let dist;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "live-static-"));
    dist = join(root, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    mkdirSync(join(root, "dist-secret"));
    writeFileSync(join(dist, "index.html"), "INDEX");
    writeFileSync(join(dist, "assets", "app.js"), "APP");
    writeFileSync(join(root, "dist-secret", "secret.txt"), "SIBLING");
    writeFileSync(join(root, "outside.txt"), "OUTSIDE");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("serves files and falls back to the page", () => {
    assert.deepEqual(resolveStatic(dist, "/"), { kind: "index" });
    assert.equal(resolveStatic(dist, "/assets/app.js").kind, "file");
    assert.deepEqual(resolveStatic(dist, "/no/such/page"), { kind: "index" });
  });

  test("never resolves to a file outside dist, including a sibling dist-* folder", () => {
    for (const path of [
      "/../dist-secret/secret.txt",
      "/..%2fdist-secret%2fsecret.txt",
      "/%2e%2e/%2e%2e/outside.txt",
      "/assets/../../outside.txt",
      "/..%5cdist-secret%5csecret.txt",
      "/../outside.txt",
    ]) {
      const result = resolveStatic(dist, path);
      assert.notEqual(result.kind, "file", path);
      if (result.kind === "file") assert.fail(path);
    }
  });

  test("malformed encoding and NUL bytes are a bad request", () => {
    assert.deepEqual(resolveStatic(dist, "/%E0%A4%A"), { kind: "bad-request" });
    assert.deepEqual(resolveStatic(dist, "/index.html%00.js"), { kind: "bad-request" });
  });
});

describe("credentials file", () => {
  // FAKE values with every character that a loose parser would change.
  const tricky = ` p"a\\ss w0rd=#%2F'+é `;
  const file = [
    "﻿# comment",
    "",
    "LIVE_USER1_EMAIL=odd+tag@example.com",
    `LIVE_USER1_PASSWORD=${tricky}`,
    "LIVE_USER2_EMAIL=Second.User@Example.com",
    "LIVE_USER2_PASSWORD='quoted'",
  ].join("\r\n");

  test("keeps every value byte for byte (no trimming, quotes, escapes or comments)", () => {
    const values = parseLiveEnv(file);
    assert.equal(values.LIVE_USER1_PASSWORD, tricky);
    assert.equal(values.LIVE_USER2_PASSWORD, "'quoted'");
    assert.equal(values.LIVE_USER1_EMAIL, "odd+tag@example.com");
    const { user1, warnings } = liveUsersFrom(values);
    assert.equal(user1.password, tricky);
    assert.deepEqual(warnings, ["LIVE_USER1_PASSWORD starts or ends with whitespace; it is used exactly as written"]);
  });

  test("format errors name the line and the problem, never the content", () => {
    const secret = "S3cret-value";
    const cases = [
      [`LIVE_USER1_PASSWORD = ${secret}`, /line 1: expected one of/],
      [`UNKNOWN=${secret}`, /line 1: expected one of/],
      [`just text ${secret}`, /line 1: expected one of/],
      [`LIVE_USER1_PASSWORD=${secret}\nLIVE_USER1_PASSWORD=${secret}`, /line 2: LIVE_USER1_PASSWORD appears twice/],
      [` LIVE_USER1_PASSWORD=${secret}`, /line 1: expected one of/],
    ];
    for (const [text, expected] of cases) {
      assert.throws(() => parseLiveEnv(text), (error) => {
        assert.match(error.message, expected);
        assert.equal(error.message.includes(secret), false);
        return true;
      });
    }
  });

  test("checks the two users without echoing values", () => {
    const base = parseLiveEnv(file);
    assert.throws(() => liveUsersFrom({ ...base, LIVE_USER2_PASSWORD: "" }), /empty fields: LIVE_USER2_PASSWORD$/);
    assert.throws(() => liveUsersFrom({ ...base, LIVE_USER2_EMAIL: "ODD+TAG@example.com" }), /two different users/);
    assert.throws(() => liveUsersFrom({ ...base, LIVE_USER1_EMAIL: "odd+tag@example.com " }), /^Error: LIVE_USER1_EMAIL must be/);
  });
});

describe("redaction", () => {
  const users = [
    { email: "odd+tag@example.com", password: `p"a\\ss w0rd=#%2F'+é` },
    { email: "Second.User@Example.com", password: "x" },
  ];
  const forms = secretForms(users);

  test("removes raw, JSON-escaped and URL-encoded forms of every secret", () => {
    for (const user of users) {
      const message = [
        `fill("${user.password}")`,
        JSON.stringify({ password: user.password, email: user.email }),
        `/api/x?q=${encodeURIComponent(user.password)}&e=${encodeURIComponent(user.email)}`,
        `form=${encodeURIComponent(user.password).replace(/%20/g, "+")}`,
        user.email.toLowerCase(),
        `local part ${user.email.split("@")[0]}`,
      ].join("\n");
      const clean = scrub(message, forms);
      for (const form of [user.password, JSON.stringify(user.password).slice(1, -1), encodeURIComponent(user.password), user.email, user.email.toLowerCase()]) {
        if (form.length > 1) assert.equal(clean.includes(form), false, `left: ${form.length} chars`);
      }
    }
  });
});

describe("serve.mjs (spawned with fake backend and fake dist)", () => {
  let root;
  let backend;
  let backendPort;
  let child;
  let port;

  const freePort = () =>
    new Promise((resolvePort) => {
      const probe = http.createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address();
        probe.close(() => resolvePort(free));
      });
    });

  const get = (path, host = `127.0.0.1:${port}`, extra = {}) =>
    new Promise((resolveGet, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host, ...extra } },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolveGet({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "live-serve-"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "dist-secret"));
    writeFileSync(join(root, "dist", "index.html"), "INDEX");
    writeFileSync(join(root, "dist-secret", "secret.txt"), "SIBLING");

    backend = http.createServer((req, res) => {
      if (req.url === "/api/redirect-out") {
        res.writeHead(302, { Location: "https://example.com/steal" });
        return res.end();
      }
      if (req.url === "/api/redirect-in") {
        res.writeHead(302, { Location: "/api/echo" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null }));
    });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    backendPort = backend.address().port;
    port = await freePort();

    child = spawn(process.execPath, [join(here, "serve.mjs")], {
      env: {
        ...process.env,
        LIVE_DIST: join(root, "dist"),
        LIVE_BACKEND: `http://127.0.0.1:${backendPort}`,
        LIVE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((ready, fail) => {
      child.stdout.on("data", (chunk) => String(chunk).includes("live UI on") && ready());
      child.on("exit", (code) => fail(new Error(`serve.mjs exited ${code}`)));
    });
  });

  after(async () => {
    child?.kill();
    await new Promise((r) => backend.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  test("serves the page and blocks traversal and the sibling folder", async () => {
    assert.equal((await get("/")).body, "INDEX");
    for (const path of ["/..%2fdist-secret%2fsecret.txt", "/%2e%2e/dist-secret/secret.txt"]) {
      const answer = await get(path);
      assert.notEqual(answer.body, "SIBLING", path);
      assert.equal(answer.status, 404, path);
    }
  });

  test("answers malformed encoding with 400 and keeps running", async () => {
    assert.equal((await get("/%E0%A4%A")).status, 400);
    assert.equal((await get("/")).status, 200);
  });

  test("refuses a Host that is not loopback (DNS rebinding)", async () => {
    assert.equal((await get("/", "attacker.example:80")).status, 421);
    assert.equal((await get("/api/echo", "attacker.example:80")).status, 421);
  });

  test("forwards /api with Host and Origin untouched", async () => {
    const answer = await get("/api/echo", `127.0.0.1:${port}`, { Origin: `http://127.0.0.1:${port}` });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
    });
  });

  test("blocks a backend redirect that leaves the origin, passes one that stays", async () => {
    const out = await get("/api/redirect-out");
    assert.equal(out.status, 502);
    assert.equal(out.headers.location, undefined);
    const inside = await get("/api/redirect-in");
    assert.equal(inside.status, 302);
    assert.equal(inside.headers.location, "/api/echo");
  });

  test("refuses to start with a backend that is not loopback", async () => {
    const refused = spawn(process.execPath, [join(here, "serve.mjs")], {
      env: { ...process.env, LIVE_BACKEND: "http://mydubb.com", LIVE_PORT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    refused.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((r) => refused.on("exit", r));
    assert.equal(code, 2);
    assert.match(stderr, /LIVE_BACKEND must point to a loopback address/);
  });
});

describe("teardown", () => {
  test("removes only <e2e>/test-results/live", async () => {
    const expected = join(here, "..", "test-results", "live");
    assert.equal(LIVE_OUTPUT_DIR, join(dirname(expected), "live"));
    const neighbour = join(dirname(LIVE_OUTPUT_DIR), "live-teardown-neighbour");
    mkdirSync(join(LIVE_OUTPUT_DIR, "case"), { recursive: true });
    mkdirSync(neighbour, { recursive: true });
    writeFileSync(join(LIVE_OUTPUT_DIR, "case", "error-context.md"), "fake");
    writeFileSync(join(neighbour, "keep.txt"), "keep");

    await removeLiveOutput();

    assert.equal(existsSync(LIVE_OUTPUT_DIR), false);
    assert.equal(existsSync(join(neighbour, "keep.txt")), true);
    rmSync(neighbour, { recursive: true, force: true });
  });
});
