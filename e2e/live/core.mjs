// Pure helpers of the live browser acceptance (no I/O except the static-file check). They are
// shared by serve.mjs, playwright.live.config.ts and live.spec.ts, and tested with fake data in
// core.test.mjs (`npm run test:live-tooling`).
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ---- Local targets only ---------------------------------------------------------------------

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase();
  if (LOOPBACK_NAMES.has(host)) return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * Parses `value` as the base URL of a local server and returns it, or throws. Only plain http to a
 * loopback address is accepted: no credentials, path, query or fragment. `name` is used in the
 * message (the value is not a secret).
 */
export function parseLoopbackUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== "http:") throw new Error(`${name} must use http:// (local servers only)`);
  if (!isLoopbackHost(url.hostname)) throw new Error(`${name} must point to a loopback address`);
  if (url.username || url.password) throw new Error(`${name} must not contain a user or password`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`${name} must be an origin only (no path, query or fragment)`);
  }
  return url;
}

/** True when `url` (absolute) is http(s) on `origin` exactly. */
export function isSameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * A redirect from the backend may be passed to the browser only if it stays on the origin the
 * browser is using (a relative Location, or the same loopback origin).
 */
export function redirectAllowed(location, requestOrigin) {
  if (!location) return true;
  try {
    const target = new URL(location, requestOrigin);
    return target.origin === requestOrigin && isLoopbackHost(target.hostname);
  } catch {
    return false;
  }
}

/** decodeURIComponent that never throws; malformed input comes back unchanged. */
export function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ---- Static files ---------------------------------------------------------------------------

/**
 * Maps a request path to a file inside `dist`. Returns { kind: "file", file },
 * { kind: "index" } (single-page fallback), { kind: "bad-request" } for malformed encoding or a
 * NUL byte, or { kind: "not-found" } for anything that would leave `dist` (`..`, a sibling such
 * as `dist-old`, another drive).
 */
export function resolveStatic(dist, rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return { kind: "bad-request" };
  }
  if (decoded.includes("\0")) return { kind: "bad-request" };
  const root = resolve(dist);
  const target = resolve(root, `.${decoded.startsWith("/") ? "" : "/"}${decoded}`);
  const rel = relative(root, target);
  if (rel === "") return { kind: "index" };
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { kind: "not-found" };
  try {
    if (statSync(target).isFile()) return { kind: "file", file: target };
  } catch {
    // missing: the UI has one page, unknown paths get it
  }
  return { kind: "index" };
}

// ---- Credentials file -----------------------------------------------------------------------

export const LIVE_FIELDS = [
  "LIVE_USER1_EMAIL",
  "LIVE_USER1_PASSWORD",
  "LIVE_USER2_EMAIL",
  "LIVE_USER2_PASSWORD",
];

/**
 * Format of e2e/.env.live, deliberately strict so a password is never changed by parsing:
 * - one `NAME=value` per line; NAME is one of LIVE_FIELDS, at the start of the line, with no
 *   space before `=`;
 * - the value is everything after the first `=`, byte for byte: no trimming, no quotes, no
 *   escapes, no inline comments (`#`, quotes, `=` and spaces are part of the value);
 * - empty lines and lines starting with `#` are ignored; a UTF-8 BOM and CRLF line ends are fine;
 * - anything else (unknown name, a name twice, a line without `=`) is an error that names the line
 *   number and the problem, never its content.
 */
export function parseLiveEnv(text) {
  const values = {};
  const lines = String(text).replace(/^﻿/, "").split("\n");
  lines.forEach((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith("#")) return;
    const equals = line.indexOf("=");
    const name = equals > 0 ? line.slice(0, equals) : "";
    if (!LIVE_FIELDS.includes(name)) {
      throw new Error(`e2e/.env.live line ${index + 1}: expected one of ${LIVE_FIELDS.join(", ")} followed by =`);
    }
    if (name in values) throw new Error(`e2e/.env.live line ${index + 1}: ${name} appears twice`);
    values[name] = line.slice(equals + 1);
  });
  return values;
}

/** The two users, validated. Messages name fields, never values. */
export function liveUsersFrom(values) {
  const missing = LIVE_FIELDS.filter((name) => !values[name]);
  if (missing.length > 0) throw new Error(`e2e/.env.live has empty fields: ${missing.join(", ")}`);
  for (const name of ["LIVE_USER1_EMAIL", "LIVE_USER2_EMAIL"]) {
    if (/\s/.test(values[name]) || !/^[^@]+@[^@]+$/.test(values[name])) {
      throw new Error(`${name} must be one email address without spaces`);
    }
  }
  if (values.LIVE_USER1_EMAIL.toLowerCase() === values.LIVE_USER2_EMAIL.toLowerCase()) {
    throw new Error("LIVE_USER1_EMAIL and LIVE_USER2_EMAIL must be two different users");
  }
  const user1 = { email: values.LIVE_USER1_EMAIL, password: values.LIVE_USER1_PASSWORD };
  const user2 = { email: values.LIVE_USER2_EMAIL, password: values.LIVE_USER2_PASSWORD };
  const warnings = [];
  for (const name of ["LIVE_USER1_PASSWORD", "LIVE_USER2_PASSWORD"]) {
    if (values[name] !== values[name].trim()) {
      warnings.push(`${name} starts or ends with whitespace; it is used exactly as written`);
    }
  }
  return { user1, user2, warnings };
}

// ---- Redaction (a last line of defence; secrets are kept out of messages in the first place) --

/** Every form in which a secret may show up in a message: raw, JSON-escaped, URL-encoded. */
export function secretForms(users) {
  const forms = new Set();
  const add = (value, minimum) => {
    if (!value || value.length < minimum) return;
    for (const form of [
      value,
      value.toLowerCase(),
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      encodeURIComponent(value).replace(/%20/g, "+"),
    ]) {
      if (form.length >= minimum) forms.add(form);
    }
  };
  for (const user of users) {
    add(user.password, 1); // always, whatever its length
    add(user.email, 3);
    add(user.email.split("@")[0], 3);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

export function scrub(text, forms) {
  let out = String(text);
  for (const form of forms) out = out.split(form).join("***");
  return out;
}
