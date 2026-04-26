import type { TradeJournalEntry } from "@kr8tiv/executor";
import type { ImportedTrade } from "@kr8tiv/shared-schemas";
import { describe, expect, it } from "vitest";
import { findTopLeak } from "./leak-detector.js";

function buy(symbol: string, price: number, size: number, ts: number, id: string): ImportedTrade {
  return {
    venue: "mexc",
    market: "mexc-futures",
    symbol,
    side: "buy",
    price,
    size,
    quoteNotional: price * size,
    fee: 0.01,
    feeCurrency: "USDT",
    executedAtMs: ts,
    sourceTradeId: id,
  };
}
function sell(symbol: string, price: number, size: number, ts: number, id: string): ImportedTrade {
  return {
    venue: "mexc",
    market: "mexc-futures",
    symbol,
    side: "sell",
    price,
    size,
    quoteNotional: price * size,
    fee: 0.01,
    feeCurrency: "USDT",
    executedAtMs: ts,
    sourceTradeId: id,
  };
}

function journalRow(overrides: Partial<TradeJournalEntry> = {}): TradeJournalEntry {
  return {
    id: 1,
    createdAtMs: Date.now() - 1000,
    symbol: "BTCUSDT",
    market: "mexc-futures",
    direction: "long",
    horizon: "scalp",
    riskMode: "sniper",
    leverage: 50,
    marginQuote: 10,
    entryPrice: 100,
    stopLossPrice: 99,
    takeProfitPrice: 102,
    thesis: "test",
    journalNote: "test",
    okToProceed: true,
    estimatedLossQuote: 0.5,
    estimatedRewardQuote: 1,
    riskRewardRatio: 2,
    blocks: [],
    warnings: [],
    conflicts: [],
    approvalStatus: null,
    telegramMessageId: null,
    telegramChatId: null,
    approvedAtMs: null,
    rejectedAtMs: null,
    ...overrides,
  };
}

describe("findTopLeak", () => {
  it("returns null when there's no history", () => {
    expect(findTopLeak({ trades: [], journal: [], nowMs: 1 })).toBeNull();
  });

  it("flags a tilt streak when the last three closed trades are losses", () => {
    // 3 loss round-trips: buy higher, sell lower
    const trades = [
      buy("BTCUSDT", 100, 1, 100, "b1"),
      sell("BTCUSDT", 95, 1, 200, "s1"), // -5
      buy("BTCUSDT", 100, 1, 300, "b2"),
      sell("BTCUSDT", 96, 1, 400, "s2"), // -4
      buy("BTCUSDT", 100, 1, 500, "b3"),
      sell("BTCUSDT", 97, 1, 600, "s3"), // -3
    ];
    const leak = findTopLeak({ trades, journal: [], nowMs: 1000 });
    expect(leak?.code).toBe("tilt-streak");
    expect(leak?.severity).toBe("block");
  });

  it("flags an override pattern when 3+ blocked plans were saved this week", () => {
    const now = 1_700_000_000_000;
    const journal = [
      journalRow({
        id: 1,
        createdAtMs: now - 60_000,
        okToProceed: false,
        blocks: [{ code: "poor-risk-reward", message: "x" }],
      }),
      journalRow({
        id: 2,
        createdAtMs: now - 120_000,
        okToProceed: false,
        blocks: [{ code: "missing-thesis", message: "y" }],
      }),
      journalRow({
        id: 3,
        createdAtMs: now - 180_000,
        okToProceed: false,
        blocks: [{ code: "high-leverage", message: "z" }],
      }),
    ];
    const leak = findTopLeak({ trades: [], journal, nowMs: now });
    expect(leak?.code).toBe("override-pattern");
  });

  it("flags an hour-of-day bleed window when a bucket has >= 5 losing closes", () => {
    // 5 losing trades all opened at hour 4 UTC (1700000000000 + offset)
    // Use timestamps inside hour 4 of some UTC day.
    const hour4Base = Date.UTC(2024, 0, 1, 4, 30, 0);
    const trades: ImportedTrade[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t = hour4Base + i * 60_000;
      trades.push(buy("BTCUSDT", 100, 1, t, `b${i}`));
      trades.push(sell("BTCUSDT", 99, 1, t + 30_000, `s${i}`)); // -1 each
    }
    // Add a later winning close so this fixture isolates hour-of-day bleed
    // instead of matching the higher-priority last-3-losses tilt detector.
    trades.push(buy("BTCUSDT", 100, 1, hour4Base + 6 * 60_000, "win-b"));
    trades.push(sell("BTCUSDT", 102, 1, hour4Base + 7 * 60_000, "win-s"));
    const leak = findTopLeak({ trades, journal: [], nowMs: hour4Base });
    expect(leak?.code).toBe("hour-of-day-bleed");
    expect(leak?.evidence.hourUtc).toBe(4);
  });

  it("flags symbol bias when one symbol bleeds and another pays (>=5 closes each)", () => {
    const trades: ImportedTrade[] = [];
    // SOL bleeds 5 closes
    for (let i = 0; i < 5; i += 1) {
      const t = 1_000 + i * 100;
      trades.push(buy("SOLUSDT", 100, 1, t, `solb${i}`));
      trades.push(sell("SOLUSDT", 99, 1, t + 50, `sols${i}`));
    }
    // BTC pays 5 closes
    for (let i = 0; i < 5; i += 1) {
      const t = 5_000 + i * 100;
      trades.push(buy("BTCUSDT", 100, 1, t, `btcb${i}`));
      trades.push(sell("BTCUSDT", 102, 1, t + 50, `btcs${i}`));
    }
    const leak = findTopLeak({ trades, journal: [], nowMs: 10_000 });
    // tilt-streak takes priority if last 3 are all losses; here last 3 closes
    // are BTC wins. So we expect symbol-bias.
    expect(leak?.code).toBe("symbol-bias");
    expect(leak?.evidence.worstSymbol).toBe("SOLUSDT");
    expect(leak?.evidence.bestSymbol).toBe("BTCUSDT");
  });
});
