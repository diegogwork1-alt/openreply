import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  prisma: { dmLog: { findFirst: mockFindFirst } },
}));

import {
  clearAccountAgeCache,
  getDailyLimit,
  isAccountRestrictionError,
} from "@/lib/safety/send-guard";
import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockFindFirst.mockReset().mockResolvedValue(null);
  // The age lookup is cached on the send path; tests move the clock around.
  clearAccountAgeCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("isAccountRestrictionError", () => {
  it("treats throttling as an account-level signal", () => {
    expect(isAccountRestrictionError(new RateLimitError("slow down"))).toBe(true);
  });

  it("treats the policy block and the app-level throttles as account-level", () => {
    for (const code of [4, 17, 32, 368, 10, 200]) {
      expect(
        isAccountRestrictionError(new MetaApiError(code, undefined, undefined, "x"))
      ).toBe(true);
    }
  });

  it("does not pause for one recipient who cannot be messaged", () => {
    // 551 is per-person. Pausing every campaign because one follower has DMs
    // closed would be a self-inflicted outage.
    expect(
      isAccountRestrictionError(new MetaApiError(551, undefined, undefined, "x"))
    ).toBe(false);
  });

  it("does not pause for an expired token", () => {
    // Routine: the cron refreshes it. Not a restriction.
    expect(isAccountRestrictionError(new TokenExpiredError("expired"))).toBe(false);
  });

  it("does not pause for an ordinary error", () => {
    expect(isAccountRestrictionError(new Error("socket hang up"))).toBe(false);
    expect(isAccountRestrictionError(undefined)).toBe(false);
  });
});

describe("getDailyLimit", () => {
  it("is off unless configured", async () => {
    delete process.env.DM_DAILY_LIMIT;
    delete process.env.DM_DAILY_LIMIT_RAMP;
    expect(await getDailyLimit("acc_1")).toBe(0);
  });

  it("uses the flat cap when there is no ramp", async () => {
    process.env.DM_DAILY_LIMIT = "50";
    delete process.env.DM_DAILY_LIMIT_RAMP;
    expect(await getDailyLimit("acc_1")).toBe(50);
  });

  it("starts on the first rung before anything has been sent", async () => {
    process.env.DM_DAILY_LIMIT_RAMP = "50,50,50,100,200";
    mockFindFirst.mockResolvedValue(null);
    expect(await getDailyLimit("acc_1")).toBe(50);
  });

  it("climbs the ramp with the account's age in days", async () => {
    process.env.DM_DAILY_LIMIT_RAMP = "50,50,50,100,200";
    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 86_400_000 - 60_000);

    mockFindFirst.mockResolvedValue({ dmSentAt: daysAgo(0) });
    expect(await getDailyLimit("acc_1")).toBe(50);
    clearAccountAgeCache();
    mockFindFirst.mockResolvedValue({ dmSentAt: daysAgo(3) });
    expect(await getDailyLimit("acc_1")).toBe(100);
    clearAccountAgeCache();
    mockFindFirst.mockResolvedValue({ dmSentAt: daysAgo(4) });
    expect(await getDailyLimit("acc_1")).toBe(200);
  });

  it("holds the last rung instead of running off the end", async () => {
    process.env.DM_DAILY_LIMIT_RAMP = "50,100";
    mockFindFirst.mockResolvedValue({
      dmSentAt: new Date(Date.now() - 400 * 86_400_000),
    });
    expect(await getDailyLimit("acc_1")).toBe(100);
  });
});
