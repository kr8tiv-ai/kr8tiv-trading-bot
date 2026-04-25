import type { MarketCandle, RiskMode } from "@kr8tiv/shared-schemas";

export type AdaptiveGridLevel = {
  side: "long" | "short";
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  marginQuote: number;
  notionalQuote: number;
  leverage: number;
};

export type AdaptiveGridPlan = {
  symbol: string;
  strategy: "adaptive-grid";
  riskMode: RiskMode;
  currentPrice: number;
  rangeLow: number;
  rangeHigh: number;
  rangePct: number;
  capitalQuote: number;
  allocatedCapitalQuote: number;
  levels: AdaptiveGridLevel[];
  warnings: string[];
};

export type BuildAdaptiveGridPlanInput = {
  symbol: string;
  candles: MarketCandle[];
  capitalQuote?: number;
  leverage?: number;
  riskMode?: RiskMode;
  gridCount?: number;
  maxCapitalPct?: number;
  lookback?: number;
};

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildAdaptiveGridPlan(
  input: BuildAdaptiveGridPlanInput,
): AdaptiveGridPlan {
  const riskMode = input.riskMode ?? "medium";
  const capitalQuote = Math.max(0, input.capitalQuote ?? 100);
  const leverage = clamp(input.leverage ?? 20, 1, 100);
  const gridCount = Math.max(4, Math.min(12, Math.floor(input.gridCount ?? 6)));
  const maxCapitalPct = clamp(input.maxCapitalPct ?? 0.35, 0.05, 0.8);
  const lookback = Math.max(20, Math.min(240, Math.floor(input.lookback ?? 96)));
  const recent = input.candles.slice(-lookback);
  const last = recent.at(-1);
  const warnings: string[] = [];

  if (!last || recent.length < 20) {
    return {
      symbol: input.symbol,
      strategy: "adaptive-grid",
      riskMode,
      currentPrice: 0,
      rangeLow: 0,
      rangeHigh: 0,
      rangePct: 0,
      capitalQuote,
      allocatedCapitalQuote: 0,
      levels: [],
      warnings: ["not enough candles for grid plan"],
    };
  }

  const rangeLow = Math.min(...recent.map((candle) => candle.low));
  const rangeHigh = Math.max(...recent.map((candle) => candle.high));
  const currentPrice = last.close;
  const rangePct = currentPrice > 0 ? (rangeHigh - rangeLow) / currentPrice : 0;
  if (rangePct < 0.012) {
    warnings.push("range is too compressed for a clean grid");
  }
  if (rangePct > 0.12) {
    warnings.push("range is too wide for a medium-risk grid");
  }
  if (leverage >= 50) {
    warnings.push("grid leverage is high; reduce size or widen liquidation buffer");
  }
  if (capitalQuote <= 0) {
    warnings.push("capital budget must be positive");
  }

  if (warnings.some((warning) => warning.includes("compressed")) || capitalQuote <= 0) {
    return {
      symbol: input.symbol,
      strategy: "adaptive-grid",
      riskMode,
      currentPrice: round(currentPrice),
      rangeLow: round(rangeLow),
      rangeHigh: round(rangeHigh),
      rangePct: round(rangePct, 5),
      capitalQuote,
      allocatedCapitalQuote: 0,
      levels: [],
      warnings,
    };
  }

  const usableCapital = round(capitalQuote * maxCapitalPct, 2);
  const marginPerLevel = round(usableCapital / gridCount, 2);
  const step = (rangeHigh - rangeLow) / (gridCount + 1);
  const midpoint = (rangeHigh + rangeLow) / 2;
  const levels: AdaptiveGridLevel[] = [];

  for (let i = 1; i <= gridCount; i += 1) {
    const entry = rangeLow + step * i;
    if (entry < midpoint) {
      levels.push({
        side: "long",
        entryPrice: round(entry),
        takeProfitPrice: round(Math.min(entry + step, rangeHigh)),
        stopLossPrice: round(rangeLow - step),
        marginQuote: marginPerLevel,
        notionalQuote: round(marginPerLevel * leverage, 2),
        leverage,
      });
    } else {
      levels.push({
        side: "short",
        entryPrice: round(entry),
        takeProfitPrice: round(Math.max(entry - step, rangeLow)),
        stopLossPrice: round(rangeHigh + step),
        marginQuote: marginPerLevel,
        notionalQuote: round(marginPerLevel * leverage, 2),
        leverage,
      });
    }
  }

  return {
    symbol: input.symbol,
    strategy: "adaptive-grid",
    riskMode,
    currentPrice: round(currentPrice),
    rangeLow: round(rangeLow),
    rangeHigh: round(rangeHigh),
    rangePct: round(rangePct, 5),
    capitalQuote,
    allocatedCapitalQuote: usableCapital,
    levels,
    warnings,
  };
}
