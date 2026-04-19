import type { Redis } from "@kr8tiv/redis-client";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { OrderIntent, OrderResult } from "./types.js";
import { REDIS_KEYS } from "./types.js";

/**
 * Fail-closed armed check: returns true ONLY when executor:armed === 'true'.
 * Absence or any other value returns false — the executor refuses to place
 * orders unless an operator explicitly ran `pnpm arm` (D-02 kill-switch).
 */
export async function isArmed(redis: Redis): Promise<boolean> {
  const value = await redis.get(REDIS_KEYS.ARMED);
  return value === "true";
}

/**
 * Flip the executor:armed flag in Redis. Does NOT write to SQLite — the ledger
 * mirror is the caller's responsibility (panic.ts writes it; `pnpm arm`/
 * `pnpm panic` CLIs write it; Phase 2 boot reads both).
 */
export async function setArmed(redis: Redis, armed: boolean): Promise<void> {
  await redis.set(REDIS_KEYS.ARMED, armed ? "true" : "false");
}

/**
 * Detect stale executor state at boot (D-05). Uses SCAN, not KEYS (Pattern 6 —
 * KEYS is O(N) blocking; SCAN is cursor-based and yields).
 *
 * Returns true if ANY key matches executor:positions:* OR executor:orders:*.
 * Boot (Plan 02-05) will refuse to start when this returns true and prompt
 * the operator to run `pnpm reconcile`.
 */
export async function stalePositionsExist(redis: Redis): Promise<boolean> {
  const patterns = [
    `${REDIS_KEYS.POSITION_PREFIX}*`,
    `${REDIS_KEYS.ORDER_PREFIX}*`,
  ];
  for (const pattern of patterns) {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    let found = false;
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (keys: string[]) => {
        if (keys.length > 0) found = true;
      });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    if (found) return true;
  }
  return false;
}

/**
 * Record an order in Redis hot state. Written AFTER the MEXC response so the
 * record has exchangeOrderId + status. Plan 02-05's boot reconciler pairs this
 * with the ledger view to detect drift.
 *
 * Applies a 48h TTL — long enough for overnight-crash recovery, short enough
 * to prevent unbounded growth of executor:orders:* keys.
 */
export async function recordOrder(
  redis: Redis,
  intent: OrderIntent,
  result: OrderResult,
): Promise<void> {
  const key = `${REDIS_KEYS.ORDER_PREFIX}${intent.clientOrderId}`;
  await redis.hset(key, {
    pair: intent.pair,
    side: intent.side,
    status: String(result.status ?? "accepted"),
    submittedAt: String(intent.approvalTsMs),
    exchangeOrderId: String(result.id ?? ""),
    signalId: intent.signalId,
  });
  await redis.expire(key, 48 * 60 * 60);
}

/**
 * Free USDT balance from MEXC. Uses MEXCSpotClient (NEVER ccxt directly —
 * preserves the ccxt-in-2-files invariant).
 *
 * Returns 0 on missing/non-numeric USDT entry — callers (risk-manager) then
 * correctly reject any order at the 2*minNotional gate since 0 < 2*anything.
 */
export async function getFreeUsdtBalance(spot: MEXCSpotClient): Promise<number> {
  const bal = await spot.getAccountInfo();
  const free = (bal.free as Record<string, number>).USDT;
  return typeof free === "number" ? free : 0;
}
