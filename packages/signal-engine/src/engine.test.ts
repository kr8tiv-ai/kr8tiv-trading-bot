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
});

