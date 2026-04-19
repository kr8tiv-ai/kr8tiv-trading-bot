import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { Redis } from "@kr8tiv/redis-client";
import type { Logger } from "pino";
import {
  buildApprovalHandler,
  parseApprovalDecided,
  startExecutor,
} from "./executor.js";
import { makeClientOrderId } from "./idempotency.js";
import { applySchema } from "./schema.js";
import type { ApprovalDecidedEvent } from "./types.js";

function makeLogger(): Logger {
  const noop = vi.fn();
  return {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    debug: noop,
    trace: noop,
  } as unknown as Logger;
}

/**
 * Stream-ready fake Redis. Tracks xgroup, xreadgroup, xack, and disconnect
 * calls for assertions; xreadgroup is queue-driven so tests can control the
 * sequence of "BLOCK" returns.
 */
function makeConsumerRedis(opts: {
  xgroupShouldThrow?: Error;
  xreadgroupQueue?: Array<
    unknown | Error | Promise<unknown> | (() => unknown | Promise<unknown>)
  >;
} = {}): {
  redis: Redis;
  calls: {
    xgroup: ReturnType<typeof vi.fn>;
    xreadgroup: ReturnType<typeof vi.fn>;
    xack: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
} {
  const queue = opts.xreadgroupQueue ?? [];
  let idx = 0;
  let disconnected = false;
  let pendingRejecters: Array<(err: Error) => void> = [];

  const xreadgroup = vi.fn(async (...args: unknown[]) => {
    void args;
    if (disconnected) {
      throw new Error("Connection is closed.");
    }
    if (idx >= queue.length) {
      // Queue exhausted — yield the event loop for 1ms before returning null
      // so the consumer's `if (!entries) continue;` doesn't starve other
      // microtasks (node heap OOM on tight sync loop without this delay).
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          pendingRejecters = pendingRejecters.filter((r) => r !== rejecter);
          resolve();
        }, 1);
        const rejecter = (err: Error): void => {
          clearTimeout(t);
          resolve();
          // Note: rethrow via outer try; we just unblock the timer here.
          void err;
        };
        pendingRejecters.push(rejecter);
      });
      if (disconnected) {
        throw new Error("Connection is closed.");
      }
      return null;
    }
    const next = queue[idx];
    idx += 1;
    if (next instanceof Error) throw next;
    if (typeof next === "function") {
      return (next as () => unknown)();
    }
    return next;
  });
  const xgroup = vi.fn(async () => {
    if (opts.xgroupShouldThrow) throw opts.xgroupShouldThrow;
    return "OK";
  });
  const xack = vi.fn(async () => 1);
  const disconnect = vi.fn(() => {
    disconnected = true;
    for (const r of pendingRejecters) r(new Error("Connection is closed."));
    pendingRejecters = [];
  });
  const redis = {
    xgroup,
    xreadgroup,
    xack,
    disconnect,
  } as unknown as Redis;
  return { redis, calls: { xgroup, xreadgroup, xack, disconnect } };
}

describe("parseApprovalDecided", () => {
  it("parses a full approved event", () => {
    const kv = [
      "signal_id", "sig-1",
      "approved", "true",
      "pair", "ETHUSDT",
      "side", "buy",
      "notional_usdt", "5",
      "approval_ts", "1700000000123",
    ];
    expect(parseApprovalDecided(kv)).toEqual({
      signalId: "sig-1",
      approved: true,
      pair: "ETHUSDT",
      side: "buy",
      notionalUsdt: 5,
      approvalTsMs: 1700000000123,
    });
  });

  it("rejected event is parsed with approved=false", () => {
    const kv = ["signal_id", "s", "approved", "false", "pair", "ETHUSDT", "side", "buy"];
    expect(parseApprovalDecided(kv).approved).toBe(false);
  });
});

describe("startExecutor", () => {
  it("calls xgroup CREATE with approvals.decided, executor-v1, $, MKSTREAM on first start", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const { redis, calls } = makeConsumerRedis({});
    const stop = await startExecutor(redis, handler, makeLogger());
    expect(calls.xgroup).toHaveBeenCalledTimes(1);
    expect(calls.xgroup).toHaveBeenCalledWith(
      "CREATE",
      "approvals.decided",
      "executor-v1",
      "$",
      "MKSTREAM",
    );
    await stop();
  });

  it("tolerates BUSYGROUP error from xgroup (does not rethrow)", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const { redis } = makeConsumerRedis({
      xgroupShouldThrow: new Error("BUSYGROUP Consumer Group name already exists"),
    });
    const stop = await startExecutor(redis, handler, makeLogger());
    await stop();
    // Arriving here without throwing is the assertion.
    expect(true).toBe(true);
  });

  it("rethrows non-BUSYGROUP errors from xgroup", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const { redis } = makeConsumerRedis({
      xgroupShouldThrow: new Error("NOAUTH Authentication required"),
    });
    await expect(startExecutor(redis, handler, makeLogger())).rejects.toThrow(/NOAUTH/);
  });

  it("drains PEL first via xreadgroup(... STREAMS approvals.decided 0)", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const { redis, calls } = makeConsumerRedis({
      xreadgroupQueue: [null], // PEL returns no entries
    });
    const stop = await startExecutor(redis, handler, makeLogger());
    // Allow the event loop tick for PEL call.
    await new Promise((r) => setTimeout(r, 10));
    // First call is the PEL drain — args include "0".
    const firstCall = calls.xreadgroup.mock.calls[0] ?? [];
    expect(firstCall).toContain("0");
    expect(firstCall).toContain("approvals.decided");
    await stop();
  });

  it("main loop uses '>' after PEL drain", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const { redis, calls } = makeConsumerRedis({
      xreadgroupQueue: [null, null], // PEL, then BLOCK no-data
    });
    const stop = await startExecutor(redis, handler, makeLogger());
    await new Promise((r) => setTimeout(r, 20));
    // Second call should be the main loop, which uses ">".
    const mainCall = calls.xreadgroup.mock.calls[1] ?? [];
    expect(mainCall).toContain(">");
    expect(mainCall).toContain("BLOCK");
    await stop();
  });

  it("filters approved=false events (handler not called) but still XACKs", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const rejectedEntry = [
      ["approvals.decided", [
        ["1700000000-0", [
          "signal_id", "sig-x",
          "approved", "false",
          "pair", "ETHUSDT",
          "side", "buy",
          "notional_usdt", "5",
          "approval_ts", "1700000000123",
        ]],
      ]],
    ];
    const { redis, calls } = makeConsumerRedis({
      xreadgroupQueue: [null, rejectedEntry],
    });
    const stop = await startExecutor(redis, handler, makeLogger());
    await new Promise((r) => setTimeout(r, 30));
    expect(handler).not.toHaveBeenCalled();
    expect(calls.xack).toHaveBeenCalledWith("approvals.decided", "executor-v1", "1700000000-0");
    await stop();
  });

  it("XACKs on successful handler call", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const approvedEntry = [
      ["approvals.decided", [
        ["1700000001-0", [
          "signal_id", "sig-y",
          "approved", "true",
          "pair", "ETHUSDT",
          "side", "buy",
          "notional_usdt", "5",
          "approval_ts", "1700000001000",
        ]],
      ]],
    ];
    const { redis, calls } = makeConsumerRedis({
      xreadgroupQueue: [null, approvedEntry],
    });
    const stop = await startExecutor(redis, handler, makeLogger());
    await new Promise((r) => setTimeout(r, 30));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls.xack).toHaveBeenCalledWith("approvals.decided", "executor-v1", "1700000001-0");
    await stop();
  });

  it("loop continues after handler throws and still XACKs the failing event", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {
      throw new Error("handler boom");
    });
    const approvedEntry = [
      ["approvals.decided", [
        ["1700000002-0", [
          "signal_id", "sig-z",
          "approved", "true",
          "pair", "ETHUSDT",
          "side", "buy",
          "notional_usdt", "5",
          "approval_ts", "1700000002000",
        ]],
      ]],
    ];
    const { redis, calls } = makeConsumerRedis({
      xreadgroupQueue: [null, approvedEntry],
    });
    const stop = await startExecutor(redis, handler, makeLogger());
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.xack).toHaveBeenCalledWith("approvals.decided", "executor-v1", "1700000002-0");
    await stop();
  });

  it("stop() disconnects and causes no further xreadgroup calls", async () => {
    const handler = vi.fn(async (_e: ApprovalDecidedEvent) => {});
    const { redis, calls } = makeConsumerRedis({
      xreadgroupQueue: [null, null],
    });
    const stop = await startExecutor(redis, handler, makeLogger());
    await new Promise((r) => setTimeout(r, 10));
    await stop();
    expect(calls.disconnect).toHaveBeenCalledTimes(1);
    const callsAtShutdown = calls.xreadgroup.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.xreadgroup.mock.calls.length).toBe(callsAtShutdown);
  });
});

describe("buildApprovalHandler", () => {
  let db: BetterSqliteDatabase;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeRedis(initial: Record<string, string> = {}): Redis {
    const store = new Map<string, string>(Object.entries(initial));
    const hashes = new Map<string, Record<string, string>>();
    const ttls = new Map<string, number>();
    return {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return "OK";
      }),
      hset: vi.fn(async (k: string, fields: Record<string, string>) => {
        hashes.set(k, { ...(hashes.get(k) ?? {}), ...fields });
        return Object.keys(fields).length;
      }),
      expire: vi.fn(async (k: string, s: number) => {
        ttls.set(k, s);
        return 1;
      }),
      // biome-ignore lint/suspicious/noExplicitAny: test-only accessors for assertions
      _store: store,
      // biome-ignore lint/suspicious/noExplicitAny: test-only accessors for assertions
      _hashes: hashes,
    } as unknown as Redis;
  }

  function makeSpot(opts: {
    minNotional?: string;
    freeUsdt?: number;
    buyResult?: unknown;
    buyShouldThrow?: Error;
  }): MEXCSpotClient {
    const placeMarketBuy = vi.fn();
    if (opts.buyShouldThrow) placeMarketBuy.mockRejectedValue(opts.buyShouldThrow);
    else
      placeMarketBuy.mockResolvedValue(
        opts.buyResult ?? {
          id: "mexc-123",
          clientOrderId: "coid",
          symbol: "ETH/USDT",
          side: "buy",
          type: "market",
          status: "filled",
          amount: 0.001,
          filled: 0.001,
          cost: 5,
          info: {},
        },
      );
    return {
      placeMarketBuy,
      placeMarketSell: vi.fn(),
      fetchExchangeInfoForSymbol: vi.fn().mockResolvedValue({
        symbol: "ETHUSDT",
        status: "ENABLED",
        baseAsset: "ETH",
        quoteAsset: "USDT",
        quoteAmountPrecisionMarket: opts.minNotional ?? "5",
        takerCommission: "0.002",
      }),
      getAccountInfo: vi.fn().mockResolvedValue({
        info: {},
        total: { USDT: opts.freeUsdt ?? 100, ETH: 0 },
        free: { USDT: opts.freeUsdt ?? 100, ETH: 0 },
        used: { USDT: 0, ETH: 0 },
      }),
    } as unknown as MEXCSpotClient;
  }

  const EVENT: ApprovalDecidedEvent = {
    signalId: "s1",
    approved: true,
    pair: "ETHUSDT",
    side: "buy",
    notionalUsdt: 5,
    approvalTsMs: 123,
  };

  it("happy path: risk -> submit -> placeMarketBuy -> ledger update -> recordOrder", async () => {
    const redis = makeRedis({ "executor:armed": "true" });
    const spot = makeSpot({ minNotional: "5", freeUsdt: 20 });
    const handler = buildApprovalHandler({ spot, redis, db, log: makeLogger() });
    await handler(EVENT);

    const coid = makeClientOrderId("s1", 123);
    const order = db
      .prepare(
        "SELECT status, exchange_order_id, client_order_id FROM orders WHERE client_order_id = ?",
      )
      .get(coid) as { status: string; exchange_order_id: string; client_order_id: string };
    expect(order.client_order_id).toBe(coid);
    expect(order.status).toBe("filled");
    expect(order.exchange_order_id).toBe("mexc-123");
    expect(spot.placeMarketBuy).toHaveBeenCalledWith({
      symbol: "ETHUSDT",
      clientOrderId: coid,
      quoteOrderQty: "5",
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only accessor
    expect((redis as any)._hashes.get(`executor:orders:${coid}`)).toBeDefined();
  });

  it("side='sell' is skipped with a warning (no MEXC call)", async () => {
    const redis = makeRedis({ "executor:armed": "true" });
    const spot = makeSpot({});
    const handler = buildApprovalHandler({ spot, redis, db, log: makeLogger() });
    await handler({ ...EVENT, side: "sell" });
    expect(spot.placeMarketBuy).not.toHaveBeenCalled();
    expect(spot.placeMarketSell).not.toHaveBeenCalled();
    const coid = makeClientOrderId("s1", 123);
    const row = db
      .prepare("SELECT client_order_id FROM orders WHERE client_order_id = ?")
      .get(coid) as { client_order_id: string } | undefined;
    expect(row).toBeUndefined();
  });

  it("RiskError path: NOT_ARMED rejects without submitting or placing", async () => {
    const redis = makeRedis(); // NOT armed
    const spot = makeSpot({});
    const handler = buildApprovalHandler({ spot, redis, db, log: makeLogger() });
    await handler(EVENT);
    expect(spot.placeMarketBuy).not.toHaveBeenCalled();
    const coid = makeClientOrderId("s1", 123);
    const row = db
      .prepare("SELECT client_order_id FROM orders WHERE client_order_id = ?")
      .get(coid);
    expect(row).toBeUndefined();
  });

  it("DUPLICATE_CLIENT_ORDER_ID path: rejected row with reason tag", async () => {
    const redis = makeRedis({ "executor:armed": "true" });
    const spot = makeSpot({
      buyShouldThrow: new Error("duplicate order sent (-2010)"),
    });
    const handler = buildApprovalHandler({ spot, redis, db, log: makeLogger() });
    await handler(EVENT);
    const coid = makeClientOrderId("s1", 123);
    const row = db
      .prepare("SELECT status, raw_response FROM orders WHERE client_order_id = ?")
      .get(coid) as { status: string; raw_response: string };
    expect(row.status).toBe("rejected");
    expect(row.raw_response).toContain("DUPLICATE_CLIENT_ORDER_ID");
  });

  it("unknown MEXC error path: rejected row with UNKNOWN_ERROR tag", async () => {
    const redis = makeRedis({ "executor:armed": "true" });
    const spot = makeSpot({ buyShouldThrow: new Error("connection refused") });
    const handler = buildApprovalHandler({ spot, redis, db, log: makeLogger() });
    await handler(EVENT);
    const coid = makeClientOrderId("s1", 123);
    const row = db
      .prepare("SELECT status, raw_response FROM orders WHERE client_order_id = ?")
      .get(coid) as { status: string; raw_response: string };
    expect(row.status).toBe("rejected");
    expect(row.raw_response).toContain("UNKNOWN_ERROR");
  });
});
