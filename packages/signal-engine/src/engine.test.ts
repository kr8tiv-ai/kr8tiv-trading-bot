import { describe, expect, it } from "vitest";
import type { MarketCandle } from "@kr8tiv/shared-schemas";
import { analyzeMarket } from "./engine.js";

function makeTrendCandles(
  base: number,
  step: number,
  count: number,
  volumeBase: number,
): MarketCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = base + step * i;
    const open = close - step * 0.4;
    return {
      openTimeMs: 1_700_000_000_000 + i * 900_000,
      closeTimeMs: 1_700_000_900_000 + i * 900_000,
      open,
      high: close + Math.abs(step) * 1.2 + 2,
      low: open - Math.abs(step) * 1.2 - 2,
      close,
      volume: volumeBase + i * 10,
      quoteVolume: (volumeBase + i * 10) * close,
    };
  });
}

function makeRangeCandles(
  base: number,
  count: number,
  lastClose: number,
): MarketCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const wave = Math.sin(i / 2) * 1.4;
    const close = i === count - 1 ? lastClose : base + wave;
    return {
      openTimeMs: 1_700_000_000_000 + i * 900_000,
      closeTimeMs: 1_700_000_900_000 + i * 900_000,
      open: close,
      high: close + 0.7,
      low: close - 0.7,
      close,
      volume: 2_000 + (i % 5) * 50,
      quoteVolume: close * (2_000 + (i % 5) * 50),
    };
  });
}

describe("analyzeMarket", () => {
  it("emits a bullish scalp and swing idea when short- and long-term structure align", () => {
    const shortTerm = makeTrendCandles(100, 2.2, 80, 2000);
    const longTerm = makeTrendCandles(80, 4.5, 80, 8000);
    const scan = analyzeMarket({
      symbol: "BTCUSDT",
      market: "mexc-futures",
      shortTimeframe: "15m",
      longTimeframe: "4h",
      shortCandles: shortTerm,
      longCandles: longTerm,
    });

    expect(scan.regime).toBe("bullish");
    expect(scan.ideas.some((idea) => idea.direction === "long")).toBe(true);
    expect(scan.ideas.some((idea) => idea.horizon === "scalp")).toBe(true);
    expect(scan.ideas.some((idea) => idea.horizon === "swing")).toBe(true);
  });

  it("emits a bearish short setup when both timeframes trend down", () => {
    const shortTerm = makeTrendCandles(250, -2.5, 80, 2500);
    const longTerm = makeTrendCandles(320, -3.5, 80, 9000);
    const scan = analyzeMarket({
      symbol: "SOLUSDT",
      market: "mexc-futures",
      shortTimeframe: "15m",
      longTimeframe: "4h",
      shortCandles: shortTerm,
      longCandles: longTerm,
    });

    expect(scan.regime).toBe("bearish");
    expect(scan.ideas.some((idea) => idea.direction === "short")).toBe(true);
  });

  it("fails closed with warnings when there is not enough candle history", () => {
    const shortTerm = makeTrendCandles(100, 1, 10, 2000);
    const longTerm = makeTrendCandles(100, 1, 10, 8000);
    const scan = analyzeMarket({
      symbol: "ETHUSDT",
      market: "mexc-futures",
      shortTimeframe: "15m",
      longTimeframe: "4h",
      shortCandles: shortTerm,
      longCandles: longTerm,
    });

    expect(scan.ideas).toHaveLength(0);
    expect(scan.warnings.length).toBeGreaterThan(0);
  });

  it("adds a futures context signal from funding, basis, volume, and holdVol", () => {
    const shortTerm = makeTrendCandles(100, 1.2, 80, 2000);
    const longTerm = makeTrendCandles(80, 2.5, 80, 8000);
    const scan = analyzeMarket({
      symbol: "BTCUSDT",
      market: "mexc-futures",
      shortTimeframe: "15m",
      longTimeframe: "4h",
      shortCandles: shortTerm,
      longCandles: longTerm,
      marketContext: {
        symbol: "BTCUSDT",
        lastPrice: 100,
        indexPrice: 99.8,
        fairPrice: 100.1,
        basisPct: 0.003,
        fundingRate: 0.0007,
        nextSettleTime: 1_700_028_800_000,
        collectCycleHours: 8,
        volume24: 100_000,
        amount24: 600_000_000,
        holdVol: 50_000_000,
        riseFallRate: 0.02,
        high24Price: 105,
        low24Price: 95,
        timestamp: 1_700_000_000_000,
      },
    });

    const contextSignal = scan.strategies.find(
      (signal) => signal.strategy === "futures-context",
    );
    expect(contextSignal).toMatchObject({
      bias: "short",
      metrics: {
        fundingRate: 0.0007,
        basisPct: 0.003,
        amount24: 600_000_000,
      },
    });
  });

  it("emits a medium-risk adaptive-grid scalp idea near the lower range band", () => {
    const shortTerm = makeRangeCandles(100, 90, 98.6);
    const longTerm = makeRangeCandles(100, 90, 100.1);
    const scan = analyzeMarket({
      symbol: "ETHUSDT",
      market: "mexc-futures",
      shortTimeframe: "15m",
      longTimeframe: "4h",
      shortCandles: shortTerm,
      longCandles: longTerm,
    });

    const gridSignal = scan.strategies.find(
      (signal) => signal.strategy === "adaptive-grid",
    );
    expect(gridSignal).toMatchObject({
      bias: "long",
      timeframe: "15m",
    });
    expect(gridSignal?.metrics?.lowerGrid).toBeLessThan(scan.currentPrice);
    expect(scan.ideas.some((idea) => idea.direction === "long")).toBe(true);
    expect(
      scan.ideas
        .flatMap((idea) => idea.strategies)
        .some((signal) => signal.strategy === "adaptive-grid"),
    ).toBe(true);
  });

  it("adds an EMA pullback medium signal when price reclaims trend support", () => {
    const shortTerm = [
      ...makeTrendCandles(100, 0.8, 80, 2000),
      {
        ...makeTrendCandles(164, 0.1, 1, 2600)[0]!,
        open: 158,
        high: 165,
        low: 153,
        close: 163,
      },
    ];
    const longTerm = makeTrendCandles(80, 2.2, 90, 8000);
    const scan = analyzeMarket({
      symbol: "BTCUSDT",
      market: "mexc-futures",
      shortTimeframe: "15m",
      longTimeframe: "4h",
      shortCandles: shortTerm,
      longCandles: longTerm,
    });

    const pullback = scan.strategies.find(
      (signal) => signal.strategy === "ema-pullback",
    );
    expect(pullback).toMatchObject({
      bias: "long",
      timeframe: "15m",
    });
    expect(pullback?.summary).toContain("medium");
  });
});
