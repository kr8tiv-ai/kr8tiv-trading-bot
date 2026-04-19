import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { FillResult, OrderResult } from "@kr8tiv/shared-schemas";
import type { OrderIntent } from "./types.js";

/**
 * Insert a pre-MEXC `submitted` row into the orders ledger (Pitfall 10: write
 * submitted BEFORE the MEXC call so a Ctrl+C mid-flight leaves a traceable
 * record). Downstream writeAcceptedOrRejected updates the same row with
 * exchange_order_id + raw_response once MEXC responds.
 */
export function writeSubmitted(db: BetterSqliteDatabase, intent: OrderIntent): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders
       (client_order_id, pair, side, type,
        qty_base, qty_quote, status,
        signal_id, approval_ts_ms, submitted_at_ms, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    intent.clientOrderId,
    intent.pair,
    intent.side,
    intent.type,
    intent.quantity !== undefined ? Number(intent.quantity) : null,
    intent.quoteOrderQty !== undefined ? Number(intent.quoteOrderQty) : null,
    "submitted",
    intent.signalId,
    intent.approvalTsMs,
    now,
    now,
  );
}

/**
 * Update an orders row after MEXC responds. Status mapping:
 *   - error present -> 'rejected' (errorReason stored in raw_response)
 *   - result.status 'filled'/'closed'/'FILLED' -> 'filled'
 *   - result.status 'PARTIALLY_FILLED'/'partially_filled' OR filled>0 && filled<amount -> 'partially_filled'
 *   - result.status 'canceled'/'cancelled' -> 'cancelled'
 *   - default -> 'accepted'
 *
 * Always updates updated_at_ms + raw_response. Updates exchange_order_id only
 * when result.id is set (COALESCE preserves prior value otherwise). Never
 * writes a new row — call writeSubmitted first.
 */
export function writeAcceptedOrRejected(
  db: BetterSqliteDatabase,
  clientOrderId: string,
  result: OrderResult | null,
  errorReason: string | null,
): void {
  const now = Date.now();
  const status = errorReason ? "rejected" : mapStatus(result);
  db.prepare(
    `UPDATE orders
        SET status = ?,
            exchange_order_id = COALESCE(?, exchange_order_id),
            raw_response = ?,
            updated_at_ms = ?
      WHERE client_order_id = ?`,
  ).run(
    status,
    result?.id ?? null,
    errorReason ?? JSON.stringify(result ?? {}),
    now,
    clientOrderId,
  );
}

function mapStatus(result: OrderResult | null): string {
  if (!result) return "accepted";
  const s = String(result.status ?? "").toLowerCase();
  if (s === "filled" || s === "closed") return "filled";
  if (s === "partially_filled" || s === "part_filled") return "partially_filled";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  if (
    result.filled != null &&
    result.amount != null &&
    result.filled > 0 &&
    result.filled < result.amount
  ) {
    return "partially_filled";
  }
  return "accepted";
}

/**
 * Record a fill (trade) into the fills table. The parent orders row must
 * already exist (writeSubmitted wrote it). Also refreshes orders.updated_at_ms
 * so consumers can tell the order moved.
 */
export function writeFill(
  db: BetterSqliteDatabase,
  fill: FillResult & { clientOrderId: string; rawResponseJson?: string },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO fills
       (client_order_id, fill_id, qty_base, price, fee, fee_currency, filled_at_ms, raw_response)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    fill.clientOrderId,
    fill.id ?? null,
    fill.amount,
    fill.price,
    fill.fee.cost,
    fill.fee.currency,
    fill.timestamp ?? now,
    fill.rawResponseJson ?? JSON.stringify(fill),
  );
  db.prepare(
    `UPDATE orders SET updated_at_ms = ? WHERE client_order_id = ?`,
  ).run(now, fill.clientOrderId);
}

/**
 * Mirror of CircuitBreaker.realizedPnlSinceUtcMidnight — same SQL, same UTC
 * boundary. Exposed here so CLI/ledger consumers don't need to instantiate a
 * CircuitBreaker just to read the number.
 */
export function readRealizedPnlForUtcToday(db: BetterSqliteDatabase): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(realized_usd), 0) AS total
         FROM realized_pnl
        WHERE closed_at_ms >= strftime('%s','now','start of day') * 1000
          AND closed_at_ms <  strftime('%s','now','start of day','+1 day') * 1000`,
    )
    .get() as { total: number };
  return row.total;
}
