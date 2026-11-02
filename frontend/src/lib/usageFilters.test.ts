import { describe, expect, it } from "vitest";

import {
  buildAddress,
  fromFieldValue,
  parseAddress,
  resolveFilters,
  toFieldValue,
  validateDraft,
} from "./usageFilters";
import { formatBytes, formatMoney, formatUtc } from "./usageFormat";

const NOW = Date.parse("2026-11-01T10:30:20Z");

describe("the filters in the address", () => {
  it("round-trips, including an offset that must stay encoded", () => {
    const search = buildAddress({
      since: "2026-10-01T00:00:00+07:00",
      until: "2026-10-02T00:00:00Z",
      language: "japanese",
      jobId: "11111111-1111-4111-8111-111111111111",
      detail: "22222222-2222-4222-8222-222222222222",
    });
    expect(search).toContain("%2B07%3A00");
    expect(parseAddress(search)).toEqual({
      since: "2026-10-01T00:00:00+07:00",
      until: "2026-10-02T00:00:00Z",
      language: "japanese",
      jobId: "11111111-1111-4111-8111-111111111111",
      detail: "22222222-2222-4222-8222-222222222222",
    });
    expect(buildAddress({})).toBe("");
  });

  it("defaults to the last seven days, up to the end of this minute", () => {
    expect(resolveFilters({}, NOW)).toMatchObject({
      since: "2026-10-25T10:31:00Z",
      until: "2026-11-01T10:31:00Z",
    });
  });

  it("uses what the address gives and passes on what the server must refuse", () => {
    const given = { since: "2026-10-01", until: "2026-10-02" };
    expect(resolveFilters(given, NOW)).toMatchObject(given);
    expect(resolveFilters({ until: "2026-10-08T00:00:00Z" }, NOW).since).toBe(
      "2026-10-01T00:00:00Z",
    );
    expect(resolveFilters({ since: "nonsense" }, NOW).since).toBe("nonsense");
    expect(resolveFilters({ until: "nonsense" }, NOW).until).toBe("nonsense");
  });
});

describe("the time fields hold UTC", () => {
  it("reads no zone as UTC and converts an offset", () => {
    expect(toFieldValue("2026-10-01")).toBe("2026-10-01T00:00:00");
    expect(toFieldValue("2026-10-01T08:30")).toBe("2026-10-01T08:30:00");
    expect(toFieldValue("2026-10-01T08:30:15Z")).toBe("2026-10-01T08:30:15");
    expect(toFieldValue("2026-10-01T08:30:00+07:00")).toBe("2026-10-01T01:30:00");
    expect(toFieldValue("nonsense")).toBe("");
  });

  it("sends what the field holds as UTC, without converting to local time", () => {
    expect(fromFieldValue("2026-10-01T08:30")).toBe("2026-10-01T08:30:00Z");
    expect(fromFieldValue("2026-10-01T08:30:15")).toBe("2026-10-01T08:30:15Z");
    expect(fromFieldValue("")).toBe("");
  });
});

describe("validating before asking", () => {
  const draft = {
    since: "2026-10-01T00:00:00",
    until: "2026-10-08T00:00:00",
    language: "",
    jobId: "",
  };

  it("accepts up to 31 days and refuses more", () => {
    expect(validateDraft(draft)).toEqual({});
    expect(validateDraft({ ...draft, until: "2026-11-01T00:00:00" })).toEqual({});
    expect(validateDraft({ ...draft, until: "2026-11-01T00:00:01" }).until).toMatch(/31 days/);
  });

  it("refuses a missing or reversed period and a partial job id", () => {
    expect(validateDraft({ ...draft, since: "" }).since).toBeTruthy();
    expect(validateDraft({ ...draft, until: "" }).until).toBeTruthy();
    expect(validateDraft({ ...draft, until: draft.since }).since).toMatch(/earlier/);
    expect(validateDraft({ ...draft, jobId: "abc" }).jobId).toBeTruthy();
    expect(
      validateDraft({ ...draft, jobId: " 11111111-1111-4111-8111-111111111111 " }).jobId,
    ).toBeUndefined();
  });
});

describe("display only", () => {
  it("rounds money half up on the digits, like the command-line report", () => {
    expect(formatMoney("0.000075")).toBe("0.0001");
    expect(formatMoney("0.00004")).toBe("0.0000");
    expect(formatMoney("3.33333")).toBe("3.3333");
    expect(formatMoney("3.333405")).toBe("3.3334");
    expect(formatMoney("0.99995")).toBe("1.0000");
    expect(formatMoney("1234567.5")).toBe("1,234,567.5000");
    expect(formatMoney("0")).toBe("0.0000");
    // A float would lose this.
    expect(formatMoney("90071992547409.93125")).toBe("90,071,992,547,409.9313");
    expect(formatMoney("odd")).toBe("odd");
  });

  it("shows UTC times and sizes", () => {
    expect(formatUtc("2026-10-10T12:00:00.123456Z")).toBe("2026-10-10 12:00:00 UTC");
    expect(formatUtc("2026-10-10T19:00:00+07:00")).toBe("2026-10-10 12:00:00 UTC");
    expect(formatBytes(1000)).toBe("1,000 bytes");
    expect(formatBytes(480_000)).toBe("469 KB");
    expect(formatBytes(1_500_000)).toBe("1.43 MB");
  });
});
