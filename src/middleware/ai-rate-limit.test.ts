import { describe, expect, it } from "vitest";

import { evaluateRateLimit, startOfUtcDay } from "./ai-rate-limit.js";

const LIMITS = { global: 500, perUser: 50 };

describe("evaluateRateLimit", () => {
  it("allows a user below both limits", () => {
    expect(evaluateRateLimit(0, 0, LIMITS)).toEqual({ isAllowed: true });
    expect(evaluateRateLimit(49, 499, LIMITS)).toEqual({ isAllowed: true });
  });

  it("blocks exactly at the per-user limit", () => {
    // "At the limit" is already spent: 50 messages sent means the 51st is refused.
    expect(evaluateRateLimit(50, 100, LIMITS)).toEqual({ isAllowed: false, reason: "user" });
  });

  it("blocks exactly at the global limit", () => {
    expect(evaluateRateLimit(1, 500, LIMITS)).toEqual({ isAllowed: false, reason: "global" });
  });

  it("reports the user limit first when both are exceeded", () => {
    // The user-facing message differs, and "you are over your limit" is more
    // actionable than "the whole app is over its limit".
    expect(evaluateRateLimit(50, 500, LIMITS)).toEqual({ isAllowed: false, reason: "user" });
  });

  it("handles a limit of one", () => {
    const limits = { global: 10, perUser: 1 };

    expect(evaluateRateLimit(0, 0, limits)).toEqual({ isAllowed: true });
    expect(evaluateRateLimit(1, 0, limits)).toEqual({ isAllowed: false, reason: "user" });
  });
});

describe("startOfUtcDay", () => {
  it("truncates to midnight UTC", () => {
    const result = startOfUtcDay(new Date("2026-11-05T13:47:22.123Z"));

    expect(result.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("does not roll back a day for a late-evening UTC time", () => {
    const result = startOfUtcDay(new Date("2026-11-05T23:59:59.999Z"));

    expect(result.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("uses UTC rather than local time", () => {
    // Jakarta is UTC+7, so 06:00 local on the 6th is still 23:00 UTC on the 5th.
    // The quota window must not shift with the server's timezone.
    const result = startOfUtcDay(new Date("2026-11-05T23:00:00.000Z"));

    expect(result.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });
});
