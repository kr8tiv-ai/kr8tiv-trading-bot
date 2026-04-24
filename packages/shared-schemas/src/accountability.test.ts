import { describe, expect, it } from "vitest";
import {
  AccountableTradePlanSchema,
  AccountabilityCheckSchema,
  RiskModeSchema,
} from "./index.js";

describe("RiskModeSchema", () => {
  it("accepts sniper and core modes", () => {
    expect(RiskModeSchema.parse("sniper")).toBe("sniper");
    expect(RiskModeSchema.parse("core")).toBe("core");
  });
});

describe("AccountableTradePlanSchema", () => {
  it("parses a high-leverage futures sniper plan with journal context", () => {
    const plan = AccountableTradePlanSchema.parse({
      symbol: "BTCUSDT",
      market: "mexc-futures",
      direction: "long",
      horizon: "scalp",
      riskMode: "sniper",
      leverage: 75,
      marginQuote: 12,
      entryPrice: 93_500,
      stopLossPrice: 93_140,
      takeProfitPrice: 94_400,
      thesis:
        "15m reclaim with momentum confirmation; invalid quickly below VWAP.",
      journalNote: "I am taking this because structure reclaimed after sweep.",
    });

    expect(plan.riskMode).toBe("sniper");
    expect(plan.leverage).toBe(75);
  });

  it("rejects spot plans because accountability v1 is futures-first", () => {
    expect(() =>
      AccountableTradePlanSchema.parse({
        symbol: "BTCUSDT",
        market: "mexc-spot",
        direction: "long",
        horizon: "scalp",
        riskMode: "sniper",
        leverage: 20,
        marginQuote: 12,
        entryPrice: 93_500,
        stopLossPrice: 93_140,
        takeProfitPrice: 94_400,
        thesis: "A valid but intentionally spot-market plan.",
        journalNote: "The schema should reject this market for this workflow.",
      }),
    ).toThrow(/futures/i);
  });
});

describe("AccountabilityCheckSchema", () => {
  it("parses a risk review result with hard blocks and warnings", () => {
    const review = AccountabilityCheckSchema.parse({
      okToProceed: false,
      estimatedLossQuote: 4.5,
      estimatedRewardQuote: 11.25,
      riskRewardRatio: 2.5,
      blocks: [
        {
          code: "missing-thesis",
          message: "Journal thesis is required before entry.",
        },
      ],
      warnings: [
        {
          code: "high-leverage",
          message: "75x sniper setup; size must stay small and invalidation tight.",
        },
      ],
    });

    expect(review.okToProceed).toBe(false);
    expect(review.warnings[0]?.code).toBe("high-leverage");
  });
});
