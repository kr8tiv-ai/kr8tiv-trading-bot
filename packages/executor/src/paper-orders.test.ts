import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closePaperOrderManual,
  computeRealizedPnl,
  insertPaperOrder,
  listOpenPaperOrders,
  listRecentPaperOrders,
  tickPaperOrders,
} from "./paper-orders.js";

describe("paper orders ledger", () => {
  let tmpDir: string;
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-orders-"));
    db = new Database(join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts and lists open paper orders", () => {
    const id = insertPaperOrder(db, {
      journalId: null,
      symbol: "BTCUSDT",
      direction: "long",
      leverage: 50,
      marginQuote: 12,
      entryPrice: 100_000,
      stopLossPrice: 99_500,
      takeProfitPrice: 101_500,
      isLive: false,
      placedAtMs: 1_700_000_000_000,
    });
    expect(id).toBe(1);
    const open = listOpenPaperOrders(db);
    expect(open).toHaveLength(1);
    expect(open[0]?.symbol).toBe("BTCUSDT");
    expect(open[0]?.isLive).toBe(false);
    expect(open[0]?.status).toBe("open");
  });

  it("computes realized PnL correctly for a long winning trade", () => {
    const pnl = computeRealizedPnl({
      direction: "long",
      entryPrice: 100,
      exitPrice: 101,
      leverage: 10,
      marginQuote: 100,
    });
    // size = 100*10/100 = 10; delta = 1; pnl = 10
    expect(pnl).toBeCloseTo(10, 6);
  });

  it("computes realized PnL correctly for a short winning trade", () => {
    const pnl = computeRealizedPnl({
      direction: "short",
      entryPrice: 100,
      exitPrice: 99,
      leverage: 10,
      marginQuote: 100,
    });
    // size = 10; delta = entry - exit = 1; pnl = 10
    expect(pnl).toBeCloseTo(10, 6);
  });

  it("ticks an open long order to closed_target when price crosses target", () => {
    insertPaperOrder(db, {
      journalId: null,
      symbol: "BTCUSDT",
      direction: "long",
      leverage: 50,
      marginQuote: 10,
      entryPrice: 100,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      isLive: false,
    });
    const closed = tickPaperOrders(db, {
      priceBySymbol: { BTCUSDT: 101.5 },
      nowMs: 1_700_000_000_000,
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.status).toBe("closed_target");
    expect(closed[0]?.exitPrice).toBe(101);
    // size = 10*50/100 = 5; delta = 1; pnl = 5
    expect(closed[0]?.realizedPnlQuote).toBeCloseTo(5, 6);
  });

  it("prefers stop over target when both fire on the same tick (pessimistic)", () => {
    insertPaperOrder(db, {
      journalId: null,
      symbol: "BTCUSDT",
      direction: "long",
      leverage: 50,
      marginQuote: 10,
      entryPrice: 100,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      isLive: false,
    });
    // Price gaps to 95 — both stop (price <= 99) and a hypothetical target
    // crossed; stop wins (pessimistic).
    const closed = tickPaperOrders(db, {
      priceBySymbol: { BTCUSDT: 95 },
      nowMs: 1,
    });
    expect(closed[0]?.status).toBe("closed_stop");
    expect(closed[0]?.exitPrice).toBe(99); // exit recorded AT the stop level
  });

  it("ignores symbols with no current price", () => {
    insertPaperOrder(db, {
      journalId: null,
      symbol: "BTCUSDT",
      direction: "long",
      leverage: 50,
      marginQuote: 10,
      entryPrice: 100,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      isLive: false,
    });
    const closed = tickPaperOrders(db, { priceBySymbol: {}, nowMs: 1 });
    expect(closed).toHaveLength(0);
    expect(listOpenPaperOrders(db)).toHaveLength(1);
  });

  it("manually closes an open order with a chosen exit price", () => {
    const id = insertPaperOrder(db, {
      journalId: null,
      symbol: "ETHUSDT",
      direction: "short",
      leverage: 30,
      marginQuote: 20,
      entryPrice: 3_100,
      stopLossPrice: 3_124,
      takeProfitPrice: 3_040,
      isLive: false,
    });
    const closed = closePaperOrderManual(db, { id, exitPrice: 3_080, nowMs: 9 });
    expect(closed?.status).toBe("closed_manual");
    expect(closed?.exitPrice).toBe(3_080);
    // size = 20*30/3100 ≈ 0.1935; delta = 3100-3080 = 20; pnl ≈ 3.87
    expect(closed?.realizedPnlQuote).toBeCloseTo(3.87, 1);
  });

  it("listRecentPaperOrders returns rows newest-first", () => {
    insertPaperOrder(db, {
      journalId: null,
      symbol: "BTCUSDT",
      direction: "long",
      leverage: 50,
      marginQuote: 10,
      entryPrice: 100,
      stopLossPrice: 99,
      takeProfitPrice: 101,
      isLive: false,
      placedAtMs: 1,
    });
    insertPaperOrder(db, {
      journalId: null,
      symbol: "ETHUSDT",
      direction: "short",
      leverage: 30,
      marginQuote: 20,
      entryPrice: 3_100,
      stopLossPrice: 3_124,
      takeProfitPrice: 3_040,
      isLive: false,
      placedAtMs: 2,
    });
    const rows = listRecentPaperOrders(db);
    expect(rows[0]?.symbol).toBe("ETHUSDT");
    expect(rows[1]?.symbol).toBe("BTCUSDT");
  });
});
