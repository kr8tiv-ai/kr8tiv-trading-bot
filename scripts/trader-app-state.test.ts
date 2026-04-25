import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase, type BetterSqliteDatabase } from "@kr8tiv/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRecentTradeFeedback,
  listStrategyEffectiveness,
  readTraderSettings,
  recordBacktestComparison,
  recordTradeFeedback,
  saveTraderSettings,
} from "./trader-app-state.js";

let dir: string;
let db: BetterSqliteDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kr8tiv-trader-app-state-"));
  db = openDatabase(path.join(dir, "state.sqlite"));
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("trader-app-state", () => {
  it("returns default capital settings and persists a partial override", () => {
    expect(readTraderSettings(db)).toMatchObject({
      capitalBudgetQuote: 100,
      defaultMarginQuote: 25,
      mediumMarginQuote: 25,
    });

    const saved = saveTraderSettings(db, {
      capitalBudgetQuote: 250,
      defaultMarginQuote: 50,
    });

    expect(saved).toMatchObject({
      capitalBudgetQuote: 250,
      defaultMarginQuote: 50,
      mediumMarginQuote: 25,
    });
    expect(readTraderSettings(db)).toMatchObject({
      capitalBudgetQuote: 250,
      defaultMarginQuote: 50,
    });
  });

  it("records quick accountable feedback events", () => {
    const saved = recordTradeFeedback(db, {
      journalId: 42,
      action: "broke_rules",
      note: "entered before candle close",
    });

    expect(saved).toMatchObject({
      id: 1,
      journalId: 42,
      action: "broke_rules",
      note: "entered before candle close",
    });
    expect(listRecentTradeFeedback(db, 5)).toEqual([saved]);
  });

  it("stores backtest snapshots and ranks latest strategy effectiveness by symbol", () => {
    recordBacktestComparison(db, {
      generatedAtMs: 1_000,
      interval: "Min15",
      limit: 320,
      symbol: "BTCUSDT",
      currentPrice: 100,
      comparison: {
        recommendation: "range is better",
        best: {
          strategy: "adaptive-grid",
          trades: [],
          netPnlPct: 3.4,
          winRate: 0.61,
          profitFactor: 1.8,
          maxDrawdownPct: 1.1,
          warnings: [],
        },
        results: [
          {
            strategy: "adaptive-grid",
            trades: [{}, {}, {}],
            netPnlPct: 3.4,
            winRate: 0.61,
            profitFactor: 1.8,
            maxDrawdownPct: 1.1,
            warnings: [],
          },
          {
            strategy: "breakout-trailing",
            trades: [{}],
            netPnlPct: -0.5,
            winRate: 0,
            profitFactor: 0,
            maxDrawdownPct: 0.5,
            warnings: ["choppy"],
          },
        ],
      },
    });
    recordBacktestComparison(db, {
      generatedAtMs: 2_000,
      interval: "Min15",
      limit: 320,
      symbol: "BTCUSDT",
      currentPrice: 106,
      comparison: {
        recommendation: "breakout is better",
        best: {
          strategy: "breakout-trailing",
          trades: [],
          netPnlPct: 4.2,
          winRate: 0.67,
          profitFactor: 2.2,
          maxDrawdownPct: 0.8,
          warnings: [],
        },
        results: [
          {
            strategy: "breakout-trailing",
            trades: [{}, {}],
            netPnlPct: 4.2,
            winRate: 0.67,
            profitFactor: 2.2,
            maxDrawdownPct: 0.8,
            warnings: [],
          },
          {
            strategy: "adaptive-grid",
            trades: [{}],
            netPnlPct: 0.2,
            winRate: 0.5,
            profitFactor: 1.1,
            maxDrawdownPct: 0.6,
            warnings: [],
          },
        ],
      },
    });

    const effectiveness = listStrategyEffectiveness(db);

    expect(effectiveness).toHaveLength(1);
    expect(effectiveness[0]).toMatchObject({
      symbol: "BTCUSDT",
      bestStrategy: "breakout-trailing",
      latestRecommendation: "breakout is better",
      snapshotCount: 2,
    });
    expect(effectiveness[0]?.strategies[0]).toMatchObject({
      strategy: "breakout-trailing",
      latestNetPnlPct: 4.2,
      latestTradeCount: 2,
      samples: 2,
    });
  });
});
