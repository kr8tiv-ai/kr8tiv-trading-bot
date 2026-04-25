import { describe, expect, it } from "vitest";
import type { MarketCandle } from "@kr8tiv/shared-schemas";
import {
  backtestAdaptiveGrid,
  backtestBreakoutTrailing,
  backtestEmaPullback,
  compareBacktestStrategies,
} from "./backtest.js";

function candle(index: number, close: number, volume = 1000): MarketCandle {
  return {
    openTimeMs: 1_700_000_000_000 + index * 900_000,
    closeTimeMs: 1_700_000_900_000 + index * 900_000,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume,
    quoteVolume: close * volume,
  };
}

describe("backtestBreakoutTrailing", () => {
  it("captures a long breakout with a trailing-stop exit", () => {
    const candles = [
      ...Array.from({ length: 25 }, (_, i) => candle(i, 100 + (i % 3) * 0.1)),
      candle(25, 104, 1800),
      candle(26, 108, 1800),
      candle(27, 112, 1800),
      candle(28, 110, 1500),
      candle(29, 106, 1500),
    ];

    const result = backtestBreakoutTrailing(candles, {
      lookback: 20,
      riskMultipleTarget: 2,
      feeRate: 0,
    });

    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]).toMatchObject({
      direction: "long",
      entryPrice: 104,
    });
    expect(result.netPnlPct).toBeGreaterThan(0);
    expect(result.winRate).toBeGreaterThan(0);
  });

  it("fails closed when there is not enough candle history", () => {
    const result = backtestBreakoutTrailing([candle(0, 100)], {});

    expect(result.trades).toEqual([]);
    expect(result.warnings).toContain("not enough candles for breakout backtest");
  });
});

describe("backtestAdaptiveGrid", () => {
  it("captures repeatable futures grid profits in range-bound chop", () => {
    const candles = Array.from({ length: 80 }, (_, i) => {
      const close = i % 2 === 0 ? 99.2 : 100.8;
      return candle(i, close, 1400);
    });

    const result = backtestAdaptiveGrid(candles, {
      lookback: 20,
      gridSpacingPct: 0.006,
      feeRate: 0,
    });

    expect(result.strategy).toBe("adaptive-grid");
    expect(result.trades.length).toBeGreaterThan(4);
    expect(result.netPnlPct).toBeGreaterThan(0);
    expect(result.warnings).not.toContain("not enough candles for grid backtest");
  });

  it("ranks grid above breakout when the replay is range-bound", () => {
    const candles = Array.from({ length: 100 }, (_, i) => {
      const close = 100 + Math.sin(i / 2) * 1.2;
      return candle(i, close, 1200);
    });

    const comparison = compareBacktestStrategies(candles, {
      lookback: 20,
      feeRate: 0,
    });

    expect(comparison.results.map((item) => item.strategy)).toContain(
      "breakout-trailing",
    );
    expect(comparison.results.map((item) => item.strategy)).toContain(
      "adaptive-grid",
    );
    expect(comparison.best?.strategy).toBe("adaptive-grid");
    expect(comparison.recommendation).toContain("range");
  });

  it("does not force a winning strategy when every replay is non-positive", () => {
    const candles = Array.from({ length: 100 }, (_, i) => ({
      ...candle(i, 100, 900),
      high: 100.02,
      low: 99.98,
    }));

    const comparison = compareBacktestStrategies(candles, {
      lookback: 20,
      feeRate: 0.0006,
    });

    expect(comparison.best).toBeNull();
    expect(comparison.recommendation).toContain("No strategy edge");
  });
});

describe("backtestEmaPullback", () => {
  it("captures a medium-risk trend pullback reclaim", () => {
    const candles = [
      ...Array.from({ length: 70 }, (_, i) => candle(i, 100 + i * 0.8, 1500)),
      {
        ...candle(70, 153, 2200),
        open: 150,
        high: 154,
        low: 147,
      },
      candle(71, 157, 2200),
      candle(72, 161, 2200),
      candle(73, 164, 2200),
    ];

    const result = backtestEmaPullback(candles, {
      feeRate: 0,
      riskMultipleTarget: 1.6,
    });

    expect(result.strategy).toBe("ema-pullback");
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]?.direction).toBe("long");
    expect(result.netPnlPct).toBeGreaterThan(0);
  });

  it("includes ema-pullback in strategy comparison", () => {
    const candles = [
      ...Array.from({ length: 70 }, (_, i) => candle(i, 200 - i * 0.6, 1500)),
      {
        ...candle(70, 161, 2200),
        open: 164,
        high: 168,
        low: 160,
      },
      candle(71, 156, 2200),
      candle(72, 152, 2200),
      candle(73, 149, 2200),
    ];

    const comparison = compareBacktestStrategies(candles, {
      feeRate: 0,
      riskMultipleTarget: 1.6,
    });

    expect(comparison.results.map((item) => item.strategy)).toContain(
      "ema-pullback",
    );
  });
});
