import { describe, expect, it } from "vitest";
import type { MarketCandle } from "@kr8tiv/shared-schemas";
import { buildAdaptiveGridPlan } from "./grid.js";

function candle(index: number, close: number): MarketCandle {
  return {
    openTimeMs: 1_700_000_000_000 + index * 900_000,
    closeTimeMs: 1_700_000_900_000 + index * 900_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
    quoteVolume: close * 1000,
  };
}

describe("buildAdaptiveGridPlan", () => {
  it("builds a balanced futures grid with long levels below and short levels above", () => {
    const candles = Array.from({ length: 100 }, (_, i) =>
      candle(i, 100 + Math.sin(i / 3) * 4),
    );

    const plan = buildAdaptiveGridPlan({
      symbol: "BTCUSDT",
      candles,
      capitalQuote: 300,
      leverage: 20,
      gridCount: 6,
    });

    expect(plan.symbol).toBe("BTCUSDT");
    expect(plan.levels).toHaveLength(6);
    expect(plan.levels.some((level) => level.side === "long")).toBe(true);
    expect(plan.levels.some((level) => level.side === "short")).toBe(true);
    expect(plan.levels.every((level) => level.marginQuote > 0)).toBe(true);
    expect(plan.levels.every((level) => level.notionalQuote > level.marginQuote)).toBe(
      true,
    );
  });

  it("warns instead of pretending a compressed range is tradable", () => {
    const candles = Array.from({ length: 100 }, (_, i) => ({
      ...candle(i, 100),
      high: 100.05,
      low: 99.95,
    }));

    const plan = buildAdaptiveGridPlan({
      symbol: "SOLUSDT",
      candles,
      capitalQuote: 100,
      leverage: 30,
    });

    expect(plan.levels).toHaveLength(0);
    expect(plan.warnings).toContain("range is too compressed for a clean grid");
  });
});
