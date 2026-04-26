import { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { type SecretProvider, wrap } from "@kr8tiv/secrets";
import type { Secret, SecretName } from "@kr8tiv/shared-types";
import { describe, expect, it, vi } from "vitest";
import { MEXCFuturesClient } from "./client.js";

type ExchangeMock = {
  fetchMyTrades?: (...args: unknown[]) => unknown;
  fetchBalance?: (...args: unknown[]) => unknown;
  fetchPositions?: (...args: unknown[]) => unknown;
  fetchOpenOrders?: (...args: unknown[]) => unknown;
  loadTimeDifference?: (...args: unknown[]) => unknown;
};

function mockProvider(
  has: Partial<Record<SecretName, string>> = {},
  options: { includeSpotDefaults?: boolean } = {},
): SecretProvider {
  const includeSpotDefaults = options.includeSpotDefaults ?? true;
  const values: Partial<Record<SecretName, string>> = {
    ...(includeSpotDefaults
      ? {
          "mexc-spot-access": "mx0mockaccess1234567890",
          "mexc-spot-secret": "mockmocksecret0123456789abcdef01",
          "mexc-whitelist-ip": "127.0.0.1",
        }
      : {}),
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
    const client = await MEXCFuturesClient.create({
      secrets: mockProvider({}, { includeSpotDefaults: false }),
    });
    expect(client.exchange.apiKey).toBe("");
    expect(client.exchange.secret).toBe("");
  });

  it("falls back to the existing MEXC spot key pair for futures account reads", async () => {
    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    expect(client.exchange.apiKey).toBe("mx0mockaccess1234567890");
    expect(client.exchange.secret).toBe("mockmocksecret0123456789abcdef01");
  });

  it("sets options.defaultType = 'swap'", async () => {
    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.defaultType).toBe("swap");
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.adjustForTimeDifference).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.recvWindow).toBeGreaterThanOrEqual(60_000);
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
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

    expect(fetchMyTrades).toHaveBeenCalledWith("BTC/USDT:USDT", 1_763_515_000_000, 50, {
      type: "swap",
    });
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

describe("MEXCFuturesClient.fetchAccountSnapshot (read-only futures exposure)", () => {
  it("normalizes USDT balance, BTC/ETH/SOL futures positions, and open orders", async () => {
    const fetchBalance = vi.fn().mockResolvedValue({
      info: {},
      total: { USDT: 100 },
      free: { USDT: 80 },
      used: { USDT: 20 },
    });
    const fetchPositions = vi.fn().mockResolvedValue([
      {
        symbol: "BTC/USDT:USDT",
        side: "long",
        contracts: 0.01,
        notional: 775,
        entryPrice: 77000,
        markPrice: 77500,
        unrealizedPnl: 5,
        leverage: 50,
        liquidationPrice: 72000,
        marginMode: "isolated",
        info: { raw: "btc" },
      },
      {
        symbol: "DOGE/USDT:USDT",
        side: "long",
        contracts: 100,
        notional: 10,
      },
    ]);
    const fetchOpenOrders = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "order-1",
          clientOrderId: "client-1",
          symbol: "BTC/USDT:USDT",
          side: "sell",
          type: "limit",
          status: "open",
          amount: 0.01,
          filled: 0,
          price: 79_000,
          cost: 0,
          timestamp: 1_700_000_000_000,
          info: { raw: "order" },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const loadTimeDifference = vi.fn().mockResolvedValue(0);
    const client = makeStubClient({
      fetchBalance,
      fetchPositions,
      fetchOpenOrders,
      loadTimeDifference,
    });

    const snapshot = await client.fetchAccountSnapshot();

    expect(loadTimeDifference).toHaveBeenCalledTimes(1);
    expect(fetchBalance).toHaveBeenCalledWith({ type: "swap" });
    expect(fetchPositions).toHaveBeenCalledWith(
      ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"],
      { type: "swap" },
    );
    expect(fetchOpenOrders).toHaveBeenCalledWith("BTC/USDT:USDT", undefined, undefined, {
      type: "swap",
    });
    expect(snapshot.usdt).toEqual({ total: 100, free: 80, used: 20 });
    expect(snapshot.positions).toEqual([
      {
        symbol: "BTCUSDT",
        side: "long",
        contracts: 0.01,
        notionalQuote: 775,
        entryPrice: 77000,
        markPrice: 77500,
        unrealizedPnl: 5,
        leverage: 50,
        liquidationPrice: 72000,
        marginMode: "isolated",
        rawResponse: JSON.stringify({ raw: "btc" }),
      },
    ]);
    expect(snapshot.openOrders).toEqual([
      {
        id: "order-1",
        clientOrderId: "client-1",
        symbol: "BTCUSDT",
        side: "sell",
        type: "limit",
        status: "open",
        amount: 0.01,
        filled: 0,
        cost: 0,
        price: 79_000,
        timestamp: 1_700_000_000_000,
        rawResponse: JSON.stringify({ raw: "order" }),
      },
    ]);
  });

  it("tolerates open orders with missing optional unified numeric fields", async () => {
    const fetchOpenOrders = vi.fn().mockResolvedValueOnce([
      {
        id: "order-2",
        symbol: "ETH/USDT:USDT",
        side: "buy",
        type: "market",
        status: "open",
        amount: 0.02,
        filled: 0,
        info: { raw: "order-without-price" },
      },
    ]);
    const loadTimeDifference = vi.fn().mockResolvedValue(0);
    const client = makeStubClient({ fetchOpenOrders, loadTimeDifference });

    const orders = await client.fetchOpenOrders({ symbols: ["ETHUSDT"] });

    expect(loadTimeDifference).toHaveBeenCalledTimes(1);
    expect(orders).toEqual([
      {
        id: "order-2",
        symbol: "ETHUSDT",
        side: "buy",
        type: "market",
        status: "open",
        amount: 0.02,
        filled: 0,
        rawResponse: JSON.stringify({ raw: "order-without-price" }),
      },
    ]);
  });

  it("hydrates MEXC raw position fields when CCXT unified fields are sparse", async () => {
    const fetchBalance = vi.fn().mockResolvedValue({
      info: {},
      total: { USDT: 20 },
      free: { USDT: 4 },
      used: { USDT: 16 },
    });
    const fetchPositions = vi.fn().mockResolvedValue([
      {
        symbol: "SOL/USDT:USDT",
        side: "long",
        contracts: 141,
        notional: 0,
        entryPrice: 0,
        markPrice: 0,
        unrealizedPnl: 0,
        leverage: 0,
        liquidationPrice: 0,
        marginMode: "cross",
        info: {
          holdAvgPrice: "86.39",
          im: "16.09680109083",
          leverage: "76",
          liquidatePrice: "85.46",
        },
      },
    ]);
    const fetchOpenOrders = vi.fn().mockResolvedValue([]);
    const client = makeStubClient({
      fetchBalance,
      fetchPositions,
      fetchOpenOrders,
      loadTimeDifference: vi.fn().mockResolvedValue(0),
    });

    const snapshot = await client.fetchAccountSnapshot();

    expect(snapshot.positions[0]).toMatchObject({
      symbol: "SOLUSDT",
      side: "long",
      contracts: 141,
      notionalQuote: expect.closeTo(1223.35688290308, 8),
      entryPrice: 86.39,
      markPrice: 86.39,
      leverage: 76,
      liquidationPrice: 85.46,
      marginMode: "cross",
    });
  });
});

describe("MEXCFuturesClient.fetchMarketContext (public funding + ticker)", () => {
  it("normalizes MEXC ticker and funding-rate data into signal context", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          code: 0,
          data: {
            symbol: "BTC_USDT",
            lastPrice: "90000",
            volume24: "12345",
            amount24: "1110000000",
            holdVol: "55102960",
            lower24Price: "88000",
            high24Price: "92000",
            riseFallRate: "0.025",
            indexPrice: "89950",
            fairPrice: "90025",
            fundingRate: "-0.00012",
            timestamp: 1_700_000_000_000,
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          code: 0,
          data: {
            symbol: "BTC_USDT",
            fundingRate: "-0.00012",
            maxFundingRate: "0.001",
            minFundingRate: "-0.001",
            collectCycle: 8,
            nextSettleTime: 1_700_028_800_000,
            timestamp: 1_700_000_000_000,
          },
        }),
      } as Response);

    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    const context = await client.fetchMarketContext("BTCUSDT");

    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(
      "https://contract.mexc.com/api/v1/contract/ticker?symbol=BTC_USDT",
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toEqual(
      "https://contract.mexc.com/api/v1/contract/funding_rate/BTC_USDT",
    );
    expect(context).toMatchObject({
      symbol: "BTCUSDT",
      lastPrice: 90000,
      indexPrice: 89950,
      fairPrice: 90025,
      basisPct: expect.closeTo(0.0008333333, 8),
      fundingRate: -0.00012,
      collectCycleHours: 8,
      amount24: 1_110_000_000,
      holdVol: 55_102_960,
    });

    fetchSpy.mockRestore();
  });
});
