import { describe, expect, it } from "vitest";

import { DEFAULT_PASSWORD_POLICY, describePolicy, unmetRules, type PasswordPolicy } from "./passwordPolicy";

describe("password policy hints", () => {
  it("lists the requirements in order", () => {
    expect(describePolicy(DEFAULT_PASSWORD_POLICY)).toEqual([
      "At least 8 characters",
      "A lowercase letter",
      "An uppercase letter",
      "A number",
    ]);
  });

  it("reports what is still missing", () => {
    expect(unmetRules(DEFAULT_PASSWORD_POLICY, "")).toHaveLength(4);
    expect(unmetRules(DEFAULT_PASSWORD_POLICY, "abcdefgh")).toEqual([
      "An uppercase letter",
      "A number",
    ]);
    expect(unmetRules(DEFAULT_PASSWORD_POLICY, "Abcdefg1")).toEqual([]);
  });

  it("follows a policy it is given, including symbols", () => {
    const policy: PasswordPolicy = {
      minLength: 12,
      requireLower: false,
      requireUpper: false,
      requireNumber: false,
      requireSymbol: true,
    };
    expect(unmetRules(policy, "abcdefghijkl")).toEqual(["A symbol"]);
    expect(unmetRules(policy, "abcdefghijk!")).toEqual([]);
  });

  it("counts characters, not UTF-16 units", () => {
    const policy = { ...DEFAULT_PASSWORD_POLICY, minLength: 3, requireLower: false, requireUpper: false, requireNumber: false };
    expect(unmetRules(policy, "😀😀")).toHaveLength(1);
    expect(unmetRules(policy, "😀😀😀")).toEqual([]);
  });
});
