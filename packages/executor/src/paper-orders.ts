import type Database from "better-sqlite3";
import { applySchema } from "./schema.js";

/**
 * Paper-fire ledger. Same shape as a real futures order but persisted locally
 * so the cockpit can show "what would have happened" P&L without touching
 * MEXC. When LIVE_FUTURES_FIRING is flipped and futures creds are present, the
 * `is_live = 1` flag marks real orders so the same row drives both paper and
 * live PnL views with no schema fork.
 */
export type PaperOrderStatus = "open" | "closed_target" | "closed_stop" | "closed_manual";

export type PaperOrder = {
  readonly id: number;
  readonly journalId: number | null;
  readonly symbol: "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
  readonly direction: "long" | "short";
  readonly leverage: number;
  readonly marginQuote: number;
  readonly entryPrice: number;
  readonly stopLossPrice: number;
  readonly takeProfitPrice: number;
  readonly status: PaperOrderStatus;
  readonly isLive: boolean;
  readonly placedAtMs: number;
  readonly closedAtMs: number | null;
  readonly exitPrice: number | null;
  readonly realizedPnlQuote: number | null;
  readonly notes: string | null;
};

type PaperOrderRow = {
  id: number;
  journal_id: number | null;
  symbol: PaperOrder["symbol"];
  direction: PaperOrder["direction"];
  leverage: number;
  margin_quote: number;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  status: PaperOrderStatus;
  is_live: number;
  placed_at_ms: number;
  closed_at_ms: number | null;
  exit_price: number | null;
  realized_pnl_quote: number | null;
  notes: string | null;
};

function mapRow(row: PaperOrderRow): PaperOrder {
  return {
    id: row.id,
    journalId: row.journal_id,
    symbol: row.symbol,
    direction: row.direction,
    leverage: row.leverage,
    marginQuote: row.margin_quote,
    entryPrice: row.entry_price,
    stopLossPrice: row.stop_loss_price,
    takeProfitPrice: row.take_profit_price,
    status: row.status,
    isLive: row.is_live === 1,
    placedAtMs: row.placed_at_ms,
    closedAtMs: row.closed_at_ms,
    exitPrice: row.exit_price,
    realizedPnlQuote: row.realized_pnl_quote,
    notes: row.notes,
  };
}

export type InsertPaperOrderArgs = {
  readonly journalId: number | null;
  readonly symbol: PaperOrder["symbol"];
  readonly direction: PaperOrder["direction"];
  readonly leverage: number;
  readonly marginQuote: number;
  readonly entryPrice: number;
  readonly stopLossPrice: number;
  readonly takeProfitPrice: number;
  readonly isLive: boolean;
  readonly notes?: string;
  readonly placedAtMs?: number;
};

export function insertPaperOrder(db: Database.Database, args: InsertPaperOrderArgs): number {
  applySchema(db);
  const result = db
    .prepare(
      `INSERT INTO paper_orders (
        journal_id, symbol, direction, leverage, margin_quote, entry_price,
        stop_loss_price, take_profit_price, status, is_live, placed_at_ms, notes
      ) VALUES (
        @journalId, @symbol, @direction, @leverage, @marginQuote, @entryPrice,
        @stopLossPrice, @takeProfitPrice, 'open', @isLive, @placedAtMs, @notes
      )`,
    )
    .run({
      journalId: args.journalId,
      symbol: args.symbol,
      direction: args.direction,
      leverage: args.leverage,
      marginQuote: args.marginQuote,
      entryPrice: args.entryPrice,
      stopLossPrice: args.stopLossPrice,
      takeProfitPrice: args.takeProfitPrice,
      isLive: args.isLive ? 1 : 0,
      placedAtMs: args.placedAtMs ?? Date.now(),
      notes: args.notes ?? null,
    });
  return Number(result.lastInsertRowid);
}

const SELECT_COLUMNS = `id, journal_id, symbol, direction, leverage, margin_quote,
  entry_price, stop_loss_price, take_profit_price, status, is_live, placed_at_ms,
  closed_at_ms, exit_price, realized_pnl_quote, notes`;

export function listOpenPaperOrders(db: Database.Database): PaperOrder[] {
  applySchema(db);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM paper_orders WHERE status = 'open' ORDER BY placed_at_ms ASC`,
    )
    .all() as PaperOrderRow[];
  return rows.map(mapRow);
}

export function listRecentPaperOrders(db: Database.Database, limit = 50): PaperOrder[] {
  applySchema(db);
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM paper_orders ORDER BY placed_at_ms DESC LIMIT ?`)
    .all(Math.max(1, Math.min(200, Math.floor(limit)))) as PaperOrderRow[];
  return rows.map(mapRow);
}

/**
 * Compute the realized PnL of a paper order at a given exit price. Mirrors a
 * MEXC USDT-M futures linear contract: PnL = (exitPx - entryPx) * size for
 * long, inverted for short, where size = (margin * leverage) / entryPx.
 *
 * Fees are NOT modeled (paper) — extend with takerFeeBps when needed.
 */
export function computeRealizedPnl(args: {
  readonly direction: "long" | "short";
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly leverage: number;
  readonly marginQuote: number;
}): number {
  const size = (args.marginQuote * args.leverage) / args.entryPrice;
  const delta =
    args.direction === "long" ? args.exitPrice - args.entryPrice : args.entryPrice - args.exitPrice;
  return Math.round(delta * size * 1e6) / 1e6;
}

/**
 * Tick all open paper orders against a per-symbol mark-price map. Closes
 * any whose current mark has crossed the stop or target. Returns the rows
 * that just closed.
 */
export function tickPaperOrders(
  db: Database.Database,
  args: {
    readonly priceBySymbol: Partial<Record<PaperOrder["symbol"], number>>;
    readonly nowMs?: number;
  },
): PaperOrder[] {
  applySchema(db);
  const open = listOpenPaperOrders(db);
  const nowMs = args.nowMs ?? Date.now();
  const closed: PaperOrder[] = [];
  for (const order of open) {
    const price = args.priceBySymbol[order.symbol];
    if (price === undefined || !Number.isFinite(price)) continue;

    const stopHit =
      order.direction === "long" ? price <= order.stopLossPrice : price >= order.stopLossPrice;
    const targetHit =
      order.direction === "long" ? price >= order.takeProfitPrice : price <= order.takeProfitPrice;

    if (!stopHit && !targetHit) continue;

    // If both flags fire on the same tick (the price gapped past both),
    // assume stop wins — pessimistic accounting, mirrors live behavior.
    const exitPrice = stopHit ? order.stopLossPrice : order.takeProfitPrice;
    const status: PaperOrderStatus = stopHit ? "closed_stop" : "closed_target";
    const realizedPnl = computeRealizedPnl({
      direction: order.direction,
      entryPrice: order.entryPrice,
      exitPrice,
      leverage: order.leverage,
      marginQuote: order.marginQuote,
    });

    db.prepare(
      `UPDATE paper_orders
        SET status = @status,
            closed_at_ms = @closedAtMs,
            exit_price = @exitPrice,
            realized_pnl_quote = @realizedPnl
        WHERE id = @id AND status = 'open'`,
    ).run({
      status,
      closedAtMs: nowMs,
      exitPrice,
      realizedPnl,
      id: order.id,
    });

    closed.push({
      ...order,
      status,
      closedAtMs: nowMs,
      exitPrice,
      realizedPnlQuote: realizedPnl,
    });
  }
  return closed;
}

/**
 * Manually close an open paper order at a given price (for "I'd take the
 * profit here" early-close in the cockpit).
 */
export function closePaperOrderManual(
  db: Database.Database,
  args: {
    readonly id: number;
    readonly exitPrice: number;
    readonly nowMs?: number;
  },
): PaperOrder | null {
  applySchema(db);
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM paper_orders WHERE id = ?`).get(args.id) as
    | PaperOrderRow
    | undefined;
  if (!row) return null;
  if (row.status !== "open") return mapRow(row);
  const order = mapRow(row);
  const realizedPnl = computeRealizedPnl({
    direction: order.direction,
    entryPrice: order.entryPrice,
    exitPrice: args.exitPrice,
    leverage: order.leverage,
    marginQuote: order.marginQuote,
  });
  const nowMs = args.nowMs ?? Date.now();
  db.prepare(
    `UPDATE paper_orders
      SET status = 'closed_manual',
          closed_at_ms = @nowMs,
          exit_price = @exitPrice,
          realized_pnl_quote = @realizedPnl
      WHERE id = @id AND status = 'open'`,
  ).run({ nowMs, exitPrice: args.exitPrice, realizedPnl, id: args.id });
  return {
    ...order,
    status: "closed_manual",
    closedAtMs: nowMs,
    exitPrice: args.exitPrice,
    realizedPnlQuote: realizedPnl,
  };
}
