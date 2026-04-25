import type { MarketCandle } from "@kr8tiv/shared-schemas";

export type VolumeProfileBin = {
  priceLow: number;
  priceHigh: number;
  priceMid: number;
  volume: number;
};

export type VolumeProfile = {
  currentPrice: number;
  pointOfControl: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  supportLevel: number | null;
  resistanceLevel: number | null;
  pocSignificance: number;
  inValueArea: boolean;
  inLowVolumeZone: boolean;
  binSizePct: number;
  bins: VolumeProfileBin[];
};

export type BuildVolumeProfileOptions = {
  lookback?: number;
  binCount?: number;
  valueAreaPct?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function candlePrice(candle: MarketCandle): number {
  return (candle.high + candle.low + candle.close) / 3;
}

function candleVolume(candle: MarketCandle): number {
  return candle.quoteVolume && candle.quoteVolume > 0 ? candle.quoteVolume : candle.volume;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor(sorted.length * pct), 0, sorted.length - 1);
  return sorted[index] ?? 0;
}

export function buildVolumeProfile(
  candles: MarketCandle[],
  options: BuildVolumeProfileOptions = {},
): VolumeProfile | null {
  const lookback = Math.max(20, Math.floor(options.lookback ?? 80));
  const binCount = Math.max(12, Math.min(48, Math.floor(options.binCount ?? 24)));
  const valueAreaPct = clamp(options.valueAreaPct ?? 0.7, 0.5, 0.9);
  const recent = candles.slice(-lookback);
  const current = recent.at(-1);
  if (!current || recent.length < 20) return null;

  const priceLow = Math.min(...recent.map((candle) => candle.low));
  const priceHigh = Math.max(...recent.map((candle) => candle.high));
  const priceRange = priceHigh - priceLow;
  if (priceRange <= 0) return null;

  const binSize = priceRange / binCount;
  const bins: VolumeProfileBin[] = Array.from({ length: binCount }, (_, i) => {
    const low = priceLow + i * binSize;
    const high = i === binCount - 1 ? priceHigh : priceLow + (i + 1) * binSize;
    return {
      priceLow: low,
      priceHigh: high,
      priceMid: (low + high) / 2,
      volume: 0,
    };
  });

  for (const candle of recent) {
    const price = candlePrice(candle);
    const index = clamp(Math.floor((price - priceLow) / binSize), 0, binCount - 1);
    const bin = bins[index];
    if (bin) bin.volume += candleVolume(candle);
  }

  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
  if (totalVolume <= 0) return null;

  const pocIndex = bins.reduce(
    (bestIndex, bin, index) => (bin.volume > (bins[bestIndex]?.volume ?? 0) ? index : bestIndex),
    0,
  );
  const poc = bins[pocIndex];
  if (!poc) return null;
  const targetVolume = totalVolume * valueAreaPct;
  let valueAreaVolume = poc.volume;
  let lowIndex = pocIndex;
  let highIndex = pocIndex;

  while (valueAreaVolume < targetVolume) {
    const nextLow = lowIndex > 0 ? lowIndex - 1 : null;
    const nextHigh = highIndex < bins.length - 1 ? highIndex + 1 : null;
    if (nextLow === null && nextHigh === null) break;
    const lowVolume = nextLow === null ? -1 : (bins[nextLow]?.volume ?? 0);
    const highVolume = nextHigh === null ? -1 : (bins[nextHigh]?.volume ?? 0);
    if (lowVolume >= highVolume && nextLow !== null) {
      lowIndex = nextLow;
      valueAreaVolume += bins[lowIndex]?.volume ?? 0;
    } else if (nextHigh !== null) {
      highIndex = nextHigh;
      valueAreaVolume += bins[highIndex]?.volume ?? 0;
    } else {
      break;
    }
  }

  const currentPrice = current.close;
  const highVolumeThreshold = percentile(
    bins.map((bin) => bin.volume),
    0.7,
  );
  const lowVolumeThreshold = percentile(
    bins.map((bin) => bin.volume),
    0.25,
  );
  const highVolumeNodes = bins.filter((bin) => bin.volume >= highVolumeThreshold);
  const support =
    highVolumeNodes
      .filter((bin) => bin.priceMid < currentPrice)
      .sort((a, b) => b.priceMid - a.priceMid)
      .at(0)?.priceMid ?? null;
  const resistance =
    highVolumeNodes
      .filter((bin) => bin.priceMid > currentPrice)
      .sort((a, b) => a.priceMid - b.priceMid)
      .at(0)?.priceMid ?? null;
  const currentIndex = clamp(Math.floor((currentPrice - priceLow) / binSize), 0, binCount - 1);
  const currentBin = bins[currentIndex];
  const avgVolume = totalVolume / bins.length;

  return {
    currentPrice: round(currentPrice),
    pointOfControl: round(poc.priceMid),
    valueAreaHigh: round(bins[highIndex]?.priceHigh ?? poc.priceHigh),
    valueAreaLow: round(bins[lowIndex]?.priceLow ?? poc.priceLow),
    supportLevel: support === null ? null : round(support),
    resistanceLevel: resistance === null ? null : round(resistance),
    pocSignificance: round(avgVolume > 0 ? poc.volume / avgVolume : 0, 4),
    inValueArea:
      currentPrice >= (bins[lowIndex]?.priceLow ?? currentPrice) &&
      currentPrice <= (bins[highIndex]?.priceHigh ?? currentPrice),
    inLowVolumeZone: (currentBin?.volume ?? 0) <= lowVolumeThreshold,
    binSizePct: round(currentPrice > 0 ? binSize / currentPrice : 0, 5),
    bins: bins.map((bin) => ({
      priceLow: round(bin.priceLow),
      priceHigh: round(bin.priceHigh),
      priceMid: round(bin.priceMid),
      volume: round(bin.volume, 2),
    })),
  };
}
