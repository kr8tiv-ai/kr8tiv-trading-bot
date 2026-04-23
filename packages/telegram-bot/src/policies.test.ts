import { describe, expect, it } from "vitest";
import {
  computePriceDriftBps,
  evaluateApprovalPress,
  evaluateSignalSuppression,
  isApprovalExpired,
  isWhitelistedChat,
} from "./policies.js";

describe("telegram approval policies", () => {
  it("matches only the configured chat id", () => {
    expect(isWhitelistedChat(123, "123")).toBe(true);
    expect(isWhitelistedChat("123", "123")).toBe(true);
    expect(isWhitelistedChat(undefined, "123")).toBe(false);
    expect(isWhitelistedChat(456, "123")).toBe(false);
  });

  it("suppresses cards once the daily cap is reached", () => {
    expect(
      evaluateSignalSuppression({
        todaysSignalCount: 5,
        dailySignalCap: 5,
        nowMs: 1_000,
        rejectCooldownMs: 1_800_000,
      }),
    ).toEqual({ allowed: false, reason: "DAILY_CAP_REACHED" });
  });

  it("suppresses cards during the same-pair reject cooldown", () => {
    expect(
      evaluateSignalSuppression({
        todaysSignalCount: 2,
        dailySignalCap: 5,
        lastRejectedAtMs: 5_000,
        nowMs: 10_000,
        rejectCooldownMs: 30_000,
      }),
    ).toEqual({
      allowed: false,
      reason: "PAIR_COOLDOWN_ACTIVE",
      retryAtMs: 35_000,
    });
  });

  it("allows cards when below cap and outside cooldown", () => {
    expect(
      evaluateSignalSuppression({
        todaysSignalCount: 2,
        dailySignalCap: 5,
        lastRejectedAtMs: 5_000,
        nowMs: 40_000,
        rejectCooldownMs: 30_000,
      }),
    ).toEqual({ allowed: true });
  });

  it("detects expired approvals", () => {
    expect(isApprovalExpired(10_000, 10_000)).toBe(true);
    expect(isApprovalExpired(10_000, 9_999)).toBe(false);
  });

  it("computes signed price drift in basis points", () => {
    expect(computePriceDriftBps(100, 100.3)).toBeCloseTo(30, 8);
    expect(computePriceDriftBps(100, 99.7)).toBeCloseTo(-30, 8);
  });

  it("expires an approval press when drift exceeds 0.3%", () => {
    expect(
      evaluateApprovalPress({
        entryPrice: 100,
        currentPrice: 100.31,
        expiresAtMs: 20_000,
        nowMs: 10_000,
        maxPriceDriftBps: 30,
      }),
    ).toEqual({
      allowed: false,
      reason: "PRICE_DRIFT_EXCEEDED",
      driftBps: 31,
    });
  });

  it("expires an approval press when ttl has elapsed", () => {
    expect(
      evaluateApprovalPress({
        entryPrice: 100,
        currentPrice: 100,
        expiresAtMs: 20_000,
        nowMs: 20_001,
        maxPriceDriftBps: 30,
      }),
    ).toEqual({ allowed: false, reason: "EXPIRED", driftBps: 0 });
  });
});
