// Removes the live run's own Playwright output folder (e2e/test-results/live) after every run,
// passed or failed. Playwright writes error-context.md there for a failed test; the live config
// already keeps page snapshots, traces, videos and screenshots out of it, and this removes what is
// left. It never runs if the process is killed (kill -9, a crash, closing the terminal).
import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const LIVE_OUTPUT_DIR = resolve(e2eDir, "test-results", "live");

export default async function removeLiveOutput() {
  // Only ever this one folder: <e2e>/test-results/live, checked as an absolute path.
  const expectedParent = resolve(e2eDir, "test-results");
  if (dirname(LIVE_OUTPUT_DIR) !== expectedParent || basename(LIVE_OUTPUT_DIR) !== "live") {
    throw new Error("refusing to delete an unexpected path");
  }
  await rm(LIVE_OUTPUT_DIR, { recursive: true, force: true });
}
