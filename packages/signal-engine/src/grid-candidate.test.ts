import { describe, expect, it } from "vitest";
import { scoreGridTradingCandidate } from "./grid-candidate.js";
import type { StrategyBacktestComparison } from "./backtest.js";
import type { FuturesContextAssessment } from "./context.js";
import type { AdaptiveGridPlan } from "./grid.js";

function plan(overrides: Partial<AdaptiveGridPlan> = {}): AdaptiveGridPlan {
  return {
    symbol: "BTCUSDT",
    strategy: "adaptive-grid",
    riskMode: "medium",
    currentPrice: 100,
    rangeLow: 96,
    rangeHigh: 104,
    rangePct: 0.08,
    capitalQuote: 200,
    allocatedCapitalQuote: 70,
    warnings: [],
    levels: [
      {
        side: "long",
        entryPrice: 98,
        takeProfitPrice: 99.5,
        stopLossPrice: 94,
        marginQuote: 10,
        notionalQuote: 200,
        leverage: 20,
      },
      {
        side: "short",
        entryPrice: 102,
        takeProfitPrice: 100.5,
        stopLossPrice: 106,
        marginQuote: 10,
        notionalQuote: 200,
        leverage: 20,
      },
    ],
    ...overrides,
  };
}

function comparison(
  gridNet = 3.2,
  bestStrategy: "adaptive-grid" | "breakout-trailing" | null = "adaptive-grid",
): StrategyBacktestComparison {
  const grid = {
    strategy: "adaptive-grid" as const,
    trades: [],
    netPnlPct: gridNet,
    winRate: 0.62,
    profitFactor: 1.9,
    maxDrawdownPct: 1.2,
    warnings: [],
  };
  const breakout = {
    strategy: "breakout-trailing" as const,
    trades: [],
    netPnlPct: -0.6,
    winRate: 0.2,
    profitFactor: 0.6,
    maxDrawdownPct: 2.4,
    warnings: [],
  };
  return {
    results: [grid, breakout],
    best:
      bestStrategy === "adaptive-grid"
        ? grid
        : bestStrategy === "breakout-trailing"
          ? breakout
          : null,
    recommendation: "range conditions are scoring better",
  };
}

function context(
  overrides: Partial<FuturesContextAssessment> = {},
): FuturesContextAssessment {
  return {
    symbol: "BTCUSDT",
    bias: "neutral",
    crowding: "balanced",
    score: 38,
    fundingRate: 0.0001,
    basisPct: 0.0002,
    riseFallRate: 0.003,
    amount24: 1_000_000,
    holdVol: 55_000,
    notes: ["balanced context"],
    ...overrides,
  };
}

describe("scoreGridTradingCandidate", () => {
  it("marks a futures grid as paper-grid ready when plan, backtest, and context agree", () => {
    const scored = scoreGridTradingCandidate({
      plan: plan(),
      comparison: comparison(),
      context: context(),
    });

    expect(scored).toMatchObject({
      symbol: "BTCUSDT",
      action: "paper_grid",
      bestBacktestStrategy: "adaptive-grid",
      gridLevelCount: 2,
    });
    expect(scored.score).toBeGreaterThanOrEqual(70);
    expect(scored.blockers).toEqual([]);
  });

  it("blocks live-grid temptation when grid has no edge or the market context is crowded", () => {
    const scored = scoreGridTradingCandidate({
      plan: plan({ warnings: ["grid leverage is high; reduce size"] }),
      comparison: comparison(-1.4, "breakout-trailing"),
      context: context({ bias: "short", crowding: "longs_crowded", score: 74 }),
    });

    expect(scored.action).toBe("avoid");
    expect(scored.score).toBeLessThan(50);
    expect(scored.blockers).toContain("adaptive-grid is not the best recent replay");
    expect(scored.blockers).toContain("crowded futures context is hostile to passive grid entries");
  });
});
