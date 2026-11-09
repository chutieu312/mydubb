import { describe, expect, it } from "vitest";

import {
  BUSY_EMAIL,
  DEMO_CODE,
  EXPIRED_CODE,
  UNAVAILABLE_CODE,
  createMockSignup,
  validateCreate,
} from "./mockSignup";

describe("mock sign-up outcomes", () => {
  it("decides verification only by the code", async () => {
    const service = createMockSignup(0);
    expect(await service.verify(DEMO_CODE)).toBe("verified");
    expect(await service.verify(EXPIRED_CODE)).toBe("expired");
    expect(await service.verify(UNAVAILABLE_CODE)).toBe("unavailable");
    expect(await service.verify("654321")).toBe("wrong");
  });

  it("fails the busy address once, then works, until reset", async () => {
    const service = createMockSignup(0);
    expect(await service.createAccount(BUSY_EMAIL)).toBe("unavailable");
    expect(await service.createAccount(` ${BUSY_EMAIL.toUpperCase()} `)).toBe("created");
    service.reset();
    expect(await service.createAccount(BUSY_EMAIL)).toBe("unavailable");
  });

  it("creates any other address", async () => {
    expect(await createMockSignup(0).createAccount("ada@example.com")).toBe("created");
  });
});

describe("create account validation", () => {
  it("reports every missing part at once", () => {
    expect(validateCreate("", "", false)).toEqual({
      email: "Enter your email address.",
      password: "Enter a password.",
      captcha: "Confirm you are not a robot to continue.",
    });
  });

  it("refuses a malformed email and a short password", () => {
    expect(validateCreate("ada@", "short", true)).toEqual({
      email: "Enter a valid email address, like name@example.com.",
      password: "Use at least 8 characters.",
    });
  });

  it("accepts a valid form", () => {
    expect(validateCreate(" ada@example.com ", "long-enough", true)).toEqual({});
  });
});
