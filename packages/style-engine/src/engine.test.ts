import { describe, expect, it } from "vitest";
import type {
  ImportedTrade,
  ReconstructedTrade,
  StyleFingerprint,
} from "@kr8tiv/shared-schemas";
import {
  buildStyleConflicts,
  buildStyleFingerprint,
  reconstructTrades,
} from "./engine.js";

function trade(
  partial: Partial<ImportedTrade> & Pick<ImportedTrade, "sourceTradeId">,
): ImportedTrade {
  return {
    venue: "mexc",
    market: "mexc-spot",
    symbol: "ETHUSDT",
    side: "buy",
    price: 3000,
    size: 0.01,
    quoteNotional: 30,
    fee: 0.03,
    feeCurrency: "USDT",
    executedAtMs: 1_700_000_000_000,
    ...partial,
  };
}

describe("reconstructTrades", () => {
  it("reconstructs a simple buy-then-sell round trip", () => {
    const reconstructed = reconstructTrades([
      trade({
        sourceTradeId: "b1",
        side: "buy",
        price: 3000,
        size: 0.02,
        quoteNotional: 60,
        fee: 0.06,
        executedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      }),
      trade({
        sourceTradeId: "s1",
        side: "sell",
        price: 3120,
        size: 0.02,
        quoteNotional: 62.4,
        fee: 0.06,
        executedAtMs: Date.UTC(2026, 3, 20, 13, 0, 0),
      }),
    ]);

    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]).toMatchObject({
      symbol: "ETHUSDT",
      direction: "long",
      entryPrice: 3000,
      exitPrice: 3120,
      size: 0.02,
      grossPnlQuote: 2.4,
      feesQuote: 0.12,
      netPnlQuote: 2.28,
      holdTimeMs: 3_600_000,
    });
  });

  it("uses weighted entry price across scale-ins before one exit", () => {
    const reconstructed = reconstructTrades([
      trade({
        sourceTradeId: "b1",
        side: "buy",
        price: 3000,
        size: 0.01,
        quoteNotional: 30,
        fee: 0.03,
        executedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      }),
      trade({
        sourceTradeId: "b2",
        side: "buy",
        price: 3100,
        size: 0.01,
        quoteNotional: 31,
        fee: 0.03,
        executedAtMs: Date.UTC(2026, 3, 20, 12, 5, 0),
      }),
      trade({
        sourceTradeId: "s1",
        side: "sell",
        price: 3300,
        size: 0.02,
        quoteNotional: 66,
        fee: 0.04,
        executedAtMs: Date.UTC(2026, 3, 20, 13, 0, 0),
      }),
    ]);

    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]?.entryPrice).toBe(3050);
    expect(reconstructed[0]?.grossPnlQuote).toBe(5);
    expect(reconstructed[0]?.feesQuote).toBe(0.1);
    expect(reconstructed[0]?.netPnlQuote).toBe(4.9);
  });

  it("reconstructs a simple futures short from sell-then-buy fills", () => {
    const reconstructed = reconstructTrades([
      trade({
        market: "mexc-futures",
        sourceTradeId: "s1",
        side: "sell",
        price: 90000,
        size: 0.01,
        quoteNotional: 900,
        fee: 0.36,
        executedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
      }),
      trade({
        market: "mexc-futures",
        sourceTradeId: "b1",
        side: "buy",
        price: 89000,
        size: 0.01,
        quoteNotional: 890,
        fee: 0.36,
        executedAtMs: Date.UTC(2026, 3, 20, 12, 20, 0),
      }),
    ]);

    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]).toMatchObject({
      symbol: "ETHUSDT",
      market: "mexc-futures",
      direction: "short",
      entryPrice: 90000,
      exitPrice: 89000,
      size: 0.01,
      grossPnlQuote: 10,
      feesQuote: 0.72,
      netPnlQuote: 9.28,
      holdTimeMs: 1_200_000,
    });
  });

  it("ignores unmatched open inventory until a close arrives", () => {
    const reconstructed = reconstructTrades([
      trade({
        sourceTradeId: "b1",
        side: "buy",
        size: 0.02,
      }),
    ]);

    expect(reconstructed).toEqual([]);
  });
});

describe("buildStyleFingerprint", () => {
  it("computes hold, sizing, and expectancy metrics from closed trades", () => {
    const reconstructed: ReconstructedTrade[] = [
      {
        symbol: "ETHUSDT",
        market: "mexc-spot",
        direction: "long",
        entryTimeMs: Date.UTC(2026, 3, 20, 12, 0, 0),
        exitTimeMs: Date.UTC(2026, 3, 20, 13, 0, 0),
        holdTimeMs: 3_600_000,
        entryPrice: 3000,
        exitPrice: 3120,
        size: 0.02,
        grossPnlQuote: 2.4,
        feesQuote: 0.12,
        netPnlQuote: 2.28,
        entryTradeIds: ["1"],
        exitTradeIds: ["2"],
      },
      {
        symbol: "ETHUSDT",
        market: "mexc-spot",
        direction: "long",
        entryTimeMs: Date.UTC(2026, 3, 21, 12, 15, 0),
        exitTimeMs: Date.UTC(2026, 3, 21, 12, 45, 0),
        holdTimeMs: 1_800_000,
        entryPrice: 2800,
        exitPrice: 2780,
        size: 0.03,
        grossPnlQuote: -0.6,
        feesQuote: 0.15,
        netPnlQuote: -0.75,
        entryTradeIds: ["3"],
        exitTradeIds: ["4"],
      },
      {
        symbol: "ETHUSDT",
        market: "mexc-spot",
        direction: "long",
        entryTimeMs: Date.UTC(2026, 3, 22, 15, 0, 0),
        exitTimeMs: Date.UTC(2026, 3, 22, 16, 30, 0),
        holdTimeMs: 5_400_000,
        entryPrice: 2900,
        exitPrice: 3000,
        size: 0.015,
        grossPnlQuote: 1.5,
        feesQuote: 0.09,
        netPnlQuote: 1.41,
        entryTradeIds: ["5"],
        exitTradeIds: ["6"],
      },
    ];

    const fingerprint = buildStyleFingerprint("ETHUSDT", reconstructed);

    expect(fingerprint.sampleCount).toBe(3);
    expect(fingerprint.avgHoldTimeMs).toBe(3_600_000);
    expect(fingerprint.medianHoldTimeMs).toBe(3_600_000);
    expect(fingerprint.medianPositionSizeQuote).toBeCloseTo(60, 5);
    expect(fingerprint.winRate).toBeCloseTo(2 / 3, 5);
    expect(fingerprint.avgWinHoldTimeMs).toBe(4_500_000);
    expect(fingerprint.avgLossHoldTimeMs).toBe(1_800_000);
    expect(fingerprint.preferredEntryHoursUtc).toEqual([12, 15]);
    expect(fingerprint.hourOfDayExpectancy["12"]?.sampleCount).toBe(2);
  });

  it("returns an empty baseline for no closed trades", () => {
    const fingerprint = buildStyleFingerprint("ETHUSDT", []);

    expect(fingerprint.sampleCount).toBe(0);
    expect(fingerprint.preferredEntryHoursUtc).toEqual([]);
    expect(fingerprint.hourOfDayExpectancy).toEqual({});
  });
});

describe("buildStyleConflicts", () => {
  it("flags thin sample counts before pretending confidence", () => {
    const fingerprint: StyleFingerprint = {
      symbol: "ETHUSDT",
      sampleCount: 3,
      avgHoldTimeMs: 1_000,
      medianHoldTimeMs: 1_000,
      medianPositionSizeQuote: 50,
      winRate: 0.5,
      avgWinHoldTimeMs: 1_000,
      avgLossHoldTimeMs: 1_000,
      preferredEntryHoursUtc: [12],
      hourOfDayExpectancy: {},
    };

    const conflicts = buildStyleConflicts(
      {
        symbol: "ETHUSDT",
        generatedAtMs: Date.UTC(2026, 3, 22, 18, 0, 0),
        proposedNotionalQuote: 40,
      },
      fingerprint,
    );

    expect(conflicts.map((c) => c.code)).toContain("insufficient-style-sample");
  });

  it("flags out-of-hours and oversized trade ideas against a mature fingerprint", () => {
    const fingerprint: StyleFingerprint = {
      symbol: "ETHUSDT",
      sampleCount: 30,
      avgHoldTimeMs: 3_000_000,
      medianHoldTimeMs: 2_000_000,
      medianPositionSizeQuote: 60,
      winRate: 0.6,
      avgWinHoldTimeMs: 4_000_000,
      avgLossHoldTimeMs: 1_500_000,
      preferredEntryHoursUtc: [12, 13],
      hourOfDayExpectancy: {
        "12": { sampleCount: 12, avgNetPnlQuote: 2.3, winRate: 0.66 },
      },
    };

    const conflicts = buildStyleConflicts(
      {
        symbol: "ETHUSDT",
        generatedAtMs: Date.UTC(2026, 3, 22, 18, 0, 0),
        proposedNotionalQuote: 150,
      },
      fingerprint,
    );

    expect(conflicts.map((c) => c.code)).toEqual([
      "outside-preferred-hours",
      "oversized-vs-style",
    ]);
  });
});
