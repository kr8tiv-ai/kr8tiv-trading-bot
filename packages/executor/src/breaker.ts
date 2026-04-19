import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { DAILY_LOSS_BREAKER_USD } from "./types.js";

export { DAILY_LOSS_BREAKER_USD } from "./types.js";

/**
 * Daily realized-PnL circuit breaker per EXEC-01 + D-03.
 *
 * Scope: closed-position realized PnL only — unrealized drawdown does NOT
 * count (per D-03 explicit decision; open positions' exposure is bounded by
 * CLI panic-cancel in Phase 2 since server-side stops are deferred per D-05b).
 *
 * Reset: UTC midnight (D-03). SQL uses SQLite's default 'now' which IS UTC,
 * so `strftime('%s','now','start of day') * 1000` gives the UTC-midnight-today
 * epoch-ms boundary (Pitfall 5).
 *
 * Trip action (caller's responsibility, usually risk-manager): block new
 * orders, leave existing open. Re-arm path is manual `pnpm arm` OR natural
 * UTC rollover at next midnight.
 */
export class CircuitBreaker {
  constructor(private readonly db: BetterSqliteDatabase) {}

  /**
   * Sum of realized_pnl.realized_usd rows with closed_at_ms within the current
   * UTC day. Empty table / no rows today returns 0.
   */
  realizedPnlSinceUtcMidnight(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(realized_usd), 0) AS total
           FROM realized_pnl
          WHERE closed_at_ms >= strftime('%s','now','start of day') * 1000
            AND closed_at_ms <  strftime('%s','now','start of day','+1 day') * 1000`,
      )
      .get() as { total: number };
    return row.total;
  }

  /**
   * True iff today's realized PnL is <= the -$2.00 threshold (EXEC-01 + D-03).
   * Boundary is inclusive: exactly -$2.00 trips.
   */
  isTripped(): boolean {
    return this.realizedPnlSinceUtcMidnight() <= DAILY_LOSS_BREAKER_USD;
  }
}
