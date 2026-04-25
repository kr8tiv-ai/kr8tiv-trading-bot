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

export type PastTradeAnalysis = {
  generatedAtMs: number;
  totals: Omit<SymbolTradeAnalysis, "symbol" | "fingerprint" | "long" | "short">;
  symbols: SymbolTradeAnalysis[];
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
  };
}
