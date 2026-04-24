import { describe, expect, it } from "vitest";
import {
  ImportedTradeSchema,
  ReconstructedTradeSchema,
  StyleConflictSchema,
  StyleFingerprintSchema,
  TradeIdeaSchema,
} from "./index.js";

describe("ImportedTradeSchema", () => {
  it("parses a normalized imported MEXC trade row", () => {
    const trade = ImportedTradeSchema.parse({
      venue: "mexc",
      market: "mexc-spot",
      symbol: "ETHUSDT",
      side: "buy",
      price: 3125.55,
      size: 0.014,
      quoteNotional: 43.7577,
      fee: 0.04,
      feeCurrency: "USDT",
      executedAtMs: 1_763_515_965_654,
      sourceTradeId: "789123",
      sourceOrderId: "456123",
    });

    expect(trade.symbol).toBe("ETHUSDT");
    expect(trade.side).toBe("buy");
  });

  it("rejects a zero size", () => {
    expect(() =>
      ImportedTradeSchema.parse({
        venue: "mexc",
        market: "mexc-spot",
        symbol: "ETHUSDT",
        side: "buy",
        price: 3125.55,
        size: 0,
        quoteNotional: 43.7577,
        fee: 0.04,
        feeCurrency: "USDT",
        executedAtMs: 1_763_515_965_654,
        sourceTradeId: "789123",
      }),
    ).toThrow();
  });
});

describe("ReconstructedTradeSchema", () => {
  it("parses a closed round trip with derived hold time and pnl", () => {
    const trade = ReconstructedTradeSchema.parse({
      symbol: "ETHUSDT",
      market: "mexc-spot",
      direction: "long",
      entryTimeMs: 1_763_515_965_654,
      exitTimeMs: 1_763_516_325_654,
      holdTimeMs: 360_000,
      entryPrice: 3000,
      exitPrice: 3075,
      size: 0.02,
      grossPnlQuote: 1.5,
      feesQuote: 0.08,
      netPnlQuote: 1.42,
      entryTradeIds: ["1", "2"],
      exitTradeIds: ["3"],
    });

    expect(trade.direction).toBe("long");
    expect(trade.holdTimeMs).toBe(360_000);
    expect(trade.netPnlQuote).toBe(1.42);
  });

  it("rejects exitTimeMs before entryTimeMs", () => {
    expect(() =>
      ReconstructedTradeSchema.parse({
        symbol: "ETHUSDT",
        market: "mexc-spot",
        direction: "long",
        entryTimeMs: 1000,
        exitTimeMs: 999,
        holdTimeMs: 1,
        entryPrice: 3000,
        exitPrice: 3075,
        size: 0.02,
        grossPnlQuote: 1.5,
        feesQuote: 0.08,
        netPnlQuote: 1.42,
        entryTradeIds: ["1"],
        exitTradeIds: ["2"],
      }),
    ).toThrow(/entry/i);
  });
});

describe("StyleFingerprintSchema", () => {
  it("parses a summary with preferred windows and hour expectancy", () => {
    const fingerprint = StyleFingerprintSchema.parse({
      symbol: "ETHUSDT",
      sampleCount: 24,
      avgHoldTimeMs: 3_600_000,
      medianHoldTimeMs: 2_700_000,
      medianPositionSizeQuote: 75,
      winRate: 0.58,
      avgWinHoldTimeMs: 4_200_000,
      avgLossHoldTimeMs: 1_800_000,
      preferredEntryHoursUtc: [12, 13, 14],
      hourOfDayExpectancy: {
        "12": { sampleCount: 6, avgNetPnlQuote: 2.5, winRate: 0.66 },
        "13": { sampleCount: 8, avgNetPnlQuote: 1.9, winRate: 0.62 },
      },
    });

    expect(fingerprint.sampleCount).toBe(24);
    expect(fingerprint.preferredEntryHoursUtc).toEqual([12, 13, 14]);
    expect(fingerprint.hourOfDayExpectancy["12"]?.sampleCount).toBe(6);
  });
});

describe("StyleConflictSchema", () => {
  it("parses a concrete style warning", () => {
    const conflict = StyleConflictSchema.parse({
      code: "oversized-vs-style",
      severity: "warn",
      message: "This size is 2.4x your median position size.",
      evidence: "median=40 USDT, proposed=96 USDT",
    });

    expect(conflict.code).toBe("oversized-vs-style");
  });
});

describe("TradeIdeaSchema style integration", () => {
  it("accepts optional conflictsWithStyle annotations", () => {
    const idea = TradeIdeaSchema.parse({
      symbol: "BTCUSDT",
      market: "mexc-futures",
      direction: "long",
      horizon: "scalp",
      confidence: 0.73,
      entryPrice: 93_500,
      invalidationPrice: 92_800,
      targets: [94_250, 95_100],
      thesis: "Momentum continuation with higher lows on 15m.",
      reasons: ["EMA alignment", "MACD cross"],
      strategies: [],
      conflictsWithStyle: [
        {
          code: "outside-preferred-hours",
          severity: "info",
          message: "You rarely open winners during this UTC window.",
        },
      ],
    });

    expect(idea.conflictsWithStyle).toHaveLength(1);
    expect(idea.conflictsWithStyle?.[0]?.code).toBe(
      "outside-preferred-hours",
    );
  });
});
