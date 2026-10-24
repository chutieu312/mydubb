import { existsSync, readFileSync } from "node:fs";

// Credentials for the live run come from e2e/.env.live (Git-ignored, filled by the owner with an
// editor). They are read into memory here, never printed, never passed to a bundle or a report.

export interface LiveUser {
  email: string;
  password: string;
}

const FIELDS = [
  "LIVE_USER1_EMAIL",
  "LIVE_USER1_PASSWORD",
  "LIVE_USER2_EMAIL",
  "LIVE_USER2_PASSWORD",
] as const;

export function loadLive(): { user1: LiveUser; user2: LiveUser; secrets: string[] } {
  const file = new URL("../.env.live", import.meta.url);
  if (!existsSync(file)) throw new Error("e2e/.env.live does not exist");
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith("#")) values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  const missing = FIELDS.filter((name) => !values[name]);
  if (missing.length > 0) throw new Error(`e2e/.env.live has empty fields: ${missing.join(", ")}`);
  if (values.LIVE_USER1_EMAIL!.toLowerCase() === values.LIVE_USER2_EMAIL!.toLowerCase()) {
    throw new Error("LIVE_USER1_EMAIL and LIVE_USER2_EMAIL must be two different users");
  }
  const user1 = { email: values.LIVE_USER1_EMAIL!, password: values.LIVE_USER1_PASSWORD! };
  const user2 = { email: values.LIVE_USER2_EMAIL!, password: values.LIVE_USER2_PASSWORD! };
  const secrets = [user1, user2].flatMap((u) => [u.password, u.email, u.email.split("@")[0]!]);
  return { user1, user2, secrets: secrets.filter((s) => s.length >= 3) };
}

/** Removes every secret (and the local part of each email) from a text before it is shown. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("***");
  }
  return out;
}
