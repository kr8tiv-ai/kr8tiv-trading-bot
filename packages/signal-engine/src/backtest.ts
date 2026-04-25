import type { MarketCandle } from "@kr8tiv/shared-schemas";
import { atr, ema, rsi } from "./indicators.js";

export type BacktestTrade = {
  direction: "long" | "short";
  entryTimeMs: number;
  exitTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  exitReason: "target" | "stop" | "end";
};

export type BacktestStrategyName =
  | "breakout-trailing"
  | "adaptive-grid"
  | "ema-pullback";

export type BreakoutBacktestOptions = {
  lookback?: number;
  volumeRatio?: number;
  riskMultipleTarget?: number;
  feeRate?: number;
};

export type GridBacktestOptions = {
  lookback?: number;
  gridSpacingPct?: number;
  stopGridSteps?: number;
  feeRate?: number;
};

export type EmaPullbackBacktestOptions = {
  lookback?: number;
  riskMultipleTarget?: number;
  feeRate?: number;
};

export type StrategyBacktestResult = {
  strategy: BacktestStrategyName;
  trades: BacktestTrade[];
  netPnlPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  warnings: string[];
};

export type BreakoutBacktestResult = StrategyBacktestResult & {
  strategy: "breakout-trailing";
};

export type GridBacktestResult = StrategyBacktestResult & {
  strategy: "adaptive-grid";
};

export type EmaPullbackBacktestResult = StrategyBacktestResult & {
  strategy: "ema-pullback";
};

export type StrategyBacktestComparison = {
  results: StrategyBacktestResult[];
  best: StrategyBacktestResult | null;
  recommendation: string;
};

type OpenPosition = {
  direction: "long" | "short";
  entryTimeMs: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskDistance: number;
};

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function tradePnlPct(
  position: OpenPosition,
  exitPrice: number,
  feeRate: number,
): number {
  const raw =
    position.direction === "long"
      ? (exitPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - exitPrice) / position.entryPrice;
  return round((raw - feeRate * 2) * 100);
}

function summarize<TStrategy extends BacktestStrategyName>(
  strategy: TStrategy,
  trades: BacktestTrade[],
  warnings: string[],
): StrategyBacktestResult & { strategy: TStrategy } {
  const netPnlPct = trades.reduce((sum, trade) => sum + trade.pnlPct, 0);
  const wins = trades.filter((trade) => trade.pnlPct > 0);
  const losses = trades.filter((trade) => trade.pnlPct <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlPct, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.pnlPct;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  return {
    strategy,
    trades,
    netPnlPct: round(netPnlPct),
    winRate: trades.length > 0 ? round(wins.length / trades.length, 4) : 0,
    profitFactor:
      grossLoss > 0
        ? round(grossProfit / grossLoss, 4)
        : grossProfit > 0
          ? round(grossProfit, 4)
          : 0,
    maxDrawdownPct: round(maxDrawdown),
    warnings,
  };
}

export function backtestBreakoutTrailing(
  candles: MarketCandle[],
  options: BreakoutBacktestOptions = {},
): BreakoutBacktestResult {
  const lookback = options.lookback ?? 20;
  const requiredVolumeRatio = options.volumeRatio ?? 1.05;
  const targetMultiple = options.riskMultipleTarget ?? 2;
  const feeRate = options.feeRate ?? 0.0006;
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];

  if (candles.length < lookback + 3) {
    return summarize("breakout-trailing", [], [
      "not enough candles for breakout backtest",
    ]);
  }

  const atrValues = atr(candles, 14);
  let position: OpenPosition | null = null;

  for (let i = lookback; i < candles.length; i += 1) {
    const candle = candles[i]!;

    if (position) {
      const oneR =
        position.direction === "long"
          ? position.entryPrice + position.riskDistance
          : position.entryPrice - position.riskDistance;
      const trailTrigger =
        position.direction === "long"
          ? position.entryPrice + position.riskDistance * 1.5
          : position.entryPrice - position.riskDistance * 1.5;

      if (position.direction === "long") {
        if (candle.high >= oneR) {
          position.stopPrice = Math.max(position.stopPrice, position.entryPrice);
        }
        if (candle.high >= trailTrigger) {
          position.stopPrice = Math.max(
            position.stopPrice,
            candle.high - position.riskDistance,
          );
        }
        if (candle.low <= position.stopPrice || candle.high >= position.targetPrice) {
          const exitPrice =
            candle.high >= position.targetPrice
              ? position.targetPrice
              : position.stopPrice;
          trades.push({
            direction: "long",
            entryTimeMs: position.entryTimeMs,
            exitTimeMs: candle.closeTimeMs,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: tradePnlPct(position, exitPrice, feeRate),
            exitReason: exitPrice === position.targetPrice ? "target" : "stop",
          });
          position = null;
        }
      } else {
        if (candle.low <= oneR) {
          position.stopPrice = Math.min(position.stopPrice, position.entryPrice);
        }
        if (candle.low <= trailTrigger) {
          position.stopPrice = Math.min(
            position.stopPrice,
            candle.low + position.riskDistance,
          );
        }
        if (candle.high >= position.stopPrice || candle.low <= position.targetPrice) {
          const exitPrice =
            candle.low <= position.targetPrice
              ? position.targetPrice
              : position.stopPrice;
          trades.push({
            direction: "short",
            entryTimeMs: position.entryTimeMs,
            exitTimeMs: candle.closeTimeMs,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: tradePnlPct(position, exitPrice, feeRate),
            exitReason: exitPrice === position.targetPrice ? "target" : "stop",
          });
          position = null;
        }
      }
      continue;
    }

    const prior = candles.slice(i - lookback, i);
    const resistance = Math.max(...prior.map((item) => item.high));
    const support = Math.min(...prior.map((item) => item.low));
    const avgVolume = average(prior.map((item) => item.volume));
    const volumeRatio = avgVolume <= 0 ? 0 : candle.volume / avgVolume;
    const riskDistance = Math.max(
      atrValues[i] ?? candle.close * 0.004,
      candle.close * 0.004,
    );

    if (candle.close > resistance * 1.001 && volumeRatio >= requiredVolumeRatio) {
      position = {
        direction: "long",
        entryTimeMs: candle.closeTimeMs,
        entryPrice: candle.close,
        stopPrice: candle.close - riskDistance,
        targetPrice: candle.close + riskDistance * targetMultiple,
        riskDistance,
      };
    } else if (
      candle.close < support * 0.999 &&
      volumeRatio >= requiredVolumeRatio
    ) {
      position = {
        direction: "short",
        entryTimeMs: candle.closeTimeMs,
        entryPrice: candle.close,
        stopPrice: candle.close + riskDistance,
        targetPrice: candle.close - riskDistance * targetMultiple,
        riskDistance,
      };
    }
  }

  const last = candles.at(-1);
  if (position && last) {
    trades.push({
      direction: position.direction,
      entryTimeMs: position.entryTimeMs,
      exitTimeMs: last.closeTimeMs,
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      pnlPct: tradePnlPct(position, last.close, feeRate),
      exitReason: "end",
    });
    warnings.push("last position closed at final candle for reporting");
  }

  return summarize("breakout-trailing", trades, warnings);
}

export function backtestAdaptiveGrid(
  candles: MarketCandle[],
  options: GridBacktestOptions = {},
): GridBacktestResult {
  const lookback = options.lookback ?? 48;
  const gridSpacingPct = options.gridSpacingPct ?? 0.006;
  const stopGridSteps = options.stopGridSteps ?? 4;
  const feeRate = options.feeRate ?? 0.0006;
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];

  if (candles.length < lookback + 3) {
    return summarize("adaptive-grid", [], ["not enough candles for grid backtest"]);
  }

  let position: OpenPosition | null = null;

  for (let i = lookback; i < candles.length; i += 1) {
    const candle = candles[i]!;

    if (position) {
      if (position.direction === "long") {
        const exitPrice =
          candle.high >= position.targetPrice
            ? position.targetPrice
            : candle.low <= position.stopPrice
              ? position.stopPrice
              : null;
        if (exitPrice !== null) {
          trades.push({
            direction: "long",
            entryTimeMs: position.entryTimeMs,
            exitTimeMs: candle.closeTimeMs,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: tradePnlPct(position, exitPrice, feeRate),
            exitReason: exitPrice === position.targetPrice ? "target" : "stop",
          });
          position = null;
        }
      } else {
        const exitPrice =
          candle.low <= position.targetPrice
            ? position.targetPrice
            : candle.high >= position.stopPrice
              ? position.stopPrice
              : null;
        if (exitPrice !== null) {
          trades.push({
            direction: "short",
            entryTimeMs: position.entryTimeMs,
            exitTimeMs: candle.closeTimeMs,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: tradePnlPct(position, exitPrice, feeRate),
            exitReason: exitPrice === position.targetPrice ? "target" : "stop",
          });
          position = null;
        }
      }
      continue;
    }

    const prior = candles.slice(i - lookback, i);
    const rangeHigh = Math.max(...prior.map((item) => item.high));
    const rangeLow = Math.min(...prior.map((item) => item.low));
    const midpoint = (rangeHigh + rangeLow) / 2;
    const rangePct = midpoint > 0 ? (rangeHigh - rangeLow) / midpoint : 0;
    const minUsableRange = gridSpacingPct * 2.25;
    if (rangePct < minUsableRange) {
      continue;
    }

    const lowerGrid = midpoint * (1 - gridSpacingPct);
    const upperGrid = midpoint * (1 + gridSpacingPct);
    const stopDistance = midpoint * gridSpacingPct * stopGridSteps;

    if (candle.low <= lowerGrid) {
      position = {
        direction: "long",
        entryTimeMs: candle.closeTimeMs,
        entryPrice: lowerGrid,
        stopPrice: lowerGrid - stopDistance,
        targetPrice: lowerGrid * (1 + gridSpacingPct),
        riskDistance: stopDistance,
      };
    } else if (candle.high >= upperGrid) {
      position = {
        direction: "short",
        entryTimeMs: candle.closeTimeMs,
        entryPrice: upperGrid,
        stopPrice: upperGrid + stopDistance,
        targetPrice: upperGrid * (1 - gridSpacingPct),
        riskDistance: stopDistance,
      };
    }
  }

  const last = candles.at(-1);
  if (position && last) {
    trades.push({
      direction: position.direction,
      entryTimeMs: position.entryTimeMs,
      exitTimeMs: last.closeTimeMs,
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      pnlPct: tradePnlPct(position, last.close, feeRate),
      exitReason: "end",
    });
    warnings.push("last grid position closed at final candle for reporting");
  }

  return summarize("adaptive-grid", trades, warnings);
}

export function backtestEmaPullback(
  candles: MarketCandle[],
  options: EmaPullbackBacktestOptions = {},
): EmaPullbackBacktestResult {
  const lookback = options.lookback ?? 50;
  const targetMultiple = options.riskMultipleTarget ?? 1.6;
  const feeRate = options.feeRate ?? 0.0006;
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];

  if (candles.length < Math.max(lookback, 55) + 3) {
    return summarize("ema-pullback", [], [
      "not enough candles for EMA pullback backtest",
    ]);
  }

  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  let position: OpenPosition | null = null;

  for (let i = Math.max(lookback, 50); i < candles.length; i += 1) {
    const candle = candles[i]!;

    if (position) {
      if (position.direction === "long") {
        const exitPrice =
          candle.high >= position.targetPrice
            ? position.targetPrice
            : candle.low <= position.stopPrice
              ? position.stopPrice
              : null;
        if (exitPrice !== null) {
          trades.push({
            direction: "long",
            entryTimeMs: position.entryTimeMs,
            exitTimeMs: candle.closeTimeMs,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: tradePnlPct(position, exitPrice, feeRate),
            exitReason: exitPrice === position.targetPrice ? "target" : "stop",
          });
          position = null;
        }
      } else {
        const exitPrice =
          candle.low <= position.targetPrice
            ? position.targetPrice
            : candle.high >= position.stopPrice
              ? position.stopPrice
              : null;
        if (exitPrice !== null) {
          trades.push({
            direction: "short",
            entryTimeMs: position.entryTimeMs,
            exitTimeMs: candle.closeTimeMs,
            entryPrice: position.entryPrice,
            exitPrice,
            pnlPct: tradePnlPct(position, exitPrice, feeRate),
            exitReason: exitPrice === position.targetPrice ? "target" : "stop",
          });
          position = null;
        }
      }
      continue;
    }

    const fast = ema20[i] ?? candle.close;
    const slow = ema50[i] ?? candle.close;
    const momentum = rsi14[i] ?? 50;
    const riskDistance = Math.max(
      atr14[i] ?? candle.close * 0.005,
      candle.close * 0.005,
    );

    const bullishTrend = fast > slow && candle.close > slow;
    const bearishTrend = fast < slow && candle.close < slow;
    const longReclaim =
      bullishTrend &&
      candle.low <= fast * 1.01 &&
      candle.close > fast &&
      candle.close > candle.open &&
      momentum >= 42;
    const shortReject =
      bearishTrend &&
      candle.high >= fast * 0.99 &&
      candle.close < fast &&
      candle.close < candle.open &&
      momentum <= 58;

    if (longReclaim) {
      position = {
        direction: "long",
        entryTimeMs: candle.closeTimeMs,
        entryPrice: candle.close,
        stopPrice: candle.close - riskDistance,
        targetPrice: candle.close + riskDistance * targetMultiple,
        riskDistance,
      };
    } else if (shortReject) {
      position = {
        direction: "short",
        entryTimeMs: candle.closeTimeMs,
        entryPrice: candle.close,
        stopPrice: candle.close + riskDistance,
        targetPrice: candle.close - riskDistance * targetMultiple,
        riskDistance,
      };
    }
  }

  const last = candles.at(-1);
  if (position && last) {
    trades.push({
      direction: position.direction,
      entryTimeMs: position.entryTimeMs,
      exitTimeMs: last.closeTimeMs,
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      pnlPct: tradePnlPct(position, last.close, feeRate),
      exitReason: "end",
    });
    warnings.push("last EMA pullback position closed at final candle for reporting");
  }

  return summarize("ema-pullback", trades, warnings);
}

function strategyScore(result: StrategyBacktestResult): number {
  const tradePenalty = result.trades.length === 0 ? 2 : 0;
  const profitFactorBonus = Math.min(result.profitFactor, 3) * 0.25;
  return result.netPnlPct - result.maxDrawdownPct * 0.65 + profitFactorBonus - tradePenalty;
}

export function compareBacktestStrategies(
  candles: MarketCandle[],
  options: BreakoutBacktestOptions &
    GridBacktestOptions &
    EmaPullbackBacktestOptions = {},
): StrategyBacktestComparison {
  const breakout = backtestBreakoutTrailing(candles, options);
  const grid = backtestAdaptiveGrid(candles, options);
  const pullback = backtestEmaPullback(candles, options);
  const results = [breakout, grid, pullback].sort(
    (a, b) => strategyScore(b) - strategyScore(a),
  );
  const best =
    results.find((result) => result.trades.length > 0 && result.netPnlPct > 0) ??
    null;

  const recommendation =
    best?.strategy === "adaptive-grid"
      ? "range conditions are scoring better for adaptive futures grid planning"
      : best?.strategy === "breakout-trailing"
        ? "momentum conditions are scoring better for breakout + trailing-stop planning"
        : best?.strategy === "ema-pullback"
          ? "medium-risk trend pullbacks are scoring better than breakout or grid"
          : "No strategy edge is positive on this replay; protect capital and wait.";

  return {
    results,
    best,
    recommendation,
  };
}
