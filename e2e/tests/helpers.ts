import { expect, type Page } from "@playwright/test";

export function accessCode(): string {
  const code = process.env.E2E_ACCESS_CODE;
  if (!code) throw new Error("E2E_ACCESS_CODE is not set (use e2e/run-e2e.sh)");
  return code;
}

export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Access Code").fill(accessCode());
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByLabel("English Transcript")).toBeVisible();
}

export async function fillJobForm(
  page: Page,
  { transcript, first = "00:00:10", last = "00:06:10", voice = "HoaiMy" }: {
    transcript: string;
    first?: string;
    last?: string;
    voice?: "HoaiMy" | "NamMinh";
  },
): Promise<void> {
  await page.getByLabel("English Transcript").fill(transcript);
  await page.getByLabel("First Sentence Start Time").fill(first);
  await page.getByLabel("Last Sentence Start Time").fill(last);
  await page.getByLabel(new RegExp(voice)).check();
}
