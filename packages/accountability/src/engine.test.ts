import { describe, expect, it } from "vitest";
import type { AccountableTradePlan } from "@kr8tiv/shared-schemas";
import { reviewTradePlan } from "./engine.js";

function basePlan(overrides: Partial<AccountableTradePlan> = {}): AccountableTradePlan {
  return {
    symbol: "BTCUSDT",
    market: "mexc-futures",
    direction: "long",
    horizon: "scalp",
    riskMode: "sniper",
    leverage: 50,
    marginQuote: 10,
    entryPrice: 100_000,
    stopLossPrice: 99_600,
    takeProfitPrice: 101_200,
    thesis: "Clean liquidity sweep with reclaim and momentum confirmation.",
    journalNote: "This is not revenge; I am taking the reclaim setup only.",
    ...overrides,
  };
}

describe("reviewTradePlan", () => {
  it("allows a journaled sniper setup with tight stop and healthy R multiple", () => {
    const review = reviewTradePlan(basePlan());

    expect(review.okToProceed).toBe(true);
    expect(review.estimatedLossQuote).toBe(2);
    expect(review.estimatedRewardQuote).toBe(6);
    expect(review.riskRewardRatio).toBe(3);
    expect(review.blocks).toEqual([]);
  });

  it("warns when sniper leverage is high but still within the declared mode", () => {
    const review = reviewTradePlan(basePlan({ leverage: 90 }));

    expect(review.okToProceed).toBe(true);
    expect(review.warnings.map((w) => w.code)).toContain("high-leverage");
  });

  it("blocks a core setup above 30x", () => {
    const review = reviewTradePlan(
      basePlan({
        riskMode: "core",
        leverage: 40,
        horizon: "swing",
      }),
    );

    expect(review.okToProceed).toBe(false);
    expect(review.blocks.map((b) => b.code)).toContain(
      "leverage-mode-mismatch",
    );
  });

  it("blocks a sniper setup below 30x because the mode is mismatched", () => {
    const review = reviewTradePlan(basePlan({ leverage: 15 }));

    expect(review.okToProceed).toBe(false);
    expect(review.blocks.map((b) => b.code)).toContain(
      "leverage-mode-mismatch",
    );
  });

  it("blocks missing thesis/journal discipline", () => {
    const review = reviewTradePlan(
      basePlan({
        thesis: "too vague",
        journalNote: "bored",
      }),
    );

    expect(review.okToProceed).toBe(false);
    expect(review.blocks.map((b) => b.code)).toContain("missing-thesis");
  });

  it("blocks poor risk reward even when stop and target are structurally valid", () => {
    const review = reviewTradePlan(
      basePlan({
        stopLossPrice: 99_000,
        takeProfitPrice: 100_500,
      }),
    );

    expect(review.okToProceed).toBe(false);
    expect(review.riskRewardRatio).toBe(0.5);
    expect(review.blocks.map((b) => b.code)).toContain("poor-risk-reward");
  });

  it("calculates short-side loss and reward correctly", () => {
    const review = reviewTradePlan(
      basePlan({
        direction: "short",
        entryPrice: 100_000,
        stopLossPrice: 100_500,
        takeProfitPrice: 98_500,
      }),
    );

    expect(review.estimatedLossQuote).toBe(2.5);
    expect(review.estimatedRewardQuote).toBe(7.5);
    expect(review.riskRewardRatio).toBe(3);
  });
});
