import { afterEach, describe, expect, it, vi } from "vitest";

import { authApi } from "./authApi";
import { isAuthStep, isMeResponse } from "./authTypes";
import { ApiError, setCsrfToken } from "./client";
import {
  USER,
  apiError,
  authenticated,
  installAuthFetch,
  json,
  newPasswordRequired,
  noContent,
  verificationRequired,
} from "../test/authFetch.testkit";

afterEach(() => {
  setCsrfToken(null);
  vi.unstubAllGlobals();
});

describe("auth API adapter requests", () => {
  it("sends each call to its endpoint with the documented body", async () => {
    const fake = installAuthFetch({
      "POST /api/auth/login": [() => authenticated()],
      "POST /api/auth/new-password": [() => authenticated()],
      "POST /api/auth/email-verification/send": [noContent],
      "POST /api/auth/email-verification/confirm": [() => authenticated()],
      "POST /api/auth/forgot-password": [noContent],
      "POST /api/auth/reset-password": [noContent],
      "GET /api/auth/me": [() => json(200, { user: USER })],
      "POST /api/auth/logout": [noContent],
    });

    await authApi.login("a@b.co", "pw");
    await authApi.newPassword("c1", "npw");
    await authApi.sendVerificationCode("c2");
    await authApi.confirmVerificationCode("c2", "123456");
    await authApi.forgotPassword("a@b.co");
    await authApi.resetPassword("a@b.co", "654321", "npw");
    await authApi.me();
    await authApi.logout();

    expect(fake.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", "/api/auth/login", { email: "a@b.co", password: "pw" }],
      ["POST", "/api/auth/new-password", { challenge_id: "c1", new_password: "npw" }],
      ["POST", "/api/auth/email-verification/send", { challenge_id: "c2" }],
      ["POST", "/api/auth/email-verification/confirm", { challenge_id: "c2", code: "123456" }],
      ["POST", "/api/auth/forgot-password", { email: "a@b.co" }],
      ["POST", "/api/auth/reset-password", { email: "a@b.co", code: "654321", new_password: "npw" }],
      ["GET", "/api/auth/me", null],
      ["POST", "/api/auth/logout", null],
    ]);
    expect(fake.requests.every((r) => r.credentials === "same-origin")).toBe(true);
  });

  it("sends the CSRF token on state-changing calls once it is known", async () => {
    const fake = installAuthFetch({ "POST /api/auth/logout": [noContent] });
    setCsrfToken("csrf-1");

    await authApi.logout();

    expect(fake.requests[0]?.headers["X-CSRF-Token"]).toBe("csrf-1");
  });

  it("returns the three login states", async () => {
    installAuthFetch({
      "POST /api/auth/login": [authenticated, newPasswordRequired, verificationRequired],
    });

    expect((await authApi.login("a@b.co", "pw")).status).toBe("authenticated");
    expect(await authApi.login("a@b.co", "pw")).toEqual({
      status: "new_password_required",
      challenge_id: "chal-new",
    });
    expect((await authApi.login("a@b.co", "pw")).status).toBe("email_verification_required");
  });

  it("rejects a response that does not match the contract", async () => {
    installAuthFetch({
      "POST /api/auth/login": [() => json(200, { status: "authenticated" })],
      "GET /api/auth/me": [() => json(200, { id: "x" })],
    });

    await expect(authApi.login("a@b.co", "pw")).rejects.toMatchObject({ code: "unexpected_response" });
    await expect(authApi.me()).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces a failed logout instead of pretending it worked", async () => {
    installAuthFetch({ "POST /api/auth/logout": [() => apiError(503, "http_error", "Unavailable.")] });

    await expect(authApi.logout()).rejects.toMatchObject({ status: 503 });
  });
});

describe("response guards", () => {
  it("accepts only the documented shapes", () => {
    expect(isAuthStep({ status: "authenticated", user: USER })).toBe(true);
    expect(isAuthStep({ status: "new_password_required", challenge_id: "c" })).toBe(true);
    expect(isAuthStep({ status: "new_password_required", challenge_id: "" })).toBe(false);
    expect(isAuthStep({ status: "email_verification_required" })).toBe(false);
    expect(isAuthStep({ status: "authenticated", user: { id: "1" } })).toBe(false);
    expect(isAuthStep(null)).toBe(false);
    expect(isMeResponse({ user: USER })).toBe(true);
    expect(isMeResponse({})).toBe(false);
  });
});
