import {
  MarketScanSchema,
  TradeIdeaSchema,
  type MarketCandle,
  type MarketScan,
  type StrategySignal,
  type TradeIdea,
} from "@kr8tiv/shared-schemas";
import { atr, ema, macd, rsi } from "./indicators.js";

const SUPPORTED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const MIN_HISTORY = 60;

export interface AnalyzeMarketInput {
  symbol: string;
  market: "mexc-futures";
  shortTimeframe: string;
  longTimeframe: string;
  shortCandles: MarketCandle[];
  longCandles: MarketCandle[];
}

type SwingPoint = { index: number; value: number };

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function findSwingLows(values: number[], lookback = 20): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const start = Math.max(1, values.length - lookback);
  for (let i = start; i < values.length - 1; i += 1) {
    const current = values[i];
    if (
      current !== undefined &&
      current < (values[i - 1] ?? current) &&
      current < (values[i + 1] ?? current)
    ) {
      swings.push({ index: i, value: current });
    }
  }
  return swings.slice(-2);
}

function findSwingHighs(values: number[], lookback = 20): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const start = Math.max(1, values.length - lookback);
  for (let i = start; i < values.length - 1; i += 1) {
    const current = values[i];
    if (
      current !== undefined &&
      current > (values[i - 1] ?? current) &&
      current > (values[i + 1] ?? current)
    ) {
      swings.push({ index: i, value: current });
    }
  }
  return swings.slice(-2);
}

function regimeFromTrend(candles: MarketCandle[]): "bullish" | "bearish" | "range" {
  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const current = closes.at(-1) ?? 0;
  const fast = ema20.at(-1) ?? current;
  const slow = ema50.at(-1) ?? current;

  if (current > fast && fast > slow) return "bullish";
  if (current < fast && fast < slow) return "bearish";
  return "range";
}

function buildTrendSignal(
  candles: MarketCandle[],
  timeframe: string,
): StrategySignal {
  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const current = closes.at(-1) ?? 0;
  const fast = ema20.at(-1) ?? current;
  const slow = ema50.at(-1) ?? current;
  const regime = regimeFromTrend(candles);

  if (regime === "bullish") {
    return {
      strategy: "trend-filter",
      timeframe,
      bias: "long",
      confidence: 0.78,
      summary: "price is above the 20 EMA and the 20 EMA is above the 50 EMA",
      metrics: { price: current, ema20: fast, ema50: slow },
    };
  }
  if (regime === "bearish") {
    return {
      strategy: "trend-filter",
      timeframe,
      bias: "short",
      confidence: 0.78,
      summary: "price is below the 20 EMA and the 20 EMA is below the 50 EMA",
      metrics: { price: current, ema20: fast, ema50: slow },
    };
  }
  return {
    strategy: "trend-filter",
    timeframe,
    bias: "neutral",
    confidence: 0.45,
    summary: "higher timeframe is ranging between the fast and slow trend filters",
    metrics: { price: current, ema20: fast, ema50: slow },
  };
}

function buildRsiSignal(
  candles: MarketCandle[],
  timeframe: string,
): StrategySignal {
  const closes = candles.map((candle) => candle.close);
  const values = rsi(closes, 14);
  const current = values.at(-1) ?? 50;

  const priceLows = findSwingLows(closes);
  const rsiLows = findSwingLows(values);
  if (
    priceLows.length >= 2 &&
    rsiLows.length >= 2 &&
    (priceLows[1]?.value ?? 0) < (priceLows[0]?.value ?? 0) &&
    (rsiLows[1]?.value ?? 0) > (rsiLows[0]?.value ?? 0)
  ) {
    return {
      strategy: "rsi-divergence",
      timeframe,
      bias: "long",
      confidence: 0.82,
      summary: "price made a lower low while RSI made a higher low",
      metrics: { rsi: current },
    };
  }

  const priceHighs = findSwingHighs(closes);
  const rsiHighs = findSwingHighs(values);
  if (
    priceHighs.length >= 2 &&
    rsiHighs.length >= 2 &&
    (priceHighs[1]?.value ?? 0) > (priceHighs[0]?.value ?? 0) &&
    (rsiHighs[1]?.value ?? 0) < (rsiHighs[0]?.value ?? 0)
  ) {
    return {
      strategy: "rsi-divergence",
      timeframe,
      bias: "short",
      confidence: 0.82,
      summary: "price made a higher high while RSI made a lower high",
      metrics: { rsi: current },
    };
  }

  if (current <= 25) {
    return {
      strategy: "rsi-divergence",
      timeframe,
      bias: "long",
      confidence: 0.48,
      summary: "RSI is stretched into the lower band and primed for a bounce",
      metrics: { rsi: current },
    };
  }
  if (current >= 75) {
    return {
      strategy: "rsi-divergence",
      timeframe,
      bias: "short",
      confidence: 0.48,
      summary: "RSI is stretched into the upper band and vulnerable to fade",
      metrics: { rsi: current },
    };
  }

  return {
    strategy: "rsi-divergence",
    timeframe,
    bias: "neutral",
    confidence: 0.4,
    summary: "RSI is balanced and not showing a clean divergence edge",
    metrics: { rsi: current },
  };
}

function buildMacdSignal(
  candles: MarketCandle[],
  timeframe: string,
): StrategySignal {
  const closes = candles.map((candle) => candle.close);
  const values = macd(closes);

  const macdNow = values.macd.at(-1) ?? 0;
  const macdPrev = values.macd.at(-2) ?? macdNow;
  const signalNow = values.signal.at(-1) ?? 0;
  const signalPrev = values.signal.at(-2) ?? signalNow;
  const histogramNow = values.histogram.at(-1) ?? 0;
  const histogramPrev = values.histogram.at(-2) ?? histogramNow;

  if (macdPrev <= signalPrev && macdNow > signalNow) {
    return {
      strategy: "macd-crossover",
      timeframe,
      bias: "long",
      confidence: 0.74,
      summary: "MACD crossed above the signal line and momentum flipped positive",
      metrics: {
        macd: macdNow,
        signal: signalNow,
        histogram: histogramNow,
      },
    };
  }
  if (macdPrev >= signalPrev && macdNow < signalNow) {
    return {
      strategy: "macd-crossover",
      timeframe,
      bias: "short",
      confidence: 0.74,
      summary: "MACD crossed below the signal line and downside momentum took over",
      metrics: {
        macd: macdNow,
        signal: signalNow,
        histogram: histogramNow,
      },
    };
  }
  if (macdNow > signalNow && histogramNow > 0) {
    return {
      strategy: "macd-crossover",
      timeframe,
      bias: "long",
      confidence: 0.58,
      summary: "MACD histogram remains positive and is still building",
      metrics: {
        macd: macdNow,
        signal: signalNow,
        histogram: histogramNow,
      },
    };
  }
  if (macdNow < signalNow && histogramNow < 0) {
    return {
      strategy: "macd-crossover",
      timeframe,
      bias: "short",
      confidence: 0.58,
      summary: "MACD histogram remains negative and is still deepening",
      metrics: {
        macd: macdNow,
        signal: signalNow,
        histogram: histogramNow,
      },
    };
  }

  return {
    strategy: "macd-crossover",
    timeframe,
    bias: "neutral",
    confidence: 0.42,
    summary: "MACD is flat and not showing an actionable crossover",
    metrics: {
      macd: macdNow,
      signal: signalNow,
      histogram: histogramNow,
    },
  };
}

function buildBreakoutSignal(
  candles: MarketCandle[],
  timeframe: string,
): StrategySignal {
  const recent = candles.slice(-21);
  const last = recent.at(-1);
  if (!last || recent.length < 21) {
    return {
      strategy: "breakout",
      timeframe,
      bias: "neutral",
      confidence: 0.35,
      summary: "not enough candles to judge breakout structure",
    };
  }

  const prior = recent.slice(0, -1);
  const resistance = Math.max(...prior.map((candle) => candle.high));
  const support = Math.min(...prior.map((candle) => candle.low));
  const avgVolume = average(prior.map((candle) => candle.volume));
  const volumeRatio =
    avgVolume <= 0 ? 0 : last.volume / Math.max(avgVolume, Number.EPSILON);

  if (last.close > resistance * 1.001 && volumeRatio >= 1.05) {
    return {
      strategy: "breakout",
      timeframe,
      bias: "long",
      confidence: 0.78,
      summary: "price closed above resistance with above-average volume",
      metrics: { resistance, support, volumeRatio },
    };
  }
  if (last.close < support * 0.999 && volumeRatio >= 1.05) {
    return {
      strategy: "breakout",
      timeframe,
      bias: "short",
      confidence: 0.78,
      summary: "price closed below support with above-average volume",
      metrics: { resistance, support, volumeRatio },
    };
  }

  return {
    strategy: "breakout",
    timeframe,
    bias: "neutral",
    confidence: 0.45,
    summary: "price is still inside the recent range or the breakout lacks volume",
    metrics: { resistance, support, volumeRatio },
  };
}

function scoreForBias(signal: StrategySignal, bias: "long" | "short"): number {
  if (signal.bias === bias) return signal.confidence;
  if (signal.bias === "neutral") return 0.15 * signal.confidence;
  return -0.3 * signal.confidence;
}

function buildIdea(params: {
  symbol: string;
  market: "mexc-futures";
  direction: "long" | "short";
  horizon: "scalp" | "swing";
  currentPrice: number;
  atrValue: number;
  support: number;
  resistance: number;
  confidence: number;
  strategies: StrategySignal[];
}): TradeIdea {
  const atrRisk = Math.max(params.atrValue, params.currentPrice * 0.004);
  const multiplier = params.horizon === "swing" ? 1.8 : 1.1;
  const risk = atrRisk * multiplier;

  const invalidationPrice =
    params.direction === "long"
      ? Math.min(params.support, params.currentPrice - risk)
      : Math.max(params.resistance, params.currentPrice + risk);

  const rewardOne = risk * (params.horizon === "swing" ? 2.2 : 1.5);
  const rewardTwo = risk * (params.horizon === "swing" ? 3.2 : 2.4);
  const targets =
    params.direction === "long"
      ? [params.currentPrice + rewardOne, params.currentPrice + rewardTwo]
      : [params.currentPrice - rewardOne, params.currentPrice - rewardTwo];

  const alignedStrategies = params.strategies.filter(
    (signal) => signal.bias === params.direction,
  );
  const reasons = alignedStrategies
    .slice(0, 3)
    .map((signal) => signal.summary.toLowerCase());
  const thesis = `${params.horizon} ${params.direction} bias: ${reasons.join("; ")}`;

  return TradeIdeaSchema.parse({
    symbol: params.symbol,
    market: params.market,
    direction: params.direction,
    horizon: params.horizon,
    confidence: clamp(params.confidence, 0.4, 0.95),
    entryPrice: params.currentPrice,
    invalidationPrice,
    targets,
    thesis,
    reasons: reasons.length > 0 ? reasons : ["trend and momentum are aligned"],
    strategies: alignedStrategies,
  });
}

export function analyzeMarket(input: AnalyzeMarketInput): MarketScan {
  if (!SUPPORTED_SYMBOLS.has(input.symbol)) {
    throw new Error(`unsupported signal-engine symbol: ${input.symbol}`);
  }

  const warnings: string[] = [];
  if (
    input.shortCandles.length < MIN_HISTORY ||
    input.longCandles.length < MIN_HISTORY
  ) {
    warnings.push(
      `insufficient history: need at least ${MIN_HISTORY} candles on both timeframes`,
    );
    return MarketScanSchema.parse({
      symbol: input.symbol,
      market: input.market,
      currentPrice: input.shortCandles.at(-1)?.close ?? 0.0001,
      regime: "range",
      warnings,
      strategies: [],
      ideas: [],
    });
  }

  const currentPrice = input.shortCandles.at(-1)?.close ?? 0.0001;
  const regime = regimeFromTrend(input.longCandles);
  const trendSignal = buildTrendSignal(input.longCandles, input.longTimeframe);
  const rsiSignal = buildRsiSignal(input.shortCandles, input.shortTimeframe);
  const macdSignal = buildMacdSignal(input.shortCandles, input.shortTimeframe);
  const breakoutSignal = buildBreakoutSignal(
    input.shortCandles,
    input.shortTimeframe,
  );
  const strategies = [trendSignal, rsiSignal, macdSignal, breakoutSignal];

  const longScore = strategies.reduce(
    (sum, signal) => sum + scoreForBias(signal, "long"),
    regime === "bullish" ? 0.75 : 0,
  );
  const shortScore = strategies.reduce(
    (sum, signal) => sum + scoreForBias(signal, "short"),
    regime === "bearish" ? 0.75 : 0,
  );

  const recentShort = input.shortCandles.slice(-20);
  const support = Math.min(...recentShort.map((candle) => candle.low));
  const resistance = Math.max(...recentShort.map((candle) => candle.high));
  const atrValue = atr(input.shortCandles, 14).at(-1) ?? currentPrice * 0.004;
  const ideas: TradeIdea[] = [];

  if (longScore >= 1.8 && longScore > shortScore + 0.25) {
    ideas.push(
      buildIdea({
        symbol: input.symbol,
        market: input.market,
        direction: "long",
        horizon: "scalp",
        currentPrice,
        atrValue,
        support,
        resistance,
        confidence: longScore / 3.2,
        strategies,
      }),
    );
  }
  if (shortScore >= 1.8 && shortScore > longScore + 0.25) {
    ideas.push(
      buildIdea({
        symbol: input.symbol,
        market: input.market,
        direction: "short",
        horizon: "scalp",
        currentPrice,
        atrValue,
        support,
        resistance,
        confidence: shortScore / 3.2,
        strategies,
      }),
    );
  }
  if (regime === "bullish" && longScore >= 2.0) {
    ideas.push(
      buildIdea({
        symbol: input.symbol,
        market: input.market,
        direction: "long",
        horizon: "swing",
        currentPrice,
        atrValue,
        support,
        resistance,
        confidence: longScore / 3,
        strategies,
      }),
    );
  }
  if (regime === "bearish" && shortScore >= 2.0) {
    ideas.push(
      buildIdea({
        symbol: input.symbol,
        market: input.market,
        direction: "short",
        horizon: "swing",
        currentPrice,
        atrValue,
        support,
        resistance,
        confidence: shortScore / 3,
        strategies,
      }),
    );
  }

  return MarketScanSchema.parse({
    symbol: input.symbol,
    market: input.market,
    currentPrice,
    regime,
    warnings,
    strategies,
    ideas,
  });
}
