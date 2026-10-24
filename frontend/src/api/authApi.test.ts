import { afterEach, describe, expect, it, vi } from "vitest";

import { authApi } from "./authApi";
import { isAuthStep, isCodeSent, isSession } from "./authTypes";
import { ApiError, setCsrfToken } from "./client";
import {
  USER,
  accepted,
  apiError,
  authenticated,
  codeSent,
  installAuthFetch,
  json,
  meResponse,
  newPasswordRequired,
  noContent,
  passwordReset,
  session,
  verificationRequired,
} from "../test/authFetch.testkit";

afterEach(() => {
  setCsrfToken(null);
  vi.unstubAllGlobals();
});

describe("auth API adapter requests", () => {
  it("sends each call to its endpoint with the documented body", async () => {
    const fake = installAuthFetch({
      "POST /api/auth/login": [authenticated()],
      "POST /api/auth/new-password": [authenticated()],
      "POST /api/auth/email-verification/send": [codeSent],
      "POST /api/auth/email-verification/confirm": [authenticated()],
      "POST /api/auth/forgot-password": [accepted],
      "POST /api/auth/reset-password": [passwordReset],
      "GET /api/auth/me": [meResponse()],
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

  it("returns the three sign-in states", async () => {
    installAuthFetch({
      "POST /api/auth/login": [authenticated(), newPasswordRequired, verificationRequired],
    });

    expect((await authApi.login("a@b.co", "pw")).status).toBe("authenticated");
    expect(await authApi.login("a@b.co", "pw")).toMatchObject({
      status: "new_password_required",
      challenge_id: "chal-new",
    });
    expect((await authApi.login("a@b.co", "pw")).status).toBe("email_verification_required");
  });

  it("accepts an account without a display name", async () => {
    installAuthFetch({
      "GET /api/auth/me": [meResponse({ ...USER, display_name: null })],
    });
    expect((await authApi.me()).user.display_name).toBeNull();
  });
});

describe("responses that do not match the contract", () => {
  const unexpected = { code: "unexpected_response" };

  it("rejects a success body with missing or malformed parts", async () => {
    installAuthFetch({
      "POST /api/auth/login": [
        () => json(200, { status: "authenticated", user: USER }), // no csrf_token / expires_at
        () => json(200, { status: "new_password_required", challenge_id: "c" }), // no expiry
        () => json(200, { status: "something_new" }),
        () => json(200, { status: "authenticated", ...session(), csrf_token: "" }),
        () => json(200, { status: "authenticated", ...session(), expires_at: "not a date" }),
      ],
    });

    for (let i = 0; i < 5; i++) {
      await expect(authApi.login("a@b.co", "pw")).rejects.toMatchObject(unexpected);
    }
  });

  it("rejects the wrong success status even with a plausible body", async () => {
    installAuthFetch({
      "POST /api/auth/forgot-password": [() => json(200, { status: "accepted" })], // must be 202
      "POST /api/auth/reset-password": [() => json(202, { status: "password_reset" })], // 200
      "POST /api/auth/email-verification/send": [() => json(202, { status: "code_sent" })],
      "POST /api/auth/logout": [() => json(200, {})], // must be 204
    });

    await expect(authApi.forgotPassword("a@b.co")).rejects.toMatchObject(unexpected);
    await expect(authApi.resetPassword("a@b.co", "1", "p")).rejects.toMatchObject(unexpected);
    await expect(authApi.sendVerificationCode("c")).rejects.toMatchObject(unexpected);
    await expect(authApi.logout()).rejects.toMatchObject(unexpected);
  });

  it("rejects a wrong body for forgot, reset, send and me", async () => {
    installAuthFetch({
      "POST /api/auth/forgot-password": [() => json(202, { status: "queued" })],
      "POST /api/auth/reset-password": [noContent],
      "POST /api/auth/email-verification/send": [() => json(200, { status: "code_sent" })],
      "GET /api/auth/me": [() => json(200, { id: "x" })],
    });

    await expect(authApi.forgotPassword("a@b.co")).rejects.toMatchObject(unexpected);
    await expect(authApi.resetPassword("a@b.co", "1", "p")).rejects.toMatchObject(unexpected);
    await expect(authApi.sendVerificationCode("c")).rejects.toMatchObject(unexpected);
    await expect(authApi.me()).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces a failed logout instead of pretending it worked", async () => {
    installAuthFetch({
      "POST /api/auth/logout": [
        () => apiError(503, "http_error", "Unavailable."),
        () => apiError(403, "csrf_failed", "CSRF validation failed."),
      ],
    });

    await expect(authApi.logout()).rejects.toMatchObject({ status: 503 });
    await expect(authApi.logout()).rejects.toMatchObject({ status: 403, code: "csrf_failed" });
  });
});

describe("response guards", () => {
  it("accepts only the documented shapes", () => {
    expect(isSession(session())).toBe(true);
    expect(isSession({ ...session(), csrf_token: undefined })).toBe(false);
    expect(isAuthStep({ status: "authenticated", ...session() })).toBe(true);
    expect(
      isAuthStep({ status: "email_verification_required", challenge_id: "c", challenge_expires_at: "2030-01-01T00:00:00Z" }),
    ).toBe(true);
    expect(isAuthStep({ status: "email_verification_required", challenge_id: "" })).toBe(false);
    expect(isAuthStep(null)).toBe(false);
    expect(isCodeSent({ status: "code_sent", destination: null, challenge_expires_at: "2030-01-01T00:00:00Z" })).toBe(true);
    expect(isCodeSent({ status: "code_sent", challenge_expires_at: "2030-01-01T00:00:00Z" })).toBe(false);
  });
});
