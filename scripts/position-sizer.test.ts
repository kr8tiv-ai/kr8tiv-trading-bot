import { describe, expect, it } from "vitest";
import { suggestPositionSize } from "./position-sizer.js";

const baseLongPlan = {
  direction: "long" as const,
  entryPrice: 100,
  stopLossPrice: 99, // 1% stop
  riskMode: "sniper" as const,
};

describe("suggestPositionSize", () => {
  it("returns zero size when balance is empty", () => {
    const result = suggestPositionSize({ freeUsdt: 0, plan: baseLongPlan });
    expect(result.marginQuote).toBe(0);
    expect(result.clampedTo).toBe("free-balance");
  });

  it("rejects a plan whose stop is on the wrong side", () => {
    const result = suggestPositionSize({
      freeUsdt: 100,
      plan: { ...baseLongPlan, stopLossPrice: 101 }, // long stop above entry — invalid
    });
    expect(result.marginQuote).toBe(0);
    expect(result.clampedTo).toBe("stop-too-tight");
  });

  it("sizes a sniper trade with a tight stop near liquidation safety bound", () => {
    const result = suggestPositionSize({
      freeUsdt: 100,
      plan: { ...baseLongPlan, stopLossPrice: 99 }, // 1% stop
    });
    // safetyLeverage = floor(0.5 / 0.01) = 50 — within sniper bounds [30,100]
    expect(result.leverage).toBe(50);
    expect(result.maxLossQuote).toBeCloseTo(0.5, 6); // 0.5% of 100
    // notional = 0.5 / 0.01 = 50 USDT; margin = 50 / 50 = 1.00
    expect(result.marginQuote).toBeCloseTo(1, 2);
    expect(result.clampedTo).toBe("exact");
  });

  it("clamps leverage to mode max when stop is very tight", () => {
    // 0.1% stop → safetyLeverage = 500 → clamped to 100x sniper max
    const result = suggestPositionSize({
      freeUsdt: 100,
      plan: { ...baseLongPlan, entryPrice: 1000, stopLossPrice: 999 },
    });
    expect(result.leverage).toBe(100);
    expect(result.clampedTo).toBe("mode-max");
  });

  it("falls back to mode min when stop is too wide for sniper bounds", () => {
    // sniper min is 30 — safetyLeverage = floor(0.5/0.05) = 10 < 30
    const result = suggestPositionSize({
      freeUsdt: 100,
      plan: { ...baseLongPlan, entryPrice: 100, stopLossPrice: 95 }, // 5% stop
    });
    expect(result.leverage).toBe(30);
    expect(result.clampedTo).toBe("stop-too-tight");
  });

  it("respects core mode upper bound of 30x", () => {
    const result = suggestPositionSize({
      freeUsdt: 100,
      plan: { ...baseLongPlan, riskMode: "core", stopLossPrice: 99.5 }, // 0.5% stop → safety=100
    });
    expect(result.leverage).toBeLessThanOrEqual(30);
  });

  it("caps margin at 50% of free balance", () => {
    // Set up a scenario where target notional would push margin above the cap.
    const result = suggestPositionSize({
      freeUsdt: 100,
      riskOfAccountPct: 0.5, // wildly aggressive — 50% of account
      plan: { ...baseLongPlan, stopLossPrice: 99 }, // 1% stop
    });
    expect(result.marginQuote).toBeLessThanOrEqual(50);
    expect(result.clampedTo).toBe("free-balance");
  });

  it("works for short trades", () => {
    const result = suggestPositionSize({
      freeUsdt: 100,
      plan: {
        direction: "short",
        entryPrice: 100,
        stopLossPrice: 101, // 1% stop above entry
        riskMode: "sniper",
      },
    });
    expect(result.leverage).toBeGreaterThanOrEqual(30);
    expect(result.marginQuote).toBeGreaterThan(0);
  });

  it("includes a rationale array explaining the math", () => {
    const result = suggestPositionSize({
      freeUsdt: 100,
      plan: { ...baseLongPlan, stopLossPrice: 99 },
    });
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.rationale.join(" ")).toMatch(/0\.50%/);
  });
});
