// The spinner beside the status of a job that is queued or being processed, in the real extension
// build: it shows for the four working statuses with the status still in words, moves (and stands
// still for reduced motion), is the brand's mint in dark mode, and is gone once the job completes
// or fails. Against the fake MyDubb server: local evidence only, not the real mydubb.com.

import type { Page } from "@playwright/test";

import { connectAccount, expect, fillTimes, openLecture, openPanel, sendTranscriptSelection, test } from "./harness";

const STATES = [
  ["queued", "Queued…", "queued"],
  ["translating", "Translating…", "translating"],
  ["synthesizing", "Generating speech…", "generating-speech"],
  ["processing", "Processing audio…", "processing-audio"],
] as const;

const status = (panel: Page) => panel.locator("#job-status");
const spinner = (panel: Page) =>
  status(panel).evaluate((el) => {
    const style = getComputedStyle(el, "::before");
    return {
      shown: style.content !== "none" && style.content !== "normal",
      animation: style.animationName,
      color: style.borderTopColor,
      transform: style.transform,
    };
  });

test("a spinner beside Queued, Translating, Generating speech and Processing audio; gone at Completed or Failed", async ({ context, worker, extensionId, mydubb }) => {
  test.setTimeout(120_000);
  const { page, tabId } = await openLecture(context, worker, 901);
  const panel = await openPanel(context, extensionId, tabId);
  await panel.setViewportSize({ width: 390, height: 900 });
  await sendTranscriptSelection(page, worker, tabId);
  await connectAccount(panel, mydubb, extensionId);
  await fillTimes(panel);
  mydubb.advance = false;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  const card = panel.locator("section.audio-card");

  for (const scheme of ["light", "dark"] as const) {
    await panel.emulateMedia({ colorScheme: scheme });
    for (const [apiStatus, text, file] of STATES) {
      mydubb.complete("job-1", apiStatus);
      await expect(status(panel)).toHaveText(text, { timeout: 20_000 });
      await expect(status(panel)).toHaveClass(/working/);
      const now = await spinner(panel);
      expect(now.shown, `${text} (${scheme})`).toBe(true);
      // The brand color: mint in dark mode, the website's teal in light mode.
      expect(now.color).toBe(scheme === "dark" ? "rgb(123, 224, 197)" : "rgb(8, 118, 110)");
      await card.screenshot({ path: test.info().outputPath(`spinner-${file}-${scheme}.png`) });
    }
  }

  // It really turns: two readings of its transform differ, under the page's own animation.
  await panel.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  const moving = await spinner(panel);
  expect(moving.animation).toBe("job-spin");
  await panel.waitForTimeout(250);
  expect((await spinner(panel)).transform).not.toBe(moving.transform);

  // Reduced motion: the same ring, still.
  await panel.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const still = await spinner(panel);
  expect(still.shown).toBe(true);
  expect(still.animation).toBe("none");
  await panel.waitForTimeout(250);
  expect((await spinner(panel)).transform).toBe(still.transform);
  await card.screenshot({ path: test.info().outputPath("spinner-reduced-motion-dark.png") });
  await panel.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  // Completed: the words stay, the spinner goes, the audio loads and nothing plays.
  mydubb.complete("job-1", "completed");
  mydubb.advance = true;
  await expect(status(panel)).toHaveText("Completed.", { timeout: 20_000 });
  await expect(status(panel)).not.toHaveClass(/working/);
  expect((await spinner(panel)).shown).toBe(false);
  await expect(panel.getByText("Ready. Press play when you want to listen.")).toBeVisible({ timeout: 20_000 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // A job that fails: no spinner either.
  mydubb.advance = false;
  await panel.getByRole("button", { name: "Generate audio" }).click();
  await expect(status(panel)).toHaveClass(/working/, { timeout: 20_000 });
  mydubb.complete("job-2", "failed");
  await expect(status(panel)).toHaveText("Failed.", { timeout: 20_000 });
  await expect(status(panel)).not.toHaveClass(/working/);
  expect((await spinner(panel)).shown).toBe(false);
});
