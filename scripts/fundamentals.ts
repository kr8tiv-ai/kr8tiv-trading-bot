export type AssetSymbol = "BTCUSDT" | "ETHUSDT" | "SOLUSDT";

export type AssetFundamentalSnapshot = {
  symbol: AssetSymbol;
  coinGeckoId: string;
  priceUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  change24hPct: number;
  lastUpdatedAtMs: number;
};

export type AssetFundamentalAssessment = AssetFundamentalSnapshot & {
  posture: "supportive" | "caution" | "hostile";
  score: number;
  volumeToMarketCap: number;
  notes: string[];
};

export type AssetFundamentalsResponse = {
  generatedAtMs: number;
  source: "coingecko-simple-price";
  sourceUrl: string;
  assessments: AssetFundamentalAssessment[];
};

type FetchLike = (
  input: string,
) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

const ASSETS: Array<{ symbol: AssetSymbol; coinGeckoId: string }> = [
  { symbol: "BTCUSDT", coinGeckoId: "bitcoin" },
  { symbol: "ETHUSDT", coinGeckoId: "ethereum" },
  { symbol: "SOLUSDT", coinGeckoId: "solana" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function scoreAssetFundamentals(
  snapshot: AssetFundamentalSnapshot,
  nowMs = Date.now(),
): AssetFundamentalAssessment {
  const notes: string[] = [];
  const ageMs = Math.max(0, nowMs - snapshot.lastUpdatedAtMs);
  const volumeToMarketCap =
    snapshot.marketCapUsd > 0 ? snapshot.volume24hUsd / snapshot.marketCapUsd : 0;
  let score = 50;

  if (ageMs > 10 * 60_000) {
    score -= 18;
    notes.push("CoinGecko data is stale; do not overweight fundamentals until refreshed");
  } else {
    score += 6;
    notes.push("fundamental snapshot is fresh");
  }

  if (volumeToMarketCap >= 0.05) {
    score += 16;
    notes.push("liquid 24h volume relative to market cap");
  } else if (volumeToMarketCap >= 0.02) {
    score += 8;
    notes.push("acceptable 24h liquidity");
  } else {
    score -= 10;
    notes.push("thin 24h volume relative to market cap");
  }

  if (snapshot.change24hPct > 0 && snapshot.change24hPct <= 6) {
    score += 10;
    notes.push("constructive but not wildly extended 24h momentum");
  } else if (snapshot.change24hPct < 0 && snapshot.change24hPct >= -4) {
    score += 2;
    notes.push("mild 24h pullback; require futures context confirmation");
  } else if (Math.abs(snapshot.change24hPct) > 8) {
    score -= 11;
    notes.push("24h move is overextended; avoid late chase entries");
  }

  if (snapshot.marketCapUsd >= 50_000_000_000) {
    score += 5;
    notes.push("large-cap asset; less vulnerable to single-venue noise");
  }

  const finalScore = clamp(Math.round(score), 0, 100);
  const posture =
    finalScore >= 65 ? "supportive" : finalScore >= 42 ? "caution" : "hostile";

  return {
    ...snapshot,
    score: finalScore,
    posture,
    volumeToMarketCap: round(volumeToMarketCap, 6),
    notes,
  };
}

export async function fetchAssetFundamentals(
  nowMs = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<AssetFundamentalsResponse> {
  const ids = ASSETS.map((asset) => asset.coinGeckoId).join(",");
  const sourceUrl =
    "https://api.coingecko.com/api/v3/simple/price" +
    `?ids=${ids}` +
    "&vs_currencies=usd" +
    "&include_market_cap=true" +
    "&include_24hr_vol=true" +
    "&include_24hr_change=true" +
    "&include_last_updated_at=true";

  const response = await fetchImpl(sourceUrl);
  if (!response.ok) {
    throw new Error(`CoinGecko fundamentals request failed (${response.status ?? "unknown"})`);
  }
  const payload = (await response.json()) as Record<string, Record<string, unknown>>;
  const assessments = ASSETS.map((asset) => {
    const row = payload[asset.coinGeckoId] ?? {};
    return scoreAssetFundamentals(
      {
        symbol: asset.symbol,
        coinGeckoId: asset.coinGeckoId,
        priceUsd: finiteNumber(row.usd),
        marketCapUsd: finiteNumber(row.usd_market_cap),
        volume24hUsd: finiteNumber(row.usd_24h_vol),
        change24hPct: finiteNumber(row.usd_24h_change),
        lastUpdatedAtMs: finiteNumber(row.last_updated_at) * 1000,
      },
      nowMs,
    );
  });

  return {
    generatedAtMs: nowMs,
    source: "coingecko-simple-price",
    sourceUrl,
    assessments,
  };
}
