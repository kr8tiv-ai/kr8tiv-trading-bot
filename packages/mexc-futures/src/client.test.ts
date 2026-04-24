import { describe, expect, it, vi } from "vitest";
import { MEXCFuturesClient } from "./client.js";
import { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { wrap, type SecretProvider } from "@kr8tiv/secrets";
import type { SecretName, Secret } from "@kr8tiv/shared-types";

type ExchangeMock = {
  fetchMyTrades?: (...args: unknown[]) => unknown;
};

function mockProvider(has: Partial<Record<SecretName, string>> = {}): SecretProvider {
  const values: Partial<Record<SecretName, string>> = {
    "mexc-spot-access": "mx0mockaccess1234567890",
    "mexc-spot-secret": "mockmocksecret0123456789abcdef01",
    "mexc-whitelist-ip": "127.0.0.1",
    ...has,
  };
  return {
    async get(name) {
      const v = values[name];
      if (v === undefined) throw new Error(`not set: ${name}`);
      return wrap(v) as Secret<string>;
    },
    async has(name) {
      return values[name] !== undefined;
    },
    async list() {
      return Object.keys(values) as SecretName[];
    },
    async set() {
      /* no-op */
    },
    async delete() {
      /* no-op */
    },
  };
}

function makeStubClient(exchangeMock: ExchangeMock): MEXCFuturesClient {
  return new (
    MEXCFuturesClient as unknown as {
      new (ex: unknown, baseUrl: string): MEXCFuturesClient;
    }
  )(exchangeMock, "https://contract.mexc.com");
}

describe("MEXCFuturesClient.create (unit)", () => {
  it("constructs successfully WITHOUT futures credentials (Phase 1 parity)", async () => {
    // mexc-futures-access / mexc-futures-secret are NOT in the mock
    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    expect(client.exchange.apiKey).toBe("");
    expect(client.exchange.secret).toBe("");
  });

  it("sets options.defaultType = 'swap'", async () => {
    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.defaultType).toBe("swap");
  });

  it("uses baseUrl override when provided", async () => {
    const client = await MEXCFuturesClient.create({
      secrets: mockProvider(),
      baseUrl: "https://test-futures.example.com",
    });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    const urls = (client.exchange as any).urls.api;
    expect(urls.swap).toBe("https://test-futures.example.com");
  });

  it("uses futures credentials when present", async () => {
    const client = await MEXCFuturesClient.create({
      secrets: mockProvider({
        "mexc-futures-access": "mx0futuresaccess1234567890",
        "mexc-futures-secret": "futuressecret0123456789abcdef01",
      }),
    });
    expect(client.exchange.apiKey).toBe("mx0futuresaccess1234567890");
    expect(client.exchange.secret).toBe("futuressecret0123456789abcdef01");
  });

  it("MEXCFuturesClient and MEXCSpotClient construct DIFFERENT CCXT instances (separate rate buckets)", async () => {
    const provider = mockProvider();
    const spot = await MEXCSpotClient.create({ secrets: provider });
    const futures = await MEXCFuturesClient.create({ secrets: provider });
    expect(spot.exchange).not.toBe(futures.exchange);
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((spot.exchange as any).options.defaultType).toBe("spot");
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((futures.exchange as any).options.defaultType).toBe("swap");
  });

  it("does NOT expose write-path methods on the wrapper", () => {
    const names = Object.getOwnPropertyNames(MEXCFuturesClient.prototype);
    expect(names).not.toContain("placeOrder");
    expect(names).not.toContain("createOrder");
    expect(names).not.toContain("cancelOrder");
  });
});

describe("MEXCFuturesClient.fetchCandles (public futures kline)", () => {
  it("maps official BTC_USDT kline arrays into typed candles", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          code: 0,
          data: {
            time: [1_700_000_000, 1_700_000_900],
            open: [42000, 42100],
            close: [42100, 42250],
            high: [42150, 42300],
            low: [41900, 42050],
            vol: [1000, 1200],
            amount: [42_000_000, 50_700_000],
          },
        }),
      } as Response);

    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    const candles = await client.fetchCandles({
      symbol: "BTCUSDT",
      interval: "Min15",
      limit: 2,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining("/api/v1/contract/kline/BTC_USDT?"),
    );
    expect(candles).toEqual([
      {
        openTimeMs: 1_700_000_000_000,
        closeTimeMs: 1_700_000_900_000,
        open: 42000,
        high: 42150,
        low: 41900,
        close: 42100,
        volume: 1000,
        quoteVolume: 42_000_000,
      },
      {
        openTimeMs: 1_700_000_900_000,
        closeTimeMs: 1_700_001_800_000,
        open: 42100,
        high: 42300,
        low: 42050,
        close: 42250,
        volume: 1200,
        quoteVolume: 50_700_000,
      },
    ]);

    fetchSpy.mockRestore();
  });

  it("rejects unsupported symbols before a network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });

    await expect(
      client.fetchCandles({
        symbol: "DOGEUSDT",
        interval: "Min15",
      }),
    ).rejects.toThrow(/unsupported futures symbol/i);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("MEXCFuturesClient.fetchMyTradesPage (read-only futures history)", () => {
  it("normalizes authenticated CCXT futures trades into ImportedTrade rows", async () => {
    const fetchMyTrades = vi.fn().mockResolvedValue([
      {
        id: "t-1",
        order: "o-1",
        timestamp: 1_763_515_965_654,
        side: "buy",
        price: 93_500,
        amount: 0.001,
        cost: 93.5,
        fee: { cost: 0.04, currency: "USDT" },
        info: { dealId: "t-1" },
      },
    ]);
    const client = makeStubClient({ fetchMyTrades });

    const rows = await client.fetchMyTradesPage({
      symbol: "BTCUSDT",
      since: 1_763_515_000_000,
      limit: 50,
    });

    expect(fetchMyTrades).toHaveBeenCalledWith(
      "BTC/USDT:USDT",
      1_763_515_000_000,
      50,
      { type: "swap" },
    );
    expect(rows).toEqual([
      {
        venue: "mexc",
        market: "mexc-futures",
        symbol: "BTCUSDT",
        side: "buy",
        price: 93_500,
        size: 0.001,
        quoteNotional: 93.5,
        fee: 0.04,
        feeCurrency: "USDT",
        executedAtMs: 1_763_515_965_654,
        sourceTradeId: "t-1",
        sourceOrderId: "o-1",
        rawResponse: JSON.stringify({ dealId: "t-1" }),
      },
    ]);
  });

  it("rejects unsupported symbols before the private history call", async () => {
    const fetchMyTrades = vi.fn();
    const client = makeStubClient({ fetchMyTrades });

    await expect(
      client.fetchMyTradesPage({
        symbol: "DOGEUSDT",
        since: 1,
        limit: 50,
      }),
    ).rejects.toThrow(/unsupported futures symbol/i);

    expect(fetchMyTrades).not.toHaveBeenCalled();
  });
});
