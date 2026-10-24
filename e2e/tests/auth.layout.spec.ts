import { expect, test, type Page } from "@playwright/test";

import { createUser, fillSignIn, overflow, signInAs, studio, theme } from "./authHelpers";
import { borderContrast, textContrast } from "./contrast";

// Browser checks of every email + password screen: no sideways overflow at phone and desktop
// widths, readable text and control borders in Light and Dark, long values, and keyboard use.
// Screenshots go to test-results/auth-shots/ for a human look; they are not assertions.

const WIDTHS = [320, 390, 412, 1280];
const LONG_WORD = "x".repeat(140);

/**
 * Elements that stick out of the sign-in card or the header. The card hides what overflows it, so
 * the page itself can look fine (no sideways scroll) while an input or button is cut off.
 */
const escapes = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const check = (root: Element | null) => {
      if (!root) return;
      const limit = root.getBoundingClientRect().right + 1;
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.closest(".sr-only")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > limit) {
          out.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)} ends at ${Math.round(rect.right)}, edge ${Math.round(limit)}`);
        }
      }
    };
    check(document.querySelector(".gate"));
    check(document.querySelector(".header-inner"));
    return out;
  });

async function setTheme(page: Page, wanted: "light" | "dark") {
  if ((await theme(page)) !== wanted) await page.locator(".header .pill").click();
  expect(await theme(page)).toBe(wanted);
}

/** Checks the current screen in both themes. */
async function checkScreen(page: Page, name: string, width: number, projectName: string) {
  for (const mode of ["light", "dark"] as const) {
    await setTheme(page, mode);
    const label = `${name} / ${mode} / ${width}px`;
    expect(await overflow(page), `${label}: horizontal overflow`).toBeLessThanOrEqual(0);
    expect(await escapes(page), `${label}: content sticking out of its container`).toEqual([]);

    const text = [
      page.locator(".gate-form h2"),
      page.locator(".gate-form label").first(),
      page.locator(".gate-form .muted").first(),
      page.locator(".gate-story h1"),
      page.locator(".button.primary").first(),
      page.locator(".link-button").first(),
      page.locator(".callout").first(),
      page.locator(".error").first(),
      page.locator(".input-action-button").first(),
      page.locator(".header .signed-in").first(),
    ];
    for (const target of text) {
      if ((await target.count()) === 0) continue;
      const ratio = await textContrast(target);
      expect(ratio, `${label}: text contrast ${ratio.toFixed(2)} of ${await target.evaluate((e) => e.className || e.tagName)}`)
        .toBeGreaterThanOrEqual(4.5);
    }
    const borders = [page.locator(".gate-form input").first(), page.locator(".button.ghost").first()];
    for (const target of borders) {
      if ((await target.count()) === 0) continue;
      const ratio = await borderContrast(target);
      expect(ratio, `${label}: border contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }

    await page.screenshot({
      path: `test-results/auth-shots/${projectName}-${width}-${name.replace(/\W+/g, "-")}-${mode}.png`,
      fullPage: true,
    });
  }
  await setTheme(page, "light");
}

for (const width of WIDTHS) {
  test(`every sign-in screen fits and is readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const check = (name: string) => checkScreen(page, name, width, testInfo.project.name);

    // Sign in, with an error message that has a very long unbroken word in it.
    await page.goto("/");
    await expect(page.getByLabel("Email")).toBeVisible();
    await check("sign-in");
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "invalid_credentials", message: `Incorrect ${LONG_WORD} password.` } }),
      }),
    );
    await page.getByLabel("Email").fill(`${"a".repeat(80)}@${"b".repeat(60)}.example.com`);
    await page.getByLabel("Password", { exact: true }).fill("whatever-1");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Incorrect");
    await check("sign-in with long email and long error");
    await page.unroute("**/api/auth/login");

    // Forgot and reset password.
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await check("forgot-password");
    await page.getByLabel("Email").fill(`${"c".repeat(100)}@example.com`);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByLabel("Verification code").fill("12-34");
    await page.getByLabel("New password").fill("one");
    await page.getByLabel("Confirm password").fill("two");
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByText("The two passwords do not match.")).toBeVisible();
    await check("reset-password with a long email and errors");
    await page.getByRole("button", { name: "Back to sign in" }).click();

    // Set your password.
    const temporary = await createUser({ temporary: true, emailVerified: false });
    await fillSignIn(page, temporary);
    await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible();
    await page.getByLabel("New password").fill("one");
    await page.getByLabel("Confirm password").fill("two");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByText("The two passwords do not match.")).toBeVisible();
    await check("set-password");

    // Verify your email, with a status and then an error on screen.
    await page.getByLabel("New password").fill("a-new-password-1");
    await page.getByLabel("Confirm password").fill("a-new-password-1");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
    await check("verify-email");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.locator(".gate-form").getByRole("status")).toBeVisible();
    await check("verify-email code sent");
    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await check("verify-email wrong code");

    // The Studio header with a very long account email.
    const long = await createUser({ name: null, emailLength: 120 });
    await page.getByRole("button", { name: "Back to sign in" }).click();
    await fillSignIn(page, long);
    await expect(studio(page)).toBeVisible();
    await check("studio with a long account email");
  });
}

test("keyboard only: tab order, visible focus, show/hide password and Enter to submit", async ({
  page,
}) => {
  const user = await createUser();
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  await page.getByLabel("Email").focus();

  const active = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return el.getAttribute("aria-label") || el.textContent?.trim() || el.id || el.tagName;
    });
  await page.keyboard.type(user.email);
  await page.keyboard.press("Tab");
  expect(await page.getByLabel("Password", { exact: true }).evaluate((e) => e === document.activeElement)).toBe(true);
  await page.keyboard.type(user.password);
  await page.keyboard.press("Tab");
  expect(await active()).toBe("Show password");
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  expect(await active()).toBe("Hide password");
  await page.keyboard.press("Space"); // and back
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  await page.keyboard.press("Tab");
  expect(await active()).toBe("Sign in");
  await page.keyboard.press("Tab");
  expect(await active()).toBe("Forgot password?");

  // Every focused control shows where the focus is.
  for (const name of ["Show password", "Sign in", "Forgot password?"]) {
    await page.getByRole("button", { name, exact: true }).focus();
    const style = await page.getByRole("button", { name, exact: true }).evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(style, name).not.toBe("none");
  }

  // Enter in the password field signs in.
  await page.getByLabel("Password", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(studio(page)).toBeVisible();
});

test("form errors are announced and tied to their fields", async ({ page }) => {
  const user = await createUser({ temporary: true });
  await page.goto("/");
  await fillSignIn(page, user);
  await page.getByLabel("New password").fill("a-new-password-1");
  await page.getByLabel("Confirm password").fill("a-different-one");
  await page.getByRole("button", { name: "Set password" }).click();

  const confirm = page.getByLabel("Confirm password");
  await expect(confirm).toHaveAttribute("aria-invalid", "true");
  const describedBy = await confirm.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText("The two passwords do not match.");

  // A server error is a live alert.
  await confirm.fill("a-new-password-1");
  await page.getByLabel("New password").fill("short");
  await confirm.fill("short");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert")).toContainText("does not meet the password requirements");
});
