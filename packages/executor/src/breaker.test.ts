import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker, DAILY_LOSS_BREAKER_USD } from "./breaker.js";
import { applySchema } from "./schema.js";

/**
 * Compute the UTC-midnight epoch-ms for "today" in the same way the breaker
 * SQL does. Tests inject rows relative to this boundary to exercise the window.
 */
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

/**
 * Insert a realized_pnl row directly, bypassing the FK dependency on fills.id.
 * SQLite enforces FK only if `PRAGMA foreign_keys = ON`, which @kr8tiv/db sets
 * in production. For isolated breaker tests we keep FK OFF so we don't need to
 * stage parent fills rows.
 */
function insertPnl(db: BetterSqliteDatabase, realizedUsd: number, closedAtMs: number, closeFillId = 1): void {
  db.prepare(
    `INSERT INTO realized_pnl (close_fill_id, entry_fill_id, realized_usd, closed_at_ms)
     VALUES (?, ?, ?, ?)`,
  ).run(closeFillId, null, realizedUsd, closedAtMs);
}

describe("CircuitBreaker", () => {
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    db = new Database(":memory:");
    // FK off — realized_pnl references fills(id) but we don't stage parent rows here.
    db.pragma("foreign_keys = OFF");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 with empty realized_pnl table; isTripped=false", () => {
    const breaker = new CircuitBreaker(db);
    expect(breaker.realizedPnlSinceUtcMidnight()).toBe(0);
    expect(breaker.isTripped()).toBe(false);
  });

  it("sums to -1.50 and stays below trip threshold (-2.00)", () => {
    const today = startOfTodayUtcMs() + 3_600_000; // 1h into today UTC
    insertPnl(db, -0.5, today, 1);
    insertPnl(db, -1.0, today + 60_000, 2);
    const breaker = new CircuitBreaker(db);
    expect(breaker.realizedPnlSinceUtcMidnight()).toBeCloseTo(-1.5, 6);
    expect(breaker.isTripped()).toBe(false);
  });

  it("sums to exactly -2.00 and trips (<= boundary)", () => {
    const today = startOfTodayUtcMs() + 3_600_000;
    insertPnl(db, -2.0, today, 1);
    const breaker = new CircuitBreaker(db);
    expect(breaker.realizedPnlSinceUtcMidnight()).toBeCloseTo(-2.0, 6);
    expect(breaker.isTripped()).toBe(true);
    expect(DAILY_LOSS_BREAKER_USD).toBe(-2.0);
  });

  it("excludes rows with closed_at_ms < UTC midnight today", () => {
    const justBeforeMidnight = startOfTodayUtcMs() - 1; // 1ms before UTC today
    insertPnl(db, -5.0, justBeforeMidnight, 1);
    const breaker = new CircuitBreaker(db);
    expect(breaker.realizedPnlSinceUtcMidnight()).toBe(0);
    expect(breaker.isTripped()).toBe(false);
  });

  it("excludes yesterday (-5.00) + includes today (-0.50) = -0.50 only", () => {
    const yesterday = startOfTodayUtcMs() - 3_600_000; // 1h before UTC today
    const today = startOfTodayUtcMs() + 3_600_000;
    insertPnl(db, -5.0, yesterday, 1);
    insertPnl(db, -0.5, today, 2);
    const breaker = new CircuitBreaker(db);
    expect(breaker.realizedPnlSinceUtcMidnight()).toBeCloseTo(-0.5, 6);
    expect(breaker.isTripped()).toBe(false);
  });
});
