import { describe, expect, it } from "vitest";
import {
  fetchAssetFundamentals,
  scoreAssetFundamentals,
} from "./fundamentals.js";

describe("asset fundamentals", () => {
  it("scores liquid, fresh, moderately positive market data as supportive", () => {
    const assessment = scoreAssetFundamentals({
      symbol: "SOLUSDT",
      coinGeckoId: "solana",
      priceUsd: 150,
      marketCapUsd: 75_000_000_000,
      volume24hUsd: 6_000_000_000,
      change24hPct: 3.2,
      lastUpdatedAtMs: 2_000,
    }, 3_000);

    expect(assessment).toMatchObject({
      symbol: "SOLUSDT",
      posture: "supportive",
    });
    expect(assessment.score).toBeGreaterThanOrEqual(65);
    expect(assessment.notes.join(" ")).toContain("liquid");
  });

  it("warns when data is stale and the asset is overextended", () => {
    const assessment = scoreAssetFundamentals({
      symbol: "BTCUSDT",
      coinGeckoId: "bitcoin",
      priceUsd: 100_000,
      marketCapUsd: 1_900_000_000_000,
      volume24hUsd: 10_000_000_000,
      change24hPct: 11.8,
      lastUpdatedAtMs: 1_000,
    }, 1_000 + 20 * 60_000);

    expect(assessment.posture).toBe("hostile");
    expect(assessment.notes.join(" ")).toContain("stale");
    expect(assessment.notes.join(" ")).toContain("overextended");
  });

  it("maps CoinGecko simple price payload into BTC/ETH/SOL assessments", async () => {
    const fakeFetch = async () =>
      ({
        ok: true,
        json: async () => ({
          bitcoin: {
            usd: 100_000,
            usd_market_cap: 1_900_000_000_000,
            usd_24h_vol: 55_000_000_000,
            usd_24h_change: 2.1,
            last_updated_at: 2,
          },
          ethereum: {
            usd: 4_000,
            usd_market_cap: 480_000_000_000,
            usd_24h_vol: 28_000_000_000,
            usd_24h_change: -0.4,
            last_updated_at: 2,
          },
          solana: {
            usd: 150,
            usd_market_cap: 75_000_000_000,
            usd_24h_vol: 6_000_000_000,
            usd_24h_change: 3.2,
            last_updated_at: 2,
          },
        }),
      }) as Response;

    const result = await fetchAssetFundamentals(3_000, fakeFetch);

    expect(result.assessments.map((item) => item.symbol)).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
    ]);
    expect(result.sourceUrl).toContain("api.coingecko.com/api/v3/simple/price");
  });
});
