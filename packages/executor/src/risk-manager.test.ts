import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { Redis } from "@kr8tiv/redis-client";
import { ensureOrderPossible, RiskError } from "./risk-manager.js";
import { applySchema } from "./schema.js";

function makeFakeRedis(initial: Record<string, string> = {}): Redis {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    }),
  } as unknown as Redis;
}

function makeSpot(opts: {
  minNotional?: string | null;
  taker?: string | number | null;
  freeUsdt?: number;
}): MEXCSpotClient {
  const fetchExchangeInfoForSymbol = vi.fn().mockResolvedValue({
    symbol: "ETHUSDT",
    status: "ENABLED",
    baseAsset: "ETH",
    quoteAsset: "USDT",
    // Preserve explicit-null vs absent to test UNKNOWN_ERROR path.
    quoteAmountPrecisionMarket:
      "minNotional" in opts ? opts.minNotional : "5",
    takerCommission: opts.taker ?? "0.002",
  });
  const getAccountInfo = vi.fn().mockResolvedValue({
    info: {},
    total: { USDT: opts.freeUsdt ?? 100, ETH: 0 },
    free: { USDT: opts.freeUsdt ?? 100, ETH: 0 },
    used: { USDT: 0, ETH: 0 },
  });
  return { fetchExchangeInfoForSymbol, getAccountInfo } as unknown as MEXCSpotClient;
}

function seedRealizedPnl(db: BetterSqliteDatabase, usd: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO orders (client_order_id, pair, side, type, status, submitted_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)`,
  ).run("seed-o", "ETHUSDT", "buy", "market", "filled", now, now);
  const fillId = db
    .prepare(
      `INSERT INTO fills (client_order_id, qty_base, price, fee, fee_currency, filled_at_ms) VALUES (?,?,?,?,?,?)`,
    )
    .run("seed-o", 0.001, 5000, 0, "USDT", now).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO realized_pnl (close_fill_id, entry_fill_id, realized_usd, closed_at_ms) VALUES (?,?,?,?)`,
  ).run(fillId, null, usd, now);
}

describe("ensureOrderPossible", () => {
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("throws NOT_ARMED when executor:armed is missing (with message mentioning `pnpm arm`)", async () => {
    const redis = makeFakeRedis();
    const spot = makeSpot({});
    try {
      await ensureOrderPossible(spot, redis, db, {
        pair: "ETHUSDT",
        side: "buy",
        notionalUsdt: 5,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RiskError);
      expect((err as RiskError).code).toBe("NOT_ARMED");
      expect((err as RiskError).message).toMatch(/pnpm arm/);
    }
  });

  it("throws PAIR_NOT_WHITELISTED for BTCUSDT and does NOT call fetchExchangeInfoForSymbol", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    const spot = makeSpot({});
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "BTCUSDT",
        side: "buy",
        notionalUsdt: 5,
      }),
    ).rejects.toMatchObject({ code: "PAIR_NOT_WHITELISTED" });
    expect(spot.fetchExchangeInfoForSymbol).not.toHaveBeenCalled();
  });

  it("throws PAIR_NOT_WHITELISTED for lowercase 'ethusdt' (strict case)", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    const spot = makeSpot({});
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "ethusdt",
        side: "buy",
        notionalUsdt: 5,
      }),
    ).rejects.toMatchObject({ code: "PAIR_NOT_WHITELISTED" });
  });

  it("throws CIRCUIT_TRIPPED when realized PnL today <= -$2 and does NOT call fetchExchangeInfoForSymbol", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    const spot = makeSpot({});
    seedRealizedPnl(db, -2.0);
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "ETHUSDT",
        side: "buy",
        notionalUsdt: 5,
      }),
    ).rejects.toMatchObject({ code: "CIRCUIT_TRIPPED" });
    expect(spot.fetchExchangeInfoForSymbol).not.toHaveBeenCalled();
  });

  it("throws BELOW_MIN_NOTIONAL when notional < quoteAmountPrecisionMarket", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    const spot = makeSpot({ minNotional: "5", freeUsdt: 100 });
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "ETHUSDT",
        side: "buy",
        notionalUsdt: 4,
      }),
    ).rejects.toMatchObject({ code: "BELOW_MIN_NOTIONAL" });
    // getAccountInfo (balance) should NOT be called — we short-circuit on minNotional.
    expect(spot.getAccountInfo).not.toHaveBeenCalled();
  });

  it("throws INSUFFICIENT_BALANCE when 2 * minNotional > free USDT", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    const spot = makeSpot({ minNotional: "5", freeUsdt: 8 });
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "ETHUSDT",
        side: "buy",
        notionalUsdt: 5,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
  });

  it("passes (returns undefined) on the happy path", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    const spot = makeSpot({ minNotional: "5", freeUsdt: 20 });
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "ETHUSDT",
        side: "buy",
        notionalUsdt: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("check order: when ALL 5 violations are present, thrown code is NOT_ARMED (earliest)", async () => {
    // NOT armed + BAD pair + tripped breaker + notional<minNotional + balance<2*minNotional
    const redis = makeFakeRedis();
    const spot = makeSpot({ minNotional: "50", freeUsdt: 1 });
    seedRealizedPnl(db, -10.0);
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "BTCUSDT",
        side: "buy",
        notionalUsdt: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_ARMED" });
  });

  it("RiskError extends Error with correct name + code", () => {
    const err = new RiskError("test", "PAIR_NOT_WHITELISTED");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RiskError);
    expect(err.name).toBe("RiskError");
    expect(err.code).toBe("PAIR_NOT_WHITELISTED");
    expect(err.message).toBe("test");
  });

  it("throws UNKNOWN_ERROR when exchangeInfo.quoteAmountPrecisionMarket is null", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    const spot = makeSpot({ minNotional: null });
    await expect(
      ensureOrderPossible(spot, redis, db, {
        pair: "ETHUSDT",
        side: "buy",
        notionalUsdt: 5,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_ERROR" });
  });
});
