import { describe, expect, it } from "vitest";
import type { ImportedTrade } from "@kr8tiv/shared-schemas";
import { buildPastTradeAnalysis } from "./trade-history-analysis.js";

function trade(
  partial: Partial<ImportedTrade> & Pick<ImportedTrade, "sourceTradeId">,
): ImportedTrade {
  return {
    venue: "mexc",
    market: "mexc-futures",
    symbol: "BTCUSDT",
    side: "buy",
    price: 100,
    size: 1,
    quoteNotional: 100,
    fee: 0.1,
    feeCurrency: "USDT",
    executedAtMs: Date.UTC(2026, 3, 20, 10, 0, 0),
    ...partial,
  };
}

describe("buildPastTradeAnalysis", () => {
  it("summarizes closed futures longs and shorts by symbol", () => {
    const analysis = buildPastTradeAnalysis([
      trade({
        sourceTradeId: "btc-long-open",
        symbol: "BTCUSDT",
        side: "buy",
        price: 100,
        executedAtMs: Date.UTC(2026, 3, 20, 10, 0, 0),
      }),
      trade({
        sourceTradeId: "btc-long-close",
        symbol: "BTCUSDT",
        side: "sell",
        price: 110,
        executedAtMs: Date.UTC(2026, 3, 20, 10, 15, 0),
      }),
      trade({
        sourceTradeId: "eth-short-open",
        symbol: "ETHUSDT",
        side: "sell",
        price: 2000,
        size: 0.1,
        quoteNotional: 200,
        fee: 0.2,
        executedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      }),
      trade({
        sourceTradeId: "eth-short-close",
        symbol: "ETHUSDT",
        side: "buy",
        price: 2020,
        size: 0.1,
        quoteNotional: 202,
        fee: 0.2,
        executedAtMs: Date.UTC(2026, 3, 20, 12, 30, 0),
      }),
    ]);

    expect(analysis.totals.importedTrades).toBe(4);
    expect(analysis.totals.closedTrades).toBe(2);
    expect(analysis.totals.netPnlQuote).toBeCloseTo(7.4, 5);
    expect(analysis.totals.winRate).toBe(0.5);
    expect(analysis.symbols.map((s) => s.symbol)).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
    ]);
    expect(analysis.symbols[0]).toMatchObject({
      symbol: "BTCUSDT",
      closedTrades: 1,
      wins: 1,
      losses: 0,
      netPnlQuote: 9.8,
      long: { closedTrades: 1, netPnlQuote: 9.8 },
      short: { closedTrades: 0, netPnlQuote: 0 },
    });
    expect(analysis.symbols[1]).toMatchObject({
      symbol: "ETHUSDT",
      closedTrades: 1,
      wins: 0,
      losses: 1,
      netPnlQuote: -2.4,
      long: { closedTrades: 0, netPnlQuote: 0 },
      short: { closedTrades: 1, netPnlQuote: -2.4 },
    });
  });

  it("returns zeroed BTC/ETH/SOL rows before history is ingested", () => {
    const analysis = buildPastTradeAnalysis([]);

    expect(analysis.totals.closedTrades).toBe(0);
    expect(analysis.totals.profitFactor).toBe(0);
    expect(analysis.symbols).toHaveLength(3);
    expect(analysis.symbols.every((row) => row.closedTrades === 0)).toBe(true);
  });
});
