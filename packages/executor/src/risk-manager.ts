import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { Redis } from "@kr8tiv/redis-client";
import { CircuitBreaker } from "./breaker.js";
import { getFreeUsdtBalance, isArmed } from "./state.js";
import type { RiskErrorCode } from "./types.js";
import { ALLOWED_PAIRS } from "./types.js";

/**
 * Structured rejection from the synchronous pre-order gate. The `code` field
 * is part of the wire contract — panic / ledger / test harnesses switch on it.
 */
export class RiskError extends Error {
  override readonly name: string = "RiskError";
  readonly code: RiskErrorCode;
  constructor(message: string, code: RiskErrorCode) {
    super(message);
    this.code = code;
  }
}

export interface PreOrderCheck {
  pair: string;
  side: "buy" | "sell";
  notionalUsdt: number;
}

/**
 * Synchronous pre-order gate per 02-RESEARCH.md Pattern 3 and ARCHITECTURE.md
 * §3 Risk Manager contract.
 *
 * Pure-ish function: reads state, throws RiskError on violation, returns void
 * on pass. No side effects — the caller (executor handler) writes the ledger
 * row AFTER this returns.
 *
 * Check order is earliest-fail-first per fail-closed principle:
 *   1. NOT_ARMED              (executor:armed !== 'true')                     EXEC-01 + EXEC-08
 *   2. PAIR_NOT_WHITELISTED   (pair not in ALLOWED_PAIRS)                     EXEC-06
 *   3. CIRCUIT_TRIPPED        (UTC-today realized PnL <= -$2.00)              EXEC-01 + D-03
 *   4. BELOW_MIN_NOTIONAL     (notional < quoteAmountPrecisionMarket)         EXEC-04
 *   5. INSUFFICIENT_BALANCE   (2 * minNotional > free USDT)                   EXEC-04 safety margin
 *
 * EXEC-03 amendment (D-05b, 2026-04-18): spot entries do NOT require an
 * attached server-side stop — MEXC spot v3 REST doesn't support triggerPrice.
 * Phase 6 (futures write) re-enables that rule. Deliberately NOT checked here.
 */
export async function ensureOrderPossible(
  spot: MEXCSpotClient,
  redis: Redis,
  db: BetterSqliteDatabase,
  check: PreOrderCheck,
): Promise<void> {
  // 1. Armed check (EXEC-01 + EXEC-08)
  if (!(await isArmed(redis))) {
    throw new RiskError(
      "executor not armed — run `pnpm arm` before placing orders",
      "NOT_ARMED",
    );
  }

  // 2. Pair whitelist (EXEC-06)
  if (!ALLOWED_PAIRS.includes(check.pair)) {
    throw new RiskError(
      `pair not whitelisted: ${check.pair} (allowed: ${ALLOWED_PAIRS.join(", ")})`,
      "PAIR_NOT_WHITELISTED",
    );
  }

  // 3. Circuit breaker (EXEC-01 + D-03)
  const breaker = new CircuitBreaker(db);
  if (breaker.isTripped()) {
    throw new RiskError(
      `daily loss circuit breaker tripped: realized=${breaker
        .realizedPnlSinceUtcMidnight()
        .toFixed(2)} USD`,
      "CIRCUIT_TRIPPED",
    );
  }

  // 4. minNotional check (EXEC-04)
  const info = await spot.fetchExchangeInfoForSymbol(check.pair);
  const minNotionalStr = info.quoteAmountPrecisionMarket;
  if (minNotionalStr == null) {
    throw new RiskError(
      `MEXC exchangeInfo missing quoteAmountPrecisionMarket for ${check.pair}`,
      "UNKNOWN_ERROR",
    );
  }
  const minNotional = Number(minNotionalStr);
  if (check.notionalUsdt < minNotional) {
    throw new RiskError(
      `notional ${check.notionalUsdt} < minNotional ${minNotional} for ${check.pair}`,
      "BELOW_MIN_NOTIONAL",
    );
  }

  // 5. 2*minNotional balance safety margin (EXEC-04; PITFALLS Pitfall 3 / Pitfall 6 orphan-position defense)
  const balance = await getFreeUsdtBalance(spot);
  if (2 * minNotional > balance) {
    throw new RiskError(
      `2*minNotional (${2 * minNotional}) exceeds free USDT balance (${balance}) — risks orphan position`,
      "INSUFFICIENT_BALANCE",
    );
  }
}
