import { describe, expect, it } from "vitest";
import { atr, ema, macd, rsi } from "./indicators.js";

describe("signal-engine indicators", () => {
  it("ema slopes upward on a persistent uptrend", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    const values = ema(closes, 9);
    expect(values.at(-1)).toBeGreaterThan(values.at(-2) ?? 0);
  });

  it("rsi becomes elevated on a strong uptrend", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    const values = rsi(closes, 14);
    expect(values.at(-1)).toBeGreaterThan(60);
  });

  it("macd histogram turns positive on accelerating upside momentum", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 1.5);
    const result = macd(closes);
    expect(result.histogram.at(-1)).toBeGreaterThan(0);
  });

  it("atr stays positive for valid candles", () => {
    const candles = Array.from({ length: 30 }, (_, i) => ({
      openTimeMs: 1_700_000_000_000 + i * 60_000,
      closeTimeMs: 1_700_000_060_000 + i * 60_000,
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 101 + i,
      volume: 1000 + i * 10,
    }));
    const values = atr(candles, 14);
    expect(values.at(-1)).toBeGreaterThan(0);
  });
});

