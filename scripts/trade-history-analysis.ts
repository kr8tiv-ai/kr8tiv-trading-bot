import { SUPPORTED_FUTURES_SIGNAL_SYMBOLS } from "@kr8tiv/mexc-futures";
import {
  buildStyleFingerprint,
  reconstructTrades,
} from "@kr8tiv/style-engine";
import type {
  ImportedTrade,
  ReconstructedTrade,
  StyleFingerprint,
} from "@kr8tiv/shared-schemas";

type DirectionSummary = {
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlQuote: number;
  avgNetPnlQuote: number;
};

export type SymbolTradeAnalysis = DirectionSummary & {
  symbol: string;
  importedTrades: number;
  grossProfitQuote: number;
  grossLossQuote: number;
  feesQuote: number;
  profitFactor: number;
  avgHoldTimeMs: number;
  long: DirectionSummary;
  short: DirectionSummary;
  fingerprint: StyleFingerprint;
};

export type CoachingInsight = {
  code:
    | "direction-underperforming"
    | "symbol-negative-expectancy"
    | "losses-held-too-long"
    | "fees-eating-edge";
  severity: "info" | "warn" | "block";
  scope: string;
  message: string;
  evidence: string;
  suggestedAction: string;
};

export type PastTradeAnalysis = {
  generatedAtMs: number;
  totals: Omit<SymbolTradeAnalysis, "symbol" | "fingerprint" | "long" | "short">;
  symbols: SymbolTradeAnalysis[];
  coaching: CoachingInsight[];
};

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function summarizeDirection(trades: ReconstructedTrade[]): DirectionSummary {
  const wins = trades.filter((trade) => trade.netPnlQuote > 0);
  const losses = trades.filter((trade) => trade.netPnlQuote <= 0);
  const netPnlQuote = trades.reduce((sum, trade) => sum + trade.netPnlQuote, 0);
  return {
    closedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? round(wins.length / trades.length, 4) : 0,
    netPnlQuote: round(netPnlQuote),
    avgNetPnlQuote: trades.length > 0 ? round(netPnlQuote / trades.length) : 0,
  };
}

function summarizeSymbol(
  symbol: string,
  importedTrades: ImportedTrade[],
  closedTrades: ReconstructedTrade[],
): SymbolTradeAnalysis {
  const symbolImported = importedTrades.filter((trade) => trade.symbol === symbol);
  const symbolClosed = closedTrades.filter((trade) => trade.symbol === symbol);
  const long = summarizeDirection(
    symbolClosed.filter((trade) => trade.direction === "long"),
  );
  const short = summarizeDirection(
    symbolClosed.filter((trade) => trade.direction === "short"),
  );
  const all = summarizeDirection(symbolClosed);
  const grossProfitQuote = symbolClosed
    .filter((trade) => trade.netPnlQuote > 0)
    .reduce((sum, trade) => sum + trade.netPnlQuote, 0);
  const grossLossQuote = symbolClosed
    .filter((trade) => trade.netPnlQuote <= 0)
    .reduce((sum, trade) => sum + trade.netPnlQuote, 0);
  const feesQuote = symbolClosed.reduce((sum, trade) => sum + trade.feesQuote, 0);
  const holdTimeMs = symbolClosed.reduce((sum, trade) => sum + trade.holdTimeMs, 0);
  const lossAbs = Math.abs(grossLossQuote);

  return {
    symbol,
    importedTrades: symbolImported.length,
    ...all,
    grossProfitQuote: round(grossProfitQuote),
    grossLossQuote: round(grossLossQuote),
    feesQuote: round(feesQuote),
    profitFactor:
      lossAbs > 0
        ? round(grossProfitQuote / lossAbs, 4)
        : grossProfitQuote > 0
          ? round(grossProfitQuote, 4)
          : 0,
    avgHoldTimeMs:
      symbolClosed.length > 0 ? Math.round(holdTimeMs / symbolClosed.length) : 0,
    long,
    short,
    fingerprint: buildStyleFingerprint(symbol, symbolClosed),
  };
}

function buildCoachingInsights(symbols: SymbolTradeAnalysis[]): CoachingInsight[] {
  const insights: CoachingInsight[] = [];

  for (const row of symbols) {
    if (row.closedTrades >= 3 && row.netPnlQuote < 0) {
      insights.push({
        code: "symbol-negative-expectancy",
        severity: "warn",
        scope: row.symbol,
        message: `${row.symbol} is negative across the imported sample.`,
        evidence: `closed=${row.closedTrades} net=${row.netPnlQuote.toFixed(2)} winRate=${(row.winRate * 100).toFixed(0)}%`,
        suggestedAction: `Reduce ${row.symbol} size or require setup-board score >= 70 until this improves.`,
      });
    }

    if (
      row.long.closedTrades >= 2 &&
      row.short.closedTrades >= 1 &&
      row.long.avgNetPnlQuote < 0 &&
      row.short.avgNetPnlQuote > row.long.avgNetPnlQuote
    ) {
      insights.push({
        code: "direction-underperforming",
        severity: "warn",
        scope: row.symbol,
        message: `${row.symbol} longs are underperforming shorts in your imported history.`,
        evidence: `longAvg=${row.long.avgNetPnlQuote.toFixed(2)} shortAvg=${row.short.avgNetPnlQuote.toFixed(2)} longWin=${(row.long.winRate * 100).toFixed(0)}%`,
        suggestedAction: `Avoid ${row.symbol} longs unless context, backtest, and setup-board all agree.`,
      });
    }

    if (
      row.short.closedTrades >= 2 &&
      row.long.closedTrades >= 1 &&
      row.short.avgNetPnlQuote < 0 &&
      row.long.avgNetPnlQuote > row.short.avgNetPnlQuote
    ) {
      insights.push({
        code: "direction-underperforming",
        severity: "warn",
        scope: row.symbol,
        message: `${row.symbol} shorts are underperforming longs in your imported history.`,
        evidence: `shortAvg=${row.short.avgNetPnlQuote.toFixed(2)} longAvg=${row.long.avgNetPnlQuote.toFixed(2)} shortWin=${(row.short.winRate * 100).toFixed(0)}%`,
        suggestedAction: `Avoid ${row.symbol} shorts unless context, backtest, and setup-board all agree.`,
      });
    }

    if (
      row.fingerprint.sampleCount >= 4 &&
      row.fingerprint.avgLossHoldTimeMs > row.fingerprint.avgWinHoldTimeMs * 1.8 &&
      row.fingerprint.avgWinHoldTimeMs > 0
    ) {
      insights.push({
        code: "losses-held-too-long",
        severity: "warn",
        scope: row.symbol,
        message: `${row.symbol} losses are being held much longer than winners.`,
        evidence: `avgLossHoldMin=${Math.round(row.fingerprint.avgLossHoldTimeMs / 60_000)} avgWinHoldMin=${Math.round(row.fingerprint.avgWinHoldTimeMs / 60_000)}`,
        suggestedAction: "Pre-commit the stop and use panic/close discipline instead of waiting for rescue.",
      });
    }

    const grossProfitAbs = Math.abs(row.grossProfitQuote);
    if (row.closedTrades >= 3 && grossProfitAbs > 0 && row.feesQuote > grossProfitAbs * 0.25) {
      insights.push({
        code: "fees-eating-edge",
        severity: "info",
        scope: row.symbol,
        message: `${row.symbol} fees are eating a large chunk of gross profits.`,
        evidence: `fees=${row.feesQuote.toFixed(2)} grossProfit=${row.grossProfitQuote.toFixed(2)}`,
        suggestedAction: "Trade fewer, cleaner setups or widen targets enough to pay fees.",
      });
    }
  }

  return insights.sort((a, b) => {
    const rank = { block: 3, warn: 2, info: 1 };
    return rank[b.severity] - rank[a.severity] || a.scope.localeCompare(b.scope);
  });
}

export function buildPastTradeAnalysis(
  importedTrades: ImportedTrade[],
): PastTradeAnalysis {
  const closedTrades = reconstructTrades(importedTrades);
  const symbols = SUPPORTED_FUTURES_SIGNAL_SYMBOLS.map((symbol) =>
    summarizeSymbol(symbol, importedTrades, closedTrades),
  );
  const totalsBase = summarizeDirection(closedTrades);
  const grossProfitQuote = closedTrades
    .filter((trade) => trade.netPnlQuote > 0)
    .reduce((sum, trade) => sum + trade.netPnlQuote, 0);
  const grossLossQuote = closedTrades
    .filter((trade) => trade.netPnlQuote <= 0)
    .reduce((sum, trade) => sum + trade.netPnlQuote, 0);
  const feesQuote = closedTrades.reduce((sum, trade) => sum + trade.feesQuote, 0);
  const holdTimeMs = closedTrades.reduce((sum, trade) => sum + trade.holdTimeMs, 0);
  const lossAbs = Math.abs(grossLossQuote);

  return {
    generatedAtMs: Date.now(),
    totals: {
      importedTrades: importedTrades.length,
      closedTrades: totalsBase.closedTrades,
      wins: totalsBase.wins,
      losses: totalsBase.losses,
      winRate: totalsBase.winRate,
      netPnlQuote: totalsBase.netPnlQuote,
      avgNetPnlQuote: totalsBase.avgNetPnlQuote,
      grossProfitQuote: round(grossProfitQuote),
      grossLossQuote: round(grossLossQuote),
      feesQuote: round(feesQuote),
      profitFactor:
        lossAbs > 0
          ? round(grossProfitQuote / lossAbs, 4)
          : grossProfitQuote > 0
            ? round(grossProfitQuote, 4)
            : 0,
      avgHoldTimeMs:
        closedTrades.length > 0 ? Math.round(holdTimeMs / closedTrades.length) : 0,
    },
    symbols,
    coaching: buildCoachingInsights(symbols),
  };
}
