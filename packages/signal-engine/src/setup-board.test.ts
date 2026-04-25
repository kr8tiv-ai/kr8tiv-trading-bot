import { describe, expect, it } from "vitest";
import type { MarketScan } from "@kr8tiv/shared-schemas";
import type { StrategyBacktestComparison } from "./backtest.js";
import type { FuturesContextAssessment } from "./context.js";
import type { AdaptiveGridPlan } from "./grid.js";
import { buildSetupBoardRow } from "./setup-board.js";

function scan(direction: "long" | "short" = "long"): MarketScan {
  return {
    symbol: "BTCUSDT",
    market: "mexc-futures",
    currentPrice: 100_000,
    regime: direction === "long" ? "bullish" : "bearish",
    warnings: [],
    strategies: [
      {
        strategy: "adaptive-grid",
        timeframe: "Min15",
        bias: direction,
        confidence: 0.78,
        summary: "edge band tagged",
      },
    ],
    ideas: [
      {
        symbol: "BTCUSDT",
        market: "mexc-futures",
        direction,
        horizon: "scalp",
        confidence: 0.78,
        entryPrice: 100_000,
        invalidationPrice: direction === "long" ? 99_200 : 100_800,
        targets: [101_500],
        thesis: "adaptive grid edge band tagged",
        reasons: ["edge band tagged"],
        strategies: [
          {
            strategy: "adaptive-grid",
            timeframe: "Min15",
            bias: direction,
            confidence: 0.78,
            summary: "edge band tagged",
          },
        ],
      },
    ],
  };
}

function comparison(best: StrategyBacktestComparison["best"]): StrategyBacktestComparison {
  return {
    best,
    recommendation: best
      ? `${best.strategy} is currently best`
      : "No strategy edge is positive on this replay; protect capital and wait.",
    results: best ? [best] : [],
  };
}

function context(
  bias: FuturesContextAssessment["bias"],
  score = 68,
): FuturesContextAssessment {
  return {
    symbol: "BTCUSDT",
    bias,
    crowding: bias === "long" ? "shorts_crowded" : bias === "short" ? "longs_crowded" : "balanced",
    score,
    fundingRate: bias === "long" ? -0.0008 : bias === "short" ? 0.0008 : 0.00002,
    basisPct: bias === "long" ? -0.002 : bias === "short" ? 0.002 : 0.0001,
    riseFallRate: bias === "long" ? -0.03 : bias === "short" ? 0.03 : 0,
    amount24: 1_000_000_000,
    holdVol: 100_000,
    notes: ["context note"],
  };
}

function grid(levels = 6): AdaptiveGridPlan {
  return {
    symbol: "BTCUSDT",
    strategy: "adaptive-grid",
    riskMode: "medium",
    currentPrice: 100_000,
    rangeLow: 98_000,
    rangeHigh: 102_000,
    rangePct: 0.04,
    capitalQuote: 100,
    allocatedCapitalQuote: 35,
    levels: Array.from({ length: levels }, (_, index) => ({
      side: index < levels / 2 ? "long" : "short",
      entryPrice: 99_000 + index * 500,
      takeProfitPrice: 99_500 + index * 500,
      stopLossPrice: 97_500,
      marginQuote: 5,
      notionalQuote: 100,
      leverage: 20,
    })),
    warnings: [],
  };
}

describe("buildSetupBoardRow", () => {
  it("promotes an aligned setup when model, backtest, context, and grid agree", () => {
    const row = buildSetupBoardRow({
      scan: scan("long"),
      comparison: comparison({
        strategy: "adaptive-grid",
        trades: [{ direction: "long", entryTimeMs: 1, exitTimeMs: 2, entryPrice: 1, exitPrice: 2, pnlPct: 1.2, exitReason: "target" }],
        netPnlPct: 2.4,
        winRate: 0.66,
        profitFactor: 2.1,
        maxDrawdownPct: 0.5,
        warnings: [],
      }),
      context: context("long"),
      gridPlan: grid(),
    });

    expect(row.action).toBe("consider_long");
    expect(row.score).toBeGreaterThan(75);
    expect(row.notes.join(" ")).toContain("backtest supports");
  });

  it("waits when context is strongly against the model side", () => {
    const row = buildSetupBoardRow({
      scan: scan("long"),
      comparison: comparison({
        strategy: "adaptive-grid",
        trades: [{ direction: "long", entryTimeMs: 1, exitTimeMs: 2, entryPrice: 1, exitPrice: 2, pnlPct: 1.2, exitReason: "target" }],
        netPnlPct: 2.4,
        winRate: 0.66,
        profitFactor: 2.1,
        maxDrawdownPct: 0.5,
        warnings: [],
      }),
      context: context("short", 72),
      gridPlan: grid(),
    });

    expect(row.action).toBe("wait");
    expect(row.blockers).toContain("context is strongly against the model side");
  });

  it("waits when no backtest edge is positive", () => {
    const row = buildSetupBoardRow({
      scan: scan("short"),
      comparison: comparison(null),
      context: context("neutral", 20),
      gridPlan: grid(0),
    });

    expect(row.action).toBe("wait");
    expect(row.blockers).toContain("recent backtest has no positive edge");
  });
});
