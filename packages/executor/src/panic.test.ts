import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { Redis } from "@kr8tiv/redis-client";
import type { Logger } from "pino";
import { panic } from "./panic.js";
import { applySchema } from "./schema.js";

function makeLogger(): Logger {
  const noop = vi.fn();
  return { info: noop, warn: noop, error: noop, fatal: noop, debug: noop } as unknown as Logger;
}

function makeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    }),
    // biome-ignore lint/suspicious/noExplicitAny: test-only reference for assertions
    _store: store,
  } as unknown as Redis;
}

function makeSpot(opts: {
  cancelAll?: () => Promise<unknown[]> | unknown[];
  openOrdersSequence?: Array<unknown[] | Promise<unknown[]>>;
  balance?: { total: Record<string, number>; free: Record<string, number>; used: Record<string, number> };
  placeMarketSellResult?: unknown;
  placeMarketSellImpl?: (p: {
    symbol: string;
    clientOrderId: string;
    quantity: string;
  }) => Promise<unknown>;
  placeMarketSellShouldThrow?: boolean;
}): { spot: MEXCSpotClient; mocks: { cancelAllOrders: ReturnType<typeof vi.fn>; fetchOpenOrders: ReturnType<typeof vi.fn>; getAccountInfo: ReturnType<typeof vi.fn>; placeMarketSell: ReturnType<typeof vi.fn> } } {
  const cancelAllOrders = vi.fn(async () => {
    const v = opts.cancelAll ? opts.cancelAll() : [];
    return Array.isArray(v) ? v : await v;
  });

  const sequence = opts.openOrdersSequence ?? [[]];
  let call = 0;
  const fetchOpenOrders = vi.fn(async () => {
    const item = sequence[Math.min(call, sequence.length - 1)] ?? [];
    call += 1;
    return Array.isArray(item) ? item : await item;
  });

  const bal = opts.balance ?? {
    total: { ETH: 0, USDT: 10 },
    free: { ETH: 0, USDT: 10 },
    used: { ETH: 0, USDT: 0 },
  };
  const getAccountInfo = vi.fn().mockResolvedValue({ info: {}, ...bal });

  const placeMarketSell = vi.fn();
  if (opts.placeMarketSellImpl) {
    placeMarketSell.mockImplementation(opts.placeMarketSellImpl);
  } else if (opts.placeMarketSellShouldThrow) {
    placeMarketSell.mockRejectedValue(new Error("sell failed"));
  } else {
    placeMarketSell.mockResolvedValue(
      opts.placeMarketSellResult ?? {
        id: "panic-sell-1",
        clientOrderId: "coid",
        symbol: "ETH/USDT",
        side: "sell",
        type: "market",
        status: "filled",
        amount: 0.003,
        filled: 0.003,
        cost: 15,
        info: {},
      },
    );
  }

  const spot = {
    cancelAllOrders,
    fetchOpenOrders,
    getAccountInfo,
    placeMarketSell,
  } as unknown as MEXCSpotClient;

  return { spot, mocks: { cancelAllOrders, fetchOpenOrders, getAccountInfo, placeMarketSell } };
}

describe("panic", () => {
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("freezes FIRST (redis.set('executor:armed','false') is the first Redis write)", async () => {
    const redis = makeRedis();
    const callOrder: string[] = [];
    (redis.set as ReturnType<typeof vi.fn>).mockImplementation(async (k: string, v: string) => {
      callOrder.push(`set(${k}=${v})`);
      // biome-ignore lint/suspicious/noExplicitAny: test-only access to fake internals
      (redis as any)._store.set(k, v);
      return "OK";
    });
    const { spot, mocks } = makeSpot({});
    (mocks.cancelAllOrders as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("cancelAllOrders");
      return [];
    });

    await panic(spot, redis, db, makeLogger());
    expect(callOrder[0]).toBe("set(executor:armed=false)");
    // cancelAllOrders should appear AFTER the freeze.
    expect(callOrder.indexOf("cancelAllOrders")).toBeGreaterThan(0);
  });

  it("calls cancelAllOrders('ETHUSDT') exactly once after freeze", async () => {
    const redis = makeRedis();
    const { spot, mocks } = makeSpot({});
    await panic(spot, redis, db, makeLogger());
    expect(mocks.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(mocks.cancelAllOrders).toHaveBeenCalledWith("ETHUSDT");
  });

  it("polls fetchOpenOrders until empty before flattening", async () => {
    const redis = makeRedis();
    const { spot, mocks } = makeSpot({
      openOrdersSequence: [
        [{ id: "still-open" }],
        [{ id: "still-open" }],
        [], // settled on 3rd poll
      ],
      balance: {
        total: { ETH: 0.003, USDT: 10 },
        free: { ETH: 0.003, USDT: 10 },
        used: { ETH: 0, USDT: 0 },
      },
    });
    const report = await panic(spot, redis, db, makeLogger());
    expect(mocks.fetchOpenOrders.mock.calls.length).toBeGreaterThanOrEqual(3);
    // After settlement, placeMarketSell is called for the 0.003 ETH balance.
    expect(mocks.placeMarketSell).toHaveBeenCalledTimes(1);
    expect(report.flattenedQty).toBeCloseTo(0.003, 6);
  });

  it("flattens when ETH balance > 0, using panic-prefixed clientOrderId", async () => {
    const redis = makeRedis();
    const { spot, mocks } = makeSpot({
      balance: {
        total: { ETH: 0.003, USDT: 10 },
        free: { ETH: 0.003, USDT: 10 },
        used: { ETH: 0, USDT: 0 },
      },
    });
    const report = await panic(spot, redis, db, makeLogger());
    expect(mocks.placeMarketSell).toHaveBeenCalledTimes(1);
    const callArg = (mocks.placeMarketSell.mock.calls[0] ?? [])[0] as {
      symbol: string;
      clientOrderId: string;
      quantity: string;
    };
    expect(callArg.symbol).toBe("ETHUSDT");
    expect(callArg.clientOrderId).toMatch(/^panic-/);
    expect(callArg.quantity).toBe("0.003");
    expect(report.flattenClientOrderId).toMatch(/^panic-/);
    expect(report.flattenedQty).toBeCloseTo(0.003, 6);
  });

  it("does NOT flatten when ETH balance = 0", async () => {
    const redis = makeRedis();
    const { spot, mocks } = makeSpot({
      balance: {
        total: { ETH: 0, USDT: 10 },
        free: { ETH: 0, USDT: 10 },
        used: { ETH: 0, USDT: 0 },
      },
    });
    const report = await panic(spot, redis, db, makeLogger());
    expect(mocks.placeMarketSell).not.toHaveBeenCalled();
    expect(report.flattenedQty).toBe(0);
    expect(report.flattenClientOrderId).toBeUndefined();
  });

  it("is idempotent: re-running with no open orders + zero ETH returns frozen=true, no errors", async () => {
    const redis = makeRedis();
    const { spot } = makeSpot({});
    const first = await panic(spot, redis, db, makeLogger());
    const second = await panic(spot, redis, db, makeLogger());
    expect(first).toEqual({
      frozen: true,
      cancelled: [],
      flattenedQty: 0,
      errors: [],
    });
    expect(second).toEqual({
      frozen: true,
      cancelled: [],
      flattenedQty: 0,
      errors: [],
    });
  });

  it("persists armed=false to SQLite executor_state", async () => {
    const redis = makeRedis();
    const { spot } = makeSpot({});
    await panic(spot, redis, db, makeLogger());
    const row = db
      .prepare("SELECT key, value FROM executor_state WHERE key = ?")
      .get("armed") as { key: string; value: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.value).toBe("false");
  });

  it("records partial fill note (flattenedQty < total ETH) without throwing", async () => {
    const redis = makeRedis();
    const { spot, mocks } = makeSpot({
      balance: {
        total: { ETH: 0.003, USDT: 10 },
        free: { ETH: 0.003, USDT: 10 },
        used: { ETH: 0, USDT: 0 },
      },
      placeMarketSellResult: {
        id: "panic-sell-1",
        clientOrderId: "coid",
        symbol: "ETH/USDT",
        side: "sell",
        type: "market",
        status: "PARTIALLY_FILLED",
        amount: 0.003,
        filled: 0.001,
        cost: 5,
        info: {},
      },
    });
    const report = await panic(spot, redis, db, makeLogger());
    expect(mocks.placeMarketSell).toHaveBeenCalledTimes(1);
    expect(report.flattenedQty).toBeCloseTo(0.001, 6);
    expect(report.errors.some((e) => /partial flatten/.test(e))).toBe(true);
  });

  it("records cancelAllOrders error but continues to flatten + freeze", async () => {
    const redis = makeRedis();
    const { spot, mocks } = makeSpot({
      cancelAll: () => {
        throw new Error("MEXC cancel rejected");
      },
      balance: {
        total: { ETH: 0.002, USDT: 10 },
        free: { ETH: 0.002, USDT: 10 },
        used: { ETH: 0, USDT: 0 },
      },
    });
    const report = await panic(spot, redis, db, makeLogger());
    expect(report.frozen).toBe(true);
    expect(report.errors.some((e) => /cancelAllOrders failed/.test(e))).toBe(true);
    // Flatten still attempted.
    expect(mocks.placeMarketSell).toHaveBeenCalledTimes(1);
  });
});
