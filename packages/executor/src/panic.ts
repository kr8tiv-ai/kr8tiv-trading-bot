import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { Redis } from "@kr8tiv/redis-client";
import type { Logger } from "pino";
import { setArmed } from "./state.js";
import type { PanicReport } from "./types.js";
import { REDIS_KEYS } from "./types.js";

const PAIR = "ETHUSDT";
const SETTLEMENT_DEADLINE_MS = 5000;
const SETTLEMENT_POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Panic kill-switch per 02-RESEARCH.md Pattern 5 and 02-CONTEXT.md §D-02.
 *
 * Sequence (freeze-first):
 *   1. SET executor:armed='false' — prevents any concurrent executor process
 *      from placing new orders while we cancel + flatten. Fail-closed FIRST.
 *   2. cancelAllOrders('ETHUSDT') — idempotent (empty open-order list is fine).
 *   3. Poll fetchOpenOrders('ETHUSDT') until empty OR 5s deadline (Pitfall 6:
 *      cancelAllOrders returns before the matching engine fully unwinds, so a
 *      stale fetchBalance during the window can over-size the flatten).
 *   4. Read spot balance; if total.ETH > 0, placeMarketSell the full amount
 *      with a panic-prefixed clientOrderId so the ledger can distinguish it.
 *   5. Persist executor_state(key='armed', value='false') in SQLite — Redis is
 *      still the primary source of truth, but the SQLite row survives Redis
 *      eviction / restart (durability backstop per EXEC-08).
 *
 * Idempotent: re-running with nothing to do returns { frozen:true, cancelled:[],
 * flattenedQty:0, errors:[] } without throwing.
 *
 * Partial-fill + cancel errors are recorded in report.errors, not thrown —
 * the operator can re-run (each step is individually idempotent). Partial
 * flatten logs a recommend-rerun note.
 */
export async function panic(
  spot: MEXCSpotClient,
  redis: Redis,
  db: BetterSqliteDatabase,
  log: Logger,
): Promise<PanicReport> {
  const report: PanicReport = {
    frozen: false,
    cancelled: [],
    flattenedQty: 0,
    errors: [],
  };

  // Step 1: Freeze (fail-closed FIRST per D-02)
  try {
    await setArmed(redis, false);
    report.frozen = true;
    log.warn({ pair: PAIR }, "panic: armed=false");
  } catch (err) {
    report.errors.push(`freeze failed: ${String(err)}`);
    log.fatal({ err }, "panic: freeze failed — armed state unknown");
    // Do NOT return — continue to attempt cancel + flatten. Matt's best bet
    // is still to clear positions even if the armed flag didn't stick.
  }

  // Step 2: Cancel all open orders (idempotent — empty list is fine)
  try {
    const cancelled = await spot.cancelAllOrders(PAIR);
    report.cancelled = cancelled
      .map((c) => c.origClientOrderId ?? c.clientOrderId ?? "")
      .filter((x) => x.length > 0);
    log.warn({ count: report.cancelled.length }, "panic: cancelled open orders");
  } catch (err) {
    // Pitfall 6 defense: if cancelAllOrders throws, record + continue. Flatten
    // may still succeed, and re-running is safe thanks to idempotency.
    report.errors.push(`cancelAllOrders failed: ${String(err)}`);
    log.error({ err }, "panic: cancelAllOrders failed — continuing to flatten");
  }

  // Step 3: Wait for cancel settlement (Pitfall 6)
  const deadline = Date.now() + SETTLEMENT_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const open = await spot.fetchOpenOrders(PAIR);
      if (open.length === 0) break;
      await sleep(SETTLEMENT_POLL_INTERVAL_MS);
    } catch (err) {
      report.errors.push(`fetchOpenOrders settlement poll failed: ${String(err)}`);
      break;
    }
  }

  // Step 4: Read position + flatten
  try {
    const bal = await spot.getAccountInfo();
    const ethTotal = (bal.total as Record<string, number>).ETH ?? 0;
    if (ethTotal > 0) {
      const panicCoid = `panic-${Date.now().toString(16)}`.slice(0, 32);
      const sell = await spot.placeMarketSell({
        symbol: PAIR,
        clientOrderId: panicCoid,
        quantity: String(ethTotal),
      });
      // Capture filled qty (may be partial — Pitfall 8).
      const filledQty = typeof sell.filled === "number" ? sell.filled : ethTotal;
      report.flattenedQty = filledQty;
      report.flattenClientOrderId = panicCoid;
      if (filledQty < ethTotal) {
        report.errors.push(
          `partial flatten: filled ${filledQty} of ${ethTotal} ETH — re-run pnpm panic`,
        );
      }
      log.warn(
        { quantity: filledQty, clientOrderId: panicCoid },
        "panic: position flattened",
      );
    }
  } catch (err) {
    report.errors.push(`flatten failed: ${String(err)}`);
    log.error({ err }, "panic: flatten failed — manual intervention may be needed");
  }

  // Step 5: Persist armed=false to SQLite (durability backstop)
  try {
    db.prepare(
      `INSERT OR REPLACE INTO executor_state (key, value, updated_at_ms) VALUES (?, ?, ?)`,
    ).run(REDIS_KEYS.ARMED.replace("executor:", ""), "false", Date.now());
  } catch (err) {
    report.errors.push(`sqlite persist failed: ${String(err)}`);
    log.error({ err }, "panic: sqlite persist failed — Redis is still the primary flag");
  }

  return report;
}
