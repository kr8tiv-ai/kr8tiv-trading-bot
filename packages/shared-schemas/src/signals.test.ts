import { describe, expect, it } from "vitest";
import {
  MarketCandleSchema,
  MarketScanSchema,
  StrategySignalSchema,
  TradeIdeaSchema,
} from "./signals.js";

describe("MarketCandleSchema", () => {
  it("parses a valid candle", () => {
    const parsed = MarketCandleSchema.parse({
      openTimeMs: 1_700_000_000_000,
      closeTimeMs: 1_700_000_900_000,
      open: 100,
      high: 105,
      low: 98,
      close: 104,
      volume: 12_345,
      quoteVolume: 1_280_000,
    });
    expect(parsed.high).toBe(105);
    expect(parsed.close).toBe(104);
  });

  it("rejects impossible high/low ranges", () => {
    expect(() =>
      MarketCandleSchema.parse({
        openTimeMs: 1_700_000_000_000,
        closeTimeMs: 1_700_000_900_000,
        open: 100,
        high: 95,
        low: 98,
        close: 99,
        volume: 12_345,
      }),
    ).toThrow();
  });
});

describe("StrategySignalSchema", () => {
  it("parses a long RSI divergence reading", () => {
    const parsed = StrategySignalSchema.parse({
      strategy: "rsi-divergence",
      timeframe: "15m",
      bias: "long",
      confidence: 0.74,
      summary: "price made a lower low while RSI held a higher low",
      metrics: {
        rsi: 31.2,
      },
    });
    expect(parsed.metrics?.rsi).toBe(31.2);
  });
});

describe("TradeIdeaSchema", () => {
  it("requires at least one target", () => {
    expect(() =>
      TradeIdeaSchema.parse({
        symbol: "BTCUSDT",
        market: "mexc-futures",
        direction: "long",
        horizon: "scalp",
        confidence: 0.81,
        entryPrice: 80000,
        invalidationPrice: 79450,
        targets: [],
        thesis: "bullish breakout with higher-timeframe support",
        reasons: ["MACD bullish cross"],
        strategies: [],
      }),
    ).toThrow();
  });
});

describe("MarketScanSchema", () => {
  it("parses a complete scan with two trade ideas", () => {
    const parsed = MarketScanSchema.parse({
      symbol: "ETHUSDT",
      market: "mexc-futures",
      currentPrice: 3850,
      regime: "bullish",
      warnings: [],
      strategies: [
        {
          strategy: "macd-crossover",
          timeframe: "15m",
          bias: "long",
          confidence: 0.68,
          summary: "histogram flipped positive",
        },
      ],
      ideas: [
        {
          symbol: "ETHUSDT",
          market: "mexc-futures",
          direction: "long",
          horizon: "scalp",
          confidence: 0.72,
          entryPrice: 3850,
          invalidationPrice: 3815,
          targets: [3885, 3910],
          thesis: "short-term momentum turned back up",
          reasons: ["bullish MACD cross", "trend remains up"],
          strategies: [],
        },
      ],
    });
    expect(parsed.regime).toBe("bullish");
    expect(parsed.ideas).toHaveLength(1);
  });
});

