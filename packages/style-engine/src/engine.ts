import {
  ImportedTradeSchema,
  ReconstructedTradeSchema,
  StyleConflictSchema,
  StyleFingerprintSchema,
  type ImportedTrade,
  type ReconstructedTrade,
  type StyleConflict,
  type StyleFingerprint,
} from "@kr8tiv/shared-schemas";

type OpenLot = {
  tradeId: string;
  price: number;
  remainingSize: number;
  fee: number;
  originalSize: number;
  executedAtMs: number;
};

export type StyleConflictInput = {
  symbol: string;
  generatedAtMs: number;
  proposedNotionalQuote?: number;
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return sorted[middle]!;
}

function round(value: number, decimals: number = 8): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function openLotFromTrade(
  trade: ImportedTrade,
  size: number,
  fee: number,
): OpenLot {
  return {
    tradeId: trade.sourceTradeId,
    price: trade.price,
    remainingSize: size,
    fee,
    originalSize: size,
    executedAtMs: trade.executedAtMs,
  };
}

function closeLots(
  lots: OpenLot[],
  closeTrade: ImportedTrade,
  remainingCloseSize: number,
  direction: "long" | "short",
): { remainingCloseSize: number; closed?: ReconstructedTrade } {
  let remaining = remainingCloseSize;
  let entryNotional = 0;
  let exitNotional = 0;
  let entryFees = 0;
  let exitFees = 0;
  let matchedSize = 0;
  let earliestEntryTime = Number.POSITIVE_INFINITY;
  const entryTradeIds: string[] = [];

  while (remaining > 0 && lots.length > 0) {
    const lot = lots[0]!;
    const matched = Math.min(remaining, lot.remainingSize);

    matchedSize += matched;
    entryNotional += matched * lot.price;
    exitNotional += matched * closeTrade.price;
    entryFees += lot.fee * (matched / lot.originalSize);
    exitFees += closeTrade.fee * (matched / closeTrade.size);
    earliestEntryTime = Math.min(earliestEntryTime, lot.executedAtMs);
    if (!entryTradeIds.includes(lot.tradeId)) {
      entryTradeIds.push(lot.tradeId);
    }

    lot.remainingSize -= matched;
    remaining -= matched;

    if (lot.remainingSize <= 0) {
      lots.shift();
    }
  }

  if (matchedSize <= 0) {
    return { remainingCloseSize: remaining };
  }

  const grossPnlQuote =
    direction === "long"
      ? exitNotional - entryNotional
      : entryNotional - exitNotional;

  return {
    remainingCloseSize: remaining,
    closed: ReconstructedTradeSchema.parse({
      symbol: closeTrade.symbol,
      market: closeTrade.market,
      direction,
      entryTimeMs: earliestEntryTime,
      exitTimeMs: closeTrade.executedAtMs,
      holdTimeMs: closeTrade.executedAtMs - earliestEntryTime,
      entryPrice: round(entryNotional / matchedSize),
      exitPrice: round(exitNotional / matchedSize),
      size: round(matchedSize),
      grossPnlQuote: round(grossPnlQuote),
      feesQuote: round(entryFees + exitFees),
      netPnlQuote: round(grossPnlQuote - (entryFees + exitFees)),
      entryTradeIds,
      exitTradeIds: [closeTrade.sourceTradeId],
    }),
  };
}

/**
 * Reconstruct closed futures/spot round trips from imported trade rows via FIFO
 * lot matching. Buy→sell closes longs; sell→buy closes shorts. Unmatched open
 * inventory is intentionally ignored until a future close arrives.
 */
export function reconstructTrades(trades: ImportedTrade[]): ReconstructedTrade[] {
  const parsed = ImportedTradeSchema.array().parse(trades);
  const ordered = [...parsed].sort(
    (a, b) =>
      a.executedAtMs - b.executedAtMs ||
      a.sourceTradeId.localeCompare(b.sourceTradeId),
  );

  const longLots: OpenLot[] = [];
  const shortLots: OpenLot[] = [];
  const reconstructed: ReconstructedTrade[] = [];

  for (const trade of ordered) {
    if (trade.side === "buy") {
      const result = closeLots(shortLots, trade, trade.size, "short");
      if (result.closed) reconstructed.push(result.closed);
      if (result.remainingCloseSize > 0) {
        longLots.push(
          openLotFromTrade(
            trade,
            result.remainingCloseSize,
            trade.fee * (result.remainingCloseSize / trade.size),
          ),
        );
      }
      continue;
    }

    const result = closeLots(longLots, trade, trade.size, "long");
    if (result.closed) reconstructed.push(result.closed);
    if (result.remainingCloseSize > 0) {
      shortLots.push(
        openLotFromTrade(
          trade,
          result.remainingCloseSize,
          trade.fee * (result.remainingCloseSize / trade.size),
        ),
      );
    }
  }

  return reconstructed;
}

export function buildStyleFingerprint(
  symbol: string,
  trades: ReconstructedTrade[],
): StyleFingerprint {
  const filtered = trades.filter((trade) => trade.symbol === symbol);
  if (filtered.length === 0) {
    return StyleFingerprintSchema.parse({
      symbol,
      sampleCount: 0,
      avgHoldTimeMs: 0,
      medianHoldTimeMs: 0,
      medianPositionSizeQuote: 0,
      winRate: 0,
      avgWinHoldTimeMs: 0,
      avgLossHoldTimeMs: 0,
      preferredEntryHoursUtc: [],
      hourOfDayExpectancy: {},
    });
  }

  const holdTimes = filtered.map((trade) => trade.holdTimeMs);
  const positionSizes = filtered.map((trade) => trade.entryPrice * trade.size);
  const wins = filtered.filter((trade) => trade.netPnlQuote > 0);
  const losses = filtered.filter((trade) => trade.netPnlQuote <= 0);

  const buckets = new Map<
    number,
    { count: number; totalPnl: number; wins: number }
  >();
  for (const trade of filtered) {
    const hour = new Date(trade.entryTimeMs).getUTCHours();
    const bucket = buckets.get(hour) ?? { count: 0, totalPnl: 0, wins: 0 };
    bucket.count += 1;
    bucket.totalPnl += trade.netPnlQuote;
    if (trade.netPnlQuote > 0) bucket.wins += 1;
    buckets.set(hour, bucket);
  }

  const hourOfDayExpectancy = Object.fromEntries(
    [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, bucket]) => [
        String(hour),
        {
          sampleCount: bucket.count,
          avgNetPnlQuote: round(bucket.totalPnl / bucket.count),
          winRate: round(bucket.wins / bucket.count),
        },
      ]),
  );

  const preferredEntryHoursUtc = [...buckets.entries()]
    .filter(([, bucket]) => bucket.totalPnl / bucket.count > 0)
    .sort(
      (a, b) =>
        b[1].count - a[1].count ||
        b[1].totalPnl / b[1].count - a[1].totalPnl / a[1].count ||
        a[0] - b[0],
    )
    .map(([hour]) => hour);

  return StyleFingerprintSchema.parse({
    symbol,
    sampleCount: filtered.length,
    avgHoldTimeMs: Math.round(average(holdTimes)),
    medianHoldTimeMs: Math.round(median(holdTimes)),
    medianPositionSizeQuote: round(median(positionSizes)),
    winRate: round(wins.length / filtered.length),
    avgWinHoldTimeMs: Math.round(average(wins.map((trade) => trade.holdTimeMs))),
    avgLossHoldTimeMs: Math.round(
      average(losses.map((trade) => trade.holdTimeMs)),
    ),
    preferredEntryHoursUtc,
    hourOfDayExpectancy,
  });
}

export function buildStyleConflicts(
  input: StyleConflictInput,
  fingerprint?: StyleFingerprint,
): StyleConflict[] {
  if (!fingerprint || fingerprint.symbol !== input.symbol) {
    return [
      StyleConflictSchema.parse({
        code: "insufficient-style-sample",
        severity: "info",
        message: "No matching style fingerprint exists for this symbol yet.",
      }),
    ];
  }

  if (fingerprint.sampleCount < 10) {
    return [
      StyleConflictSchema.parse({
        code: "insufficient-style-sample",
        severity: "info",
        message:
          "Style evidence is still thin, so conflicts are advisory only right now.",
        evidence: `sampleCount=${fingerprint.sampleCount}`,
      }),
    ];
  }

  const conflicts: StyleConflict[] = [];
  const hour = new Date(input.generatedAtMs).getUTCHours();

  if (
    fingerprint.preferredEntryHoursUtc.length > 0 &&
    !fingerprint.preferredEntryHoursUtc.includes(hour)
  ) {
    conflicts.push(
      StyleConflictSchema.parse({
        code: "outside-preferred-hours",
        severity: "info",
        message: "This setup arrives outside your historically stronger UTC windows.",
        evidence: `preferred=${fingerprint.preferredEntryHoursUtc.join(",")} current=${hour}`,
      }),
    );
  }

  if (
    input.proposedNotionalQuote !== undefined &&
    fingerprint.medianPositionSizeQuote > 0 &&
    input.proposedNotionalQuote > fingerprint.medianPositionSizeQuote * 2
  ) {
    const multiple = input.proposedNotionalQuote / fingerprint.medianPositionSizeQuote;
    conflicts.push(
      StyleConflictSchema.parse({
        code: "oversized-vs-style",
        severity: "warn",
        message: `This idea is ${multiple.toFixed(1)}x your median position size.`,
        evidence: `median=${fingerprint.medianPositionSizeQuote} proposed=${input.proposedNotionalQuote}`,
      }),
    );
  }

  return conflicts;
}
