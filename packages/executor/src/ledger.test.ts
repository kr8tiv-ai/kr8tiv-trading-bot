import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FillResult, OrderResult } from "@kr8tiv/shared-schemas";
import {
  readRealizedPnlForUtcToday,
  writeAcceptedOrRejected,
  writeFill,
  writeSubmitted,
} from "./ledger.js";
import { applySchema } from "./schema.js";
import type { OrderIntent } from "./types.js";

const INTENT: OrderIntent = {
  pair: "ETHUSDT",
  side: "buy",
  type: "market",
  clientOrderId: "coid-1",
  signalId: "sig-1",
  approvalTsMs: 1700000000000,
  quoteOrderQty: "5",
};

function baseOrderResult(overrides: Partial<OrderResult> = {}): OrderResult {
  return {
    id: "mexc-100",
    clientOrderId: "coid-1",
    symbol: "ETH/USDT",
    side: "buy",
    type: "market",
    status: "open",
    amount: 0.001,
    filled: 0.001,
    cost: 5,
    price: 5000,
    info: {},
    ...overrides,
  };
}

function startOfTodayUtcMs(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  );
}

describe("ledger", () => {
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("writeSubmitted", () => {
    it("inserts a row with status='submitted' and fields from intent", () => {
      const before = Date.now();
      writeSubmitted(db, INTENT);
      const row = db
        .prepare(
          "SELECT client_order_id, pair, side, type, qty_base, qty_quote, status, signal_id, approval_ts_ms, submitted_at_ms FROM orders WHERE client_order_id = ?",
        )
        .get("coid-1") as {
        client_order_id: string;
        pair: string;
        side: string;
        type: string;
        qty_base: number | null;
        qty_quote: number | null;
        status: string;
        signal_id: string;
        approval_ts_ms: number;
        submitted_at_ms: number;
      };
      expect(row.client_order_id).toBe("coid-1");
      expect(row.pair).toBe("ETHUSDT");
      expect(row.side).toBe("buy");
      expect(row.type).toBe("market");
      expect(row.qty_base).toBe(null);
      expect(row.qty_quote).toBe(5);
      expect(row.status).toBe("submitted");
      expect(row.signal_id).toBe("sig-1");
      expect(row.approval_ts_ms).toBe(1700000000000);
      expect(row.submitted_at_ms).toBeGreaterThanOrEqual(before);
    });

    it("maps quantity-based intent to qty_base, null qty_quote", () => {
      const sellIntent: OrderIntent = {
        pair: "ETHUSDT",
        side: "sell",
        type: "market",
        clientOrderId: "coid-sell",
        signalId: "sig-sell",
        approvalTsMs: 1700000000001,
        quantity: "0.002",
      };
      writeSubmitted(db, sellIntent);
      const row = db
        .prepare(
          "SELECT qty_base, qty_quote FROM orders WHERE client_order_id = ?",
        )
        .get("coid-sell") as { qty_base: number | null; qty_quote: number | null };
      expect(row.qty_base).toBe(0.002);
      expect(row.qty_quote).toBe(null);
    });
  });

  describe("writeAcceptedOrRejected", () => {
    it("updates status='filled' for a fully-filled result", () => {
      writeSubmitted(db, INTENT);
      const result = baseOrderResult({ status: "filled", amount: 0.001, filled: 0.001 });
      writeAcceptedOrRejected(db, "coid-1", result, null);
      const row = db
        .prepare(
          "SELECT status, exchange_order_id, raw_response FROM orders WHERE client_order_id = ?",
        )
        .get("coid-1") as { status: string; exchange_order_id: string; raw_response: string };
      expect(row.status).toBe("filled");
      expect(row.exchange_order_id).toBe("mexc-100");
      expect(row.raw_response).toContain("mexc-100");
    });

    it("maps PARTIALLY_FILLED status to partially_filled", () => {
      writeSubmitted(db, INTENT);
      const result = baseOrderResult({
        status: "PARTIALLY_FILLED",
        amount: 0.001,
        filled: 0.0005,
      });
      writeAcceptedOrRejected(db, "coid-1", result, null);
      const row = db
        .prepare("SELECT status FROM orders WHERE client_order_id = ?")
        .get("coid-1") as { status: string };
      expect(row.status).toBe("partially_filled");
    });

    it("infers partially_filled from filled < amount when status is 'open'", () => {
      writeSubmitted(db, INTENT);
      const result = baseOrderResult({
        status: "open",
        amount: 0.001,
        filled: 0.0005,
      });
      writeAcceptedOrRejected(db, "coid-1", result, null);
      const row = db
        .prepare("SELECT status FROM orders WHERE client_order_id = ?")
        .get("coid-1") as { status: string };
      expect(row.status).toBe("partially_filled");
    });

    it("updates status='rejected' when errorReason is provided", () => {
      writeSubmitted(db, INTENT);
      writeAcceptedOrRejected(db, "coid-1", null, "DUPLICATE_CLIENT_ORDER_ID: -2010");
      const row = db
        .prepare("SELECT status, raw_response FROM orders WHERE client_order_id = ?")
        .get("coid-1") as { status: string; raw_response: string };
      expect(row.status).toBe("rejected");
      expect(row.raw_response).toContain("DUPLICATE_CLIENT_ORDER_ID");
    });

    it("defaults to 'accepted' when status is an unknown value", () => {
      writeSubmitted(db, INTENT);
      writeAcceptedOrRejected(db, "coid-1", baseOrderResult({ status: "open" }), null);
      const row = db
        .prepare("SELECT status FROM orders WHERE client_order_id = ?")
        .get("coid-1") as { status: string };
      expect(row.status).toBe("accepted");
    });
  });

  describe("writeFill", () => {
    it("inserts a fill with FK reference to the parent orders row and updates orders.updated_at_ms", () => {
      writeSubmitted(db, INTENT);
      const before = db
        .prepare("SELECT updated_at_ms FROM orders WHERE client_order_id = ?")
        .get("coid-1") as { updated_at_ms: number };

      const fill: FillResult & { clientOrderId: string } = {
        clientOrderId: "coid-1",
        id: "fill-1",
        symbol: "ETH/USDT",
        side: "buy",
        amount: 0.001,
        price: 5000,
        cost: 5,
        fee: { cost: 0.01, currency: "ETH" },
        timestamp: 1700000001000,
      };
      // Force at least 1 ms between writes
      const priorNow = Date.now();
      while (Date.now() <= priorNow) {
        // spin until wallclock advances
      }
      writeFill(db, fill);

      const fillRow = db
        .prepare(
          "SELECT client_order_id, fill_id, qty_base, price, fee, fee_currency, filled_at_ms FROM fills",
        )
        .get() as {
        client_order_id: string;
        fill_id: string;
        qty_base: number;
        price: number;
        fee: number;
        fee_currency: string;
        filled_at_ms: number;
      };
      expect(fillRow.client_order_id).toBe("coid-1");
      expect(fillRow.fill_id).toBe("fill-1");
      expect(fillRow.qty_base).toBe(0.001);
      expect(fillRow.price).toBe(5000);
      expect(fillRow.fee).toBe(0.01);
      expect(fillRow.fee_currency).toBe("ETH");
      expect(fillRow.filled_at_ms).toBe(1700000001000);

      const after = db
        .prepare("SELECT updated_at_ms FROM orders WHERE client_order_id = ?")
        .get("coid-1") as { updated_at_ms: number };
      expect(after.updated_at_ms).toBeGreaterThanOrEqual(before.updated_at_ms);
    });
  });

  describe("readRealizedPnlForUtcToday", () => {
    it("mirrors the CircuitBreaker UTC-today query", () => {
      const today = startOfTodayUtcMs() + 3_600_000;
      const yesterday = startOfTodayUtcMs() - 3_600_000;
      // Insert parent fills rows because FK is ON for this describe block.
      db.prepare(
        `INSERT INTO orders (client_order_id, pair, side, type, status, submitted_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)`,
      ).run("o-1", "ETHUSDT", "buy", "market", "filled", today, today);
      const fillIdA = db
        .prepare(
          `INSERT INTO fills (client_order_id, qty_base, price, fee, fee_currency, filled_at_ms) VALUES (?,?,?,?,?,?)`,
        )
        .run("o-1", 0.001, 5000, 0, "USDT", today).lastInsertRowid as number;
      const fillIdB = db
        .prepare(
          `INSERT INTO fills (client_order_id, qty_base, price, fee, fee_currency, filled_at_ms) VALUES (?,?,?,?,?,?)`,
        )
        .run("o-1", 0.001, 5000, 0, "USDT", yesterday).lastInsertRowid as number;
      db.prepare(
        `INSERT INTO realized_pnl (close_fill_id, entry_fill_id, realized_usd, closed_at_ms) VALUES (?,?,?,?)`,
      ).run(fillIdA, null, -1.25, today);
      db.prepare(
        `INSERT INTO realized_pnl (close_fill_id, entry_fill_id, realized_usd, closed_at_ms) VALUES (?,?,?,?)`,
      ).run(fillIdB, null, -10.0, yesterday);

      expect(readRealizedPnlForUtcToday(db)).toBeCloseTo(-1.25, 6);
    });
  });
});
