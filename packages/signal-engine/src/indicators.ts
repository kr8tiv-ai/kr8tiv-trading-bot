import type { MarketCandle } from "@kr8tiv/shared-schemas";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  if (period <= 1) return [...values];

  const multiplier = 2 / (period + 1);
  const result = [values[0] ?? 0];
  for (let i = 1; i < values.length; i += 1) {
    const prev = result[i - 1] ?? values[i - 1] ?? values[i] ?? 0;
    const current = values[i] ?? prev;
    result.push(current * multiplier + prev * (1 - multiplier));
  }
  return result;
}

export function rsi(values: number[], period = 14): number[] {
  if (values.length === 0) return [];

  const result = Array.from({ length: values.length }, () => 50);
  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = (values[i] ?? 0) - (values[i - 1] ?? 0);
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = (values[i] ?? 0) - (values[i - 1] ?? 0);
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / Math.max(avgLoss, 1e-9));
  }

  for (let i = 0; i < period; i += 1) {
    result[i] = result[period] ?? 50;
  }
  return result;
}

export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): {
  macd: number[];
  signal: number[];
  histogram: number[];
} {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine = values.map((_, index) => (fast[index] ?? 0) - (slow[index] ?? 0));
  const signalLine = ema(macdLine, signalPeriod);
  const histogram = macdLine.map(
    (value, index) => value - (signalLine[index] ?? 0),
  );

  return { macd: macdLine, signal: signalLine, histogram };
}

export function atr(candles: MarketCandle[], period = 14): number[] {
  if (candles.length === 0) return [];

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1]?.close ?? candle.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  if (trueRanges.length < period) {
    return trueRanges.map((value) => Math.max(value, 0));
  }

  const result = Array.from({ length: candles.length }, () => trueRanges[0] ?? 0);
  let rolling =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = rolling;

  for (let i = period; i < trueRanges.length; i += 1) {
    rolling = (rolling * (period - 1) + (trueRanges[i] ?? 0)) / period;
    result[i] = rolling;
  }

  for (let i = 0; i < period - 1; i += 1) {
    result[i] = result[period - 1] ?? result[i] ?? 0;
  }

  return result;
}

