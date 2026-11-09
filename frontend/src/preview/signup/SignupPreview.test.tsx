import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUSY_EMAIL, DEMO_CODE, EXPIRED_CODE, UNAVAILABLE_CODE } from "./mockSignup";
import SignupPreview from "./SignupPreview";

type User = ReturnType<typeof userEvent.setup>;

let fetchSpy: ReturnType<typeof vi.fn>;
let setItemSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The preview must work with no network at all: any request fails the test.
  fetchSpy = vi.fn(() => Promise.reject(new Error("the preview must not use the network")));
  vi.stubGlobal("fetch", fetchSpy);
  setItemSpy = vi.spyOn(Storage.prototype, "setItem");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(setItemSpy).not.toHaveBeenCalled();
});

function setup() {
  render(<SignupPreview delayMs={0} />);
  return userEvent.setup();
}

const input = (name: string) => screen.getByLabelText(name, { selector: "input" }) as HTMLInputElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const captcha = () => screen.getByLabelText(/not a robot/i) as HTMLInputElement;

/** The text of the message that describes an input (what a screen reader reads with it). */
function describedBy(element: HTMLElement): string {
  const ids = (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}
const invalid = (element: HTMLElement) => element.getAttribute("aria-invalid") === "true";

async function openCreate(user: User) {
  await user.click(button("Create account"));
  await screen.findByRole("heading", { name: "Create your account" });
}

async function fillCreate(user: User, email = "ada@example.com", password = "long-enough-1") {
  await user.type(input("Email"), email);
  await user.type(input("Password"), password);
  await user.click(captcha());
}

async function reachVerify(user: User, email = "ada@example.com") {
  await openCreate(user);
  await fillCreate(user, email);
  await user.click(button("Create account"));
  await screen.findByRole("heading", { name: "Verify your email" });
}

describe("entry", () => {
  it("shows Create account next to the Sign in form, which does nothing real", async () => {
    const user = setup();

    expect(button("Sign in")).toBeTruthy();
    expect(button("Create account")).toBeTruthy();
    expect(screen.getByText(/20 Generates and 5 YouTube imports per day/)).toBeTruthy();
    expect(screen.getByText(/reset at 00:00 UTC/i)).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/Prototype preview/);

    await user.type(input("Email"), "ada@example.com");
    await user.type(input("Password"), "pw-123456");
    await user.click(button("Sign in"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/switched off in this preview/);
  });

  it("lists the demo data on the page", () => {
    setup();
    const panel = screen.getByText("Try these cases").closest("details");
    expect(panel?.open).toBe(true);
    for (const value of [BUSY_EMAIL, DEMO_CODE, EXPIRED_CODE, UNAVAILABLE_CODE]) {
      expect(panel?.textContent).toContain(value);
    }
  });
});

describe("create account", () => {
  it("shows a message beside every empty field and moves focus to the first", async () => {
    const user = setup();
    await openCreate(user);
    await user.click(button("Create account"));

    expect(invalid(input("Email"))).toBe(true);
    expect(describedBy(input("Email"))).toBe("Enter your email address.");
    expect(invalid(input("Password"))).toBe(true);
    expect(describedBy(input("Password"))).toBe("Enter a password.");
    expect(invalid(captcha())).toBe(true);
    expect(describedBy(captcha())).toMatch(/Confirm you are not a robot to continue\./);
    expect(document.activeElement).toBe(input("Email"));
  });

  it("explains a malformed email and a short password, and clears a message when edited", async () => {
    const user = setup();
    await openCreate(user);
    await user.type(input("Email"), "ada@");
    await user.type(input("Password"), "short");
    await user.click(captcha());
    await user.click(button("Create account"));

    expect(describedBy(input("Email"))).toMatch(/valid email address/);
    expect(describedBy(input("Password"))).toBe("Use at least 8 characters.");
    expect(invalid(captcha())).toBe(false);

    await user.type(input("Email"), "x.com");
    expect(invalid(input("Email"))).toBe(false);
  });

  it("asks for the checkbox when everything else is right", async () => {
    const user = setup();
    await openCreate(user);
    await user.type(input("Email"), "ada@example.com");
    await user.type(input("Password"), "long-enough-1");
    await user.click(button("Create account"));

    expect(invalid(input("Email"))).toBe(false);
    expect(invalid(input("Password"))).toBe(false);
    expect(describedBy(captcha())).toMatch(/Confirm you are not a robot/);
    expect(document.activeElement).toBe(captcha());
    expect(captcha().checked).toBe(false);
    expect(screen.getByText(/No Google reCAPTCHA is loaded or called/)).toBeTruthy();

    await user.keyboard(" ");
    expect(captcha().checked).toBe(true);
  });

  it("fails once for the busy address, keeps the input, and works on the retry", async () => {
    const user = setup();
    await openCreate(user);
    await fillCreate(user, BUSY_EMAIL);
    await user.click(button("Create account"));

    expect((await screen.findByRole("alert")).textContent).toMatch(/can't create accounts right now/);
    expect(input("Email").value).toBe(BUSY_EMAIL);
    expect(input("Password").value).toBe("long-enough-1");
    expect(captcha().checked).toBe(true);
    // Waiting for the request must not have thrown the keyboard focus away.
    expect(document.activeElement).toBe(button("Create account"));

    await user.click(button("Create account"));
    await screen.findByRole("heading", { name: "Verify your email" });
    expect(screen.getByText(BUSY_EMAIL)).toBeTruthy();
  });

  it("goes back to Sign in", async () => {
    const user = setup();
    await openCreate(user);
    await user.click(button("Back to sign in"));
    expect(screen.getByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
  });
});

describe("verify email", () => {
  it("shows the email being verified and the code actions", async () => {
    const user = setup();
    await reachVerify(user, "grace@example.com");

    expect(screen.getByText("grace@example.com")).toBeTruthy();
    expect(input("Verification code")).toBeTruthy();
    expect(button("Verify")).toBeTruthy();
    expect(button("Resend code")).toBeTruthy();
    expect(button("Use a different email")).toBeTruthy();
    expect(button("Back to sign in")).toBeTruthy();
  });

  it.each([
    ["654321", /isn't right/],
    [EXPIRED_CODE, /has expired/],
  ])("shows %s beside the code box", async (code, message) => {
    const user = setup();
    await reachVerify(user);
    await user.type(input("Verification code"), code);
    await user.click(button("Verify"));

    await screen.findByText(message);
    expect(invalid(input("Verification code"))).toBe(true);
    expect(describedBy(input("Verification code"))).toMatch(message);
    expect(document.activeElement).toBe(input("Verification code"));
  });

  it("shows a retry message for a temporary service error, and a later code still works", async () => {
    const user = setup();
    await reachVerify(user);
    await user.type(input("Verification code"), UNAVAILABLE_CODE);
    await user.click(button("Verify"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't verify codes right now/);

    await user.clear(input("Verification code"));
    await user.type(input("Verification code"), DEMO_CODE);
    await user.click(button("Verify"));
    await screen.findByRole("heading", { name: "Email verified" });
  });

  it("refuses an empty or non-numeric code before asking", async () => {
    const user = setup();
    await reachVerify(user);
    await user.click(button("Verify"));
    expect(describedBy(input("Verification code"))).toMatch(/digits only/);

    await user.type(input("Verification code"), "abc");
    await user.click(button("Verify"));
    expect(describedBy(input("Verification code"))).toMatch(/digits only/);
  });

  it("resends: confirms, clears the box, and waits before another resend", async () => {
    const user = setup();
    await reachVerify(user, "ada@example.com");
    await user.type(input("Verification code"), "12");
    await user.click(button("Resend code"));

    const status = await screen.findByText(/We sent a new code to ada@example.com/);
    expect(status.getAttribute("role")).toBe("status");
    expect(input("Verification code").value).toBe("");
    expect(document.activeElement).toBe(input("Verification code"));
    expect((button(/Resend available in/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes back to the form with the email, or to Sign in", async () => {
    const user = setup();
    await reachVerify(user, "ada@example.com");
    await user.click(button("Use a different email"));
    expect(input("Email").value).toBe("ada@example.com");
    expect(input("Password").value).toBe("");

    await user.click(button("Back to sign in"));
    expect(screen.getByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();
  });
});

describe("success and the demo Studio", () => {
  async function reachStudio(user: User) {
    await reachVerify(user);
    await user.type(input("Verification code"), DEMO_CODE);
    await user.click(button("Verify"));
    await user.click(await screen.findByRole("button", { name: "Open Studio (demo)" }));
    await screen.findByRole("heading", { name: /Turn English into/ });
  }

  it("shows the success state, then the Studio in demo mode", async () => {
    const user = setup();
    await reachVerify(user);
    await user.type(input("Verification code"), DEMO_CODE);
    await user.click(button("Verify"));
    expect((await screen.findByRole("status")).textContent).toMatch(/no account or session exists/);

    await user.click(button("Open Studio (demo)"));
    expect(screen.getByLabelText("Demo Studio").textContent).toMatch(
      /20 Generates and 5 YouTube imports per day.*00:00 UTC/,
    );
    expect(screen.getByLabelText("Demo Studio").textContent).toMatch(/not a live counter/);
    const title = screen.getByRole("heading", { name: /Turn English into/ });
    expect(document.activeElement).toBe(title);
    expect(title.textContent).not.toMatch(/null|undefined/);
  });

  it("never sends Generate", async () => {
    const user = setup();
    await reachStudio(user);
    await user.type(screen.getByLabelText("English Transcript"), "Hello world.");
    await user.click(button("Generate audio"));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Generate is turned off/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns to Sign in from the Studio, with a fresh demo", async () => {
    const user = setup();
    await reachStudio(user);
    await user.click(button("Sign out"));
    expect(screen.getByRole("heading", { name: "Sign in to MyDubb" })).toBeTruthy();

    await openCreate(user);
    expect(input("Email").value).toBe("");
  });
});
