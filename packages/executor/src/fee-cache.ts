import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";

interface FeeCacheEntry {
  takerBps: number;
  fetchedAt: number;
}

// Module-level cache — lives for the process. resetFeeCache() clears it (tests only).
const FEE_CACHE = new Map<string, FeeCacheEntry>();
const TTL_MS = 5 * 60 * 1000;

/**
 * Taker-fee basis points for a whitelisted symbol (EXEC-05).
 *
 * Spec per 02-RESEARCH.md Pattern 8: pull exchangeInfo.takerCommission, convert
 * to basis points, cache 5 min. MEXC returns takerCommission as a decimal like
 * "0.002" (= 20 bps = 0.2%); we multiply by 10,000 to get basis points.
 *
 * Throws if takerCommission is null — explicit failure beats silent 0-fee
 * assumption (PITFALLS.md Pitfall 12: zero-fee promo can change without warning,
 * and the $10 bankroll doesn't tolerate silent fee drift).
 */
export async function getTakerFeeBps(
  spot: MEXCSpotClient,
  symbol: string,
): Promise<number> {
  const cached = FEE_CACHE.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.takerBps;

  const info = await spot.fetchExchangeInfoForSymbol(symbol);
  if (info.takerCommission == null) {
    throw new Error(
      `MEXC exchangeInfo.takerCommission missing for ${symbol} — refusing to assume 0 (Pitfall 12)`,
    );
  }
  const takerBps = Number(info.takerCommission) * 10_000;
  FEE_CACHE.set(symbol, { takerBps, fetchedAt: Date.now() });
  return takerBps;
}

/** Clear the cache (tests only). */
export function resetFeeCache(): void {
  FEE_CACHE.clear();
}
