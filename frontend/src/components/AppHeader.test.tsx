import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppHeader } from "./AppHeader";

afterEach(cleanup);

const base = { theme: "light" as const, onToggleTheme: vi.fn(), loggingOut: false, onLogout: vi.fn() };

describe("AppHeader account", () => {
  it("shows the display name and offers Sign out for an email + password user", () => {
    render(<AppHeader {...base} signedIn user={{ email: "ada@example.com", display_name: "Ada" }} />);

    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Signed in as")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("falls back to the email when the display name is blank or null", () => {
    render(<AppHeader {...base} signedIn user={{ email: "ada@example.com", display_name: " " }} />);
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    cleanup();
    render(<AppHeader {...base} signedIn user={{ email: "bao@example.com", display_name: null }} />);
    expect(screen.getByText("bao@example.com")).toBeTruthy();
  });

  it("keeps a very long email inside the header", () => {
    const long = `${"a".repeat(60)}@${"b".repeat(60)}.example.com`;
    render(<AppHeader {...base} signedIn user={{ email: long, display_name: null }} />);
    expect(screen.getByText(long).closest(".account")).toBeTruthy();
  });

  it("shows Signing out while pending", () => {
    render(<AppHeader {...base} signedIn loggingOut user={{ email: "a@b.co", display_name: "A" }} />);
    expect(screen.getByRole("button", { name: "Signing out…" })).toHaveProperty("disabled", true);
  });

  it("keeps the Access Code header unchanged", () => {
    render(<AppHeader {...base} signedIn />);
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
  });

  it("shows no account controls when signed out", () => {
    render(<AppHeader {...base} signedIn={false} />);
    expect(screen.queryByRole("button", { name: /log out|sign out/i })).toBeNull();
  });
});
