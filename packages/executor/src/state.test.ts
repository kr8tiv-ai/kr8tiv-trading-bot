import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { Redis } from "@kr8tiv/redis-client";
import type { OrderIntent, OrderResult } from "./types.js";
import {
  getFreeUsdtBalance,
  isArmed,
  recordOrder,
  setArmed,
  stalePositionsExist,
} from "./state.js";

/**
 * Minimal in-memory Redis double. Only implements the commands state.ts calls.
 * scanStream returns an EventEmitter that fires 'data' with keys matching the
 * pattern, then 'end'.
 */
function makeFakeRedis(initial: Record<string, string> = {}): Redis {
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
    expire: vi.fn(async (k: string, seconds: number) => {
      ttls.set(k, seconds);
      return 1;
    }),
    scanStream: vi.fn((opts: { match: string; count?: number }) => {
      const emitter = new EventEmitter();
      const match = opts.match;
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
      const keys = [...store.keys(), ...hashes.keys()].filter((k) =>
        k.startsWith(prefix),
      );
      // Fire async so listeners can register first
      queueMicrotask(() => {
        if (keys.length > 0) emitter.emit("data", keys);
        emitter.emit("end");
      });
      return emitter;
    }),
    // exposed for test assertions
    _store: store,
    _hashes: hashes,
    _ttls: ttls,
  } as unknown as Redis;
}

describe("isArmed", () => {
  it("returns false when executor:armed is missing (fail-closed default)", async () => {
    const redis = makeFakeRedis();
    expect(await isArmed(redis)).toBe(false);
  });

  it("returns true only when value is exactly the string 'true'", async () => {
    expect(await isArmed(makeFakeRedis({ "executor:armed": "true" }))).toBe(true);
    expect(await isArmed(makeFakeRedis({ "executor:armed": "false" }))).toBe(false);
    expect(await isArmed(makeFakeRedis({ "executor:armed": "TRUE" }))).toBe(false);
    expect(await isArmed(makeFakeRedis({ "executor:armed": "1" }))).toBe(false);
    expect(await isArmed(makeFakeRedis({ "executor:armed": "" }))).toBe(false);
  });
});

describe("setArmed", () => {
  it("writes executor:armed='true' when armed=true", async () => {
    const redis = makeFakeRedis();
    await setArmed(redis, true);
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to fake internals
    expect((redis as any)._store.get("executor:armed")).toBe("true");
  });

  it("writes executor:armed='false' when armed=false", async () => {
    const redis = makeFakeRedis({ "executor:armed": "true" });
    await setArmed(redis, false);
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to fake internals
    expect((redis as any)._store.get("executor:armed")).toBe("false");
  });
});

describe("stalePositionsExist", () => {
  it("returns true if ANY executor:positions:* key exists", async () => {
    const redis = makeFakeRedis({ "executor:positions:ETHUSDT": "{}" });
    expect(await stalePositionsExist(redis)).toBe(true);
  });

  it("returns true if ANY executor:orders:* key exists", async () => {
    const redis = makeFakeRedis({ "executor:orders:abc123": "{}" });
    expect(await stalePositionsExist(redis)).toBe(true);
  });

  it("returns false when no executor:positions:* and no executor:orders:* keys", async () => {
    const redis = makeFakeRedis({
      "executor:armed": "true",
      "executor:breaker:2026-04-19": "{}",
      "unrelated:key": "x",
    });
    expect(await stalePositionsExist(redis)).toBe(false);
  });
});

describe("recordOrder", () => {
  it("writes a hash at executor:orders:<clientOrderId> with expected fields", async () => {
    const redis = makeFakeRedis();
    const intent: OrderIntent = {
      pair: "ETHUSDT",
      side: "buy",
      type: "market",
      clientOrderId: "coid-abc",
      signalId: "sig-1",
      approvalTsMs: 1700000000000,
      quoteOrderQty: "5",
    };
    const result: OrderResult = {
      id: "mexc-order-123",
      clientOrderId: "coid-abc",
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      status: "open",
      info: {},
    };
    await recordOrder(redis, intent, result);
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to fake internals
    const hash = (redis as any)._hashes.get("executor:orders:coid-abc");
    expect(hash).toEqual({
      pair: "ETHUSDT",
      side: "buy",
      status: "open",
      submittedAt: "1700000000000",
      exchangeOrderId: "mexc-order-123",
      signalId: "sig-1",
    });
    // biome-ignore lint/suspicious/noExplicitAny: test-only access to fake internals
    expect((redis as any)._ttls.get("executor:orders:coid-abc")).toBe(48 * 60 * 60);
  });
});

describe("getFreeUsdtBalance", () => {
  it("returns free.USDT when present as a number", async () => {
    const spot = {
      getAccountInfo: vi.fn().mockResolvedValue({
        info: {},
        total: { USDT: 10, ETH: 0.1 },
        free: { USDT: 8.5, ETH: 0.1 },
        used: { USDT: 1.5, ETH: 0 },
      }),
    } as unknown as MEXCSpotClient;
    expect(await getFreeUsdtBalance(spot)).toBe(8.5);
  });

  it("returns 0 when USDT is missing from free", async () => {
    const spot = {
      getAccountInfo: vi.fn().mockResolvedValue({
        info: {},
        total: { ETH: 0.1 },
        free: { ETH: 0.1 },
        used: { ETH: 0 },
      }),
    } as unknown as MEXCSpotClient;
    expect(await getFreeUsdtBalance(spot)).toBe(0);
  });
});
