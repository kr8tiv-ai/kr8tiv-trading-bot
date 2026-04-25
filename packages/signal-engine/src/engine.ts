import {
  type MarketCandle,
  type MarketScan,
  MarketScanSchema,
  type MexcFuturesMarketContext,
  type StrategySignal,
  type TradeIdea,
  TradeIdeaSchema,
} from "@kr8tiv/shared-schemas";
import { atr, ema, macd, rsi } from "./indicators.js";
import { buildVolumeProfile } from "./volume-profile.js";

const SUPPORTED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const MIN_HISTORY = 60;

export interface AnalyzeMarketInput {
  symbol: string;
  market: "mexc-futures";
  shortTimeframe: string;
  longTimeframe: string;
  shortCandles: MarketCandle[];
  longCandles: MarketCandle[];
  marketContext?: MexcFuturesMarketContext;
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

function buildTrendSignal(candles: MarketCandle[], timeframe: string): StrategySignal {
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

function buildRsiSignal(candles: MarketCandle[], timeframe: string): StrategySignal {
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

function buildMacdSignal(candles: MarketCandle[], timeframe: string): StrategySignal {
  const closes = candles.map((candle) => candle.close);
  const values = macd(closes);

  const macdNow = values.macd.at(-1) ?? 0;
  const macdPrev = values.macd.at(-2) ?? macdNow;
  const signalNow = values.signal.at(-1) ?? 0;
  const signalPrev = values.signal.at(-2) ?? signalNow;
  const histogramNow = values.histogram.at(-1) ?? 0;

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

function buildEmaPullbackSignal(candles: MarketCandle[], timeframe: string): StrategySignal {
  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const current = candles.at(-1);
  if (!current || candles.length < 55) {
    return {
      strategy: "ema-pullback",
      timeframe,
      bias: "neutral",
      confidence: 0.34,
      summary: "not enough candles to judge medium EMA pullback structure",
    };
  }

  const fast = ema20.at(-1) ?? current.close;
  const slow = ema50.at(-1) ?? current.close;
  const momentum = rsi14.at(-1) ?? 50;
  const metrics = { price: current.close, ema20: fast, ema50: slow, rsi: momentum };

  const bullishTrend = fast > slow && current.close > slow;
  const bearishTrend = fast < slow && current.close < slow;
  const longReclaim =
    bullishTrend &&
    current.low <= fast * 1.01 &&
    current.close > fast &&
    current.close > current.open &&
    momentum >= 42;
  const shortReject =
    bearishTrend &&
    current.high >= fast * 0.99 &&
    current.close < fast &&
    current.close < current.open &&
    momentum <= 58;

  if (longReclaim) {
    return {
      strategy: "ema-pullback",
      timeframe,
      bias: "long",
      confidence: 0.69,
      summary:
        "medium-risk long pullback: price tagged/reclaimed the 20 EMA while the 50 EMA trend stayed supportive",
      metrics,
    };
  }
  if (shortReject) {
    return {
      strategy: "ema-pullback",
      timeframe,
      bias: "short",
      confidence: 0.69,
      summary:
        "medium-risk short pullback: price rejected the 20 EMA while the 50 EMA trend stayed bearish",
      metrics,
    };
  }

  return {
    strategy: "ema-pullback",
    timeframe,
    bias: "neutral",
    confidence: bullishTrend || bearishTrend ? 0.5 : 0.38,
    summary: "medium EMA pullback is not clean yet; wait for reclaim/rejection at trend support",
    metrics,
  };
}

function buildBreakoutSignal(candles: MarketCandle[], timeframe: string): StrategySignal {
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
  const volumeRatio = avgVolume <= 0 ? 0 : last.volume / Math.max(avgVolume, Number.EPSILON);

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

function buildAdaptiveGridSignal(candles: MarketCandle[], timeframe: string): StrategySignal {
  const recent = candles.slice(-36);
  const last = recent.at(-1);
  if (!last || recent.length < 36) {
    return {
      strategy: "adaptive-grid",
      timeframe,
      bias: "neutral",
      confidence: 0.34,
      summary: "not enough candles to judge adaptive grid structure",
    };
  }

  const rangeHigh = Math.max(...recent.map((candle) => candle.high));
  const rangeLow = Math.min(...recent.map((candle) => candle.low));
  const range = rangeHigh - rangeLow;
  const rangePct = last.close > 0 ? range / last.close : 0;
  const atrValue = atr(candles, 14).at(-1) ?? last.close * 0.004;
  const atrPct = last.close > 0 ? atrValue / last.close : 0;
  const lowerZone = rangeLow + range * 0.32;
  const upperZone = rangeHigh - range * 0.32;
  const metrics = {
    lowerGrid: rangeLow,
    upperGrid: rangeHigh,
    rangePct,
    atrPct,
  };

  if (rangePct < 0.012) {
    return {
      strategy: "adaptive-grid",
      timeframe,
      bias: "neutral",
      confidence: 0.38,
      summary: "range is too compressed for a healthy futures grid",
      metrics,
    };
  }
  if (rangePct > 0.08) {
    return {
      strategy: "adaptive-grid",
      timeframe,
      bias: "neutral",
      confidence: 0.36,
      summary: "range is too wide; grid would need oversized stops",
      metrics,
    };
  }

  if (last.close <= lowerZone) {
    return {
      strategy: "adaptive-grid",
      timeframe,
      bias: "long",
      confidence: 0.62,
      summary: "price is near the lower grid band inside a tradable futures range",
      metrics,
    };
  }
  if (last.close >= upperZone) {
    return {
      strategy: "adaptive-grid",
      timeframe,
      bias: "short",
      confidence: 0.62,
      summary: "price is near the upper grid band inside a tradable futures range",
      metrics,
    };
  }

  return {
    strategy: "adaptive-grid",
    timeframe,
    bias: "neutral",
    confidence: 0.48,
    summary: "price is mid-range; grid is watch-only until an edge band is tagged",
    metrics,
  };
}

function buildVolumeProfileSignal(candles: MarketCandle[], timeframe: string): StrategySignal {
  const profile = buildVolumeProfile(candles, {
    lookback: 80,
    binCount: 24,
  });
  const current = candles.at(-1);
  if (!profile || !current) {
    return {
      strategy: "volume-profile",
      timeframe,
      bias: "neutral",
      confidence: 0.34,
      summary: "not enough candle volume to build a useful volume profile",
    };
  }

  const metrics = {
    pointOfControl: profile.pointOfControl,
    valueAreaHigh: profile.valueAreaHigh,
    valueAreaLow: profile.valueAreaLow,
    supportLevel: profile.supportLevel ?? 0,
    resistanceLevel: profile.resistanceLevel ?? 0,
    pocSignificance: profile.pocSignificance,
    inValueArea: profile.inValueArea ? 1 : 0,
    inLowVolumeZone: profile.inLowVolumeZone ? 1 : 0,
  };
  const band = Math.max(profile.binSizePct * 1.5, 0.006);
  const nearValueLow = current.low <= profile.valueAreaLow * (1 + band);
  const nearValueHigh = current.high >= profile.valueAreaHigh * (1 - band);
  const bullishBounce = nearValueLow && current.close > current.open;
  const bearishReject = nearValueHigh && current.close < current.open;
  const aboveValueBreakout = profile.inLowVolumeZone && current.close > profile.valueAreaHigh;
  const belowValueBreakdown = profile.inLowVolumeZone && current.close < profile.valueAreaLow;

  if (bullishBounce) {
    return {
      strategy: "volume-profile",
      timeframe,
      bias: "long",
      confidence: 0.66,
      summary:
        "Jarvis-style volume profile long: price is bouncing from value area support toward the point of control",
      metrics,
    };
  }
  if (bearishReject) {
    return {
      strategy: "volume-profile",
      timeframe,
      bias: "short",
      confidence: 0.66,
      summary:
        "Jarvis-style volume profile short: price is rejecting value area resistance back toward the point of control",
      metrics,
    };
  }
  if (aboveValueBreakout) {
    return {
      strategy: "volume-profile",
      timeframe,
      bias: "long",
      confidence: 0.58,
      summary:
        "price is breaking above the value area through a low-volume pocket; movement can travel quickly",
      metrics,
    };
  }
  if (belowValueBreakdown) {
    return {
      strategy: "volume-profile",
      timeframe,
      bias: "short",
      confidence: 0.58,
      summary:
        "price is breaking below the value area through a low-volume pocket; downside movement can travel quickly",
      metrics,
    };
  }

  return {
    strategy: "volume-profile",
    timeframe,
    bias: "neutral",
    confidence: profile.inValueArea ? 0.48 : 0.42,
    summary:
      "volume profile is mapped, but price is not reacting cleanly at value area support/resistance yet",
    metrics,
  };
}

function buildFuturesContextSignal(context?: MexcFuturesMarketContext): StrategySignal {
  if (!context) {
    return {
      strategy: "futures-context",
      timeframe: "market-context",
      bias: "neutral",
      confidence: 0.35,
      summary: "funding, basis, and open-interest context unavailable",
    };
  }

  const crowdedLongs = context.fundingRate >= 0.0005 && context.basisPct >= 0.001;
  const crowdedShorts = context.fundingRate <= -0.0005 && context.basisPct <= -0.001;

  if (crowdedLongs) {
    return {
      strategy: "futures-context",
      timeframe: "market-context",
      bias: "short",
      confidence: 0.56,
      summary: "positive funding and positive fair/index basis suggest crowded long pressure",
      metrics: {
        fundingRate: context.fundingRate,
        basisPct: context.basisPct,
        amount24: context.amount24,
        holdVol: context.holdVol,
        riseFallRate: context.riseFallRate,
      },
    };
  }

  if (crowdedShorts) {
    return {
      strategy: "futures-context",
      timeframe: "market-context",
      bias: "long",
      confidence: 0.56,
      summary: "negative funding and negative fair/index basis suggest crowded short pressure",
      metrics: {
        fundingRate: context.fundingRate,
        basisPct: context.basisPct,
        amount24: context.amount24,
        holdVol: context.holdVol,
        riseFallRate: context.riseFallRate,
      },
    };
  }

  return {
    strategy: "futures-context",
    timeframe: "market-context",
    bias: "neutral",
    confidence: 0.46,
    summary: "funding and basis are not stretched enough to create a crowding edge",
    metrics: {
      fundingRate: context.fundingRate,
      basisPct: context.basisPct,
      amount24: context.amount24,
      holdVol: context.holdVol,
      riseFallRate: context.riseFallRate,
    },
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

  const alignedStrategies = params.strategies.filter((signal) => signal.bias === params.direction);
  const reasons = alignedStrategies.slice(0, 3).map((signal) => signal.summary.toLowerCase());
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
  if (input.shortCandles.length < MIN_HISTORY || input.longCandles.length < MIN_HISTORY) {
    warnings.push(`insufficient history: need at least ${MIN_HISTORY} candles on both timeframes`);
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
  const emaPullbackSignal = buildEmaPullbackSignal(input.shortCandles, input.shortTimeframe);
  const breakoutSignal = buildBreakoutSignal(input.shortCandles, input.shortTimeframe);
  const gridSignal = buildAdaptiveGridSignal(input.shortCandles, input.shortTimeframe);
  const volumeProfileSignal = buildVolumeProfileSignal(input.shortCandles, input.shortTimeframe);
  const contextSignal = buildFuturesContextSignal(input.marketContext);
  const strategies = [
    trendSignal,
    rsiSignal,
    macdSignal,
    emaPullbackSignal,
    breakoutSignal,
    gridSignal,
    volumeProfileSignal,
    contextSignal,
  ];

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
  if (
    gridSignal.bias !== "neutral" &&
    gridSignal.confidence >= 0.58 &&
    !ideas.some((idea) => idea.direction === gridSignal.bias && idea.horizon === "scalp")
  ) {
    ideas.push(
      buildIdea({
        symbol: input.symbol,
        market: input.market,
        direction: gridSignal.bias,
        horizon: "scalp",
        currentPrice,
        atrValue,
        support,
        resistance,
        confidence: gridSignal.confidence,
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
