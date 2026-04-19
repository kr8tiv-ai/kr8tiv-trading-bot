import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { getTakerFeeBps, resetFeeCache } from "./fee-cache.js";

function makeSpot(takerCommission: unknown): MEXCSpotClient {
  return {
    fetchExchangeInfoForSymbol: vi.fn().mockResolvedValue({
      symbol: "ETHUSDT",
      status: "ENABLED",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      quoteAmountPrecisionMarket: "5",
      takerCommission,
    }),
  } as unknown as MEXCSpotClient;
}

describe("getTakerFeeBps", () => {
  beforeEach(() => {
    resetFeeCache();
  });

  afterEach(() => {
    resetFeeCache();
    vi.useRealTimers();
  });

  it("first call fetches and returns Number(takerCommission) * 10000 bps", async () => {
    const spot = makeSpot("0.002");
    const bps = await getTakerFeeBps(spot, "ETHUSDT");
    expect(bps).toBe(20); // 0.002 * 10000 = 20 bps = 0.2%
    expect(spot.fetchExchangeInfoForSymbol).toHaveBeenCalledTimes(1);
  });

  it("uses cache on second call within TTL — fetchExchangeInfoForSymbol only called once", async () => {
    const spot = makeSpot("0.002");
    await getTakerFeeBps(spot, "ETHUSDT");
    await getTakerFeeBps(spot, "ETHUSDT");
    await getTakerFeeBps(spot, "ETHUSDT");
    expect(spot.fetchExchangeInfoForSymbol).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after resetFeeCache()", async () => {
    const spot = makeSpot("0.002");
    await getTakerFeeBps(spot, "ETHUSDT");
    resetFeeCache();
    await getTakerFeeBps(spot, "ETHUSDT");
    expect(spot.fetchExchangeInfoForSymbol).toHaveBeenCalledTimes(2);
  });

  it("throws descriptive error when takerCommission is null", async () => {
    const spot = makeSpot(null);
    await expect(getTakerFeeBps(spot, "ETHUSDT")).rejects.toThrow(
      /takerCommission missing for ETHUSDT/,
    );
  });

  it("re-fetches after TTL expires (5-min window)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
    const spot = makeSpot("0.002");
    await getTakerFeeBps(spot, "ETHUSDT");
    // Advance past 5 min TTL
    vi.setSystemTime(new Date(1700000000000 + 5 * 60 * 1000 + 1));
    await getTakerFeeBps(spot, "ETHUSDT");
    expect(spot.fetchExchangeInfoForSymbol).toHaveBeenCalledTimes(2);
  });
});
