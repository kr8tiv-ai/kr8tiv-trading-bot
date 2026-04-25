import { describe, expect, it } from "vitest";
import type { MarketScan, TradeIdea } from "@kr8tiv/shared-schemas";
import {
  buildTradePlanFromIdea,
  buildTradePlansFromScan,
  chooseRiskMode,
  suggestLeverage,
} from "./model.js";

function idea(overrides: Partial<TradeIdea> = {}): TradeIdea {
  return {
    symbol: "BTCUSDT",
    market: "mexc-futures",
    direction: "long",
    horizon: "scalp",
    confidence: 0.86,
    entryPrice: 93500,
    invalidationPrice: 93140,
    targets: [94400, 95300],
    thesis:
      "scalp long bias: price reclaimed the 20 EMA; MACD histogram remains positive",
    reasons: ["trend and momentum are aligned"],
    strategies: [],
    ...overrides,
  };
}

function scan(ideas: TradeIdea[]): MarketScan {
  return {
    symbol: "BTCUSDT",
    market: "mexc-futures",
    currentPrice: 93500,
    regime: "bullish",
    warnings: [],
    strategies: [],
    ideas,
  };
}

describe("futures trade model bridge", () => {
  it("defaults lower-confidence scalps to medium, strong scalps to sniper, and swings to core", () => {
    expect(chooseRiskMode(idea({ horizon: "scalp", confidence: 0.68 }))).toBe("medium");
    expect(chooseRiskMode(idea({ horizon: "scalp", confidence: 0.86 }))).toBe("sniper");
    expect(chooseRiskMode(idea({ horizon: "swing" }))).toBe("core");
  });

  it("keeps sniper, medium, and core leverage inside their accountability bands", () => {
    expect(suggestLeverage(idea({ confidence: 0.95 }), "sniper")).toBeGreaterThanOrEqual(30);
    expect(suggestLeverage(idea({ confidence: 0.95 }), "sniper")).toBeLessThanOrEqual(100);
    expect(suggestLeverage(idea({ confidence: 0.95 }), "medium")).toBeGreaterThanOrEqual(10);
    expect(suggestLeverage(idea({ confidence: 0.95 }), "medium")).toBeLessThanOrEqual(50);
    expect(suggestLeverage(idea({ confidence: 0.95 }), "core")).toBeLessThanOrEqual(30);
  });

  it("turns a signal idea into an accountability-ready futures trade plan", () => {
    const plan = buildTradePlanFromIdea(idea(), { marginQuote: 12 });

    expect(plan).toMatchObject({
      symbol: "BTCUSDT",
      market: "mexc-futures",
      direction: "long",
      horizon: "scalp",
      riskMode: "sniper",
      marginQuote: 12,
      entryPrice: 93500,
      stopLossPrice: 93140,
      takeProfitPrice: 94400,
    });
    expect(plan.leverage).toBeGreaterThanOrEqual(30);
    expect(plan.thesis).toContain("scalp long bias");
    expect(plan.generatedFromSignalId).toContain("BTCUSDT:long:scalp");
  });

  it("builds model plans for every idea in a scan and preserves symbol scope", () => {
    const plans = buildTradePlansFromScan(
      scan([
        idea({ direction: "long", horizon: "scalp" }),
        idea({
          direction: "short",
          horizon: "swing",
          entryPrice: 93500,
          invalidationPrice: 94500,
          targets: [91500],
          thesis:
            "swing short bias: higher timeframe turned bearish and support broke",
        }),
      ]),
      { marginQuote: 25 },
    );

    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.symbol)).toEqual(["BTCUSDT", "BTCUSDT"]);
    expect(plans.map((plan) => plan.riskMode)).toEqual(["sniper", "core"]);
  });
});
