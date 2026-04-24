import { describe, expect, it } from "vitest";
import {
  MexcBalanceResponseSchema,
  MexcCancelResponseSchema,
  MexcExchangeInfoSchema,
  MexcFillSchema,
  MexcFuturesAccountSnapshotSchema,
  MexcFuturesPingSchema,
  MexcFuturesPositionSchema,
  MexcOrderResponseSchema,
  MexcPingResponseSchema,
  MexcSpotTimeSchema,
} from "./mexc.js";

describe("MexcSpotTimeSchema", () => {
  it("accepts a positive integer serverTime", () => {
    expect(MexcSpotTimeSchema.parse({ serverTime: 1645539742000 })).toEqual({
      serverTime: 1645539742000,
    });
  });
  it("rejects non-number serverTime", () => {
    expect(() => MexcSpotTimeSchema.parse({ serverTime: "x" })).toThrow();
  });
  it("rejects negative serverTime", () => {
    expect(() => MexcSpotTimeSchema.parse({ serverTime: -1 })).toThrow();
  });
});

describe("MexcFuturesPingSchema", () => {
  it("accepts { success: true, code: 0, data: timestamp }", () => {
    const v = MexcFuturesPingSchema.parse({
      success: true,
      code: 0,
      data: 1645539742000,
    });
    expect(v.success).toBe(true);
    expect(v.data).toBe(1645539742000);
  });
  it("accepts success:false (caller decides what to do)", () => {
    expect(() =>
      MexcFuturesPingSchema.parse({ success: false, code: 0, data: 1 }),
    ).not.toThrow();
  });
  it("rejects missing data", () => {
    expect(() =>
      MexcFuturesPingSchema.parse({ success: true, code: 0 }),
    ).toThrow();
  });
});

describe("MexcPingResponseSchema", () => {
  it("accepts { serverTime: number }", () => {
    expect(MexcPingResponseSchema.parse({ serverTime: 123 })).toEqual({
      serverTime: 123,
    });
  });
});

describe("MexcBalanceResponseSchema", () => {
  it("accepts the four required fields (info, total, free, used)", () => {
    const bal = MexcBalanceResponseSchema.parse({
      info: {},
      total: { USDT: 10 },
      free: { USDT: 10 },
      used: { USDT: 0 },
    });
    expect(bal.total.USDT).toBe(10);
  });
  it("rejects when total/free/used are missing", () => {
    expect(() => MexcBalanceResponseSchema.parse({ info: {} })).toThrow();
  });
});

describe("MexcFuturesPositionSchema", () => {
  it("parses a normalized MEXC futures long position", () => {
    const parsed = MexcFuturesPositionSchema.parse({
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
      rawResponse: "{}",
    });
    expect(parsed.symbol).toBe("BTCUSDT");
    expect(parsed.side).toBe("long");
    expect(parsed.leverage).toBe(50);
  });

  it("rejects unsupported futures symbols", () => {
    expect(() =>
      MexcFuturesPositionSchema.parse({
        symbol: "DOGEUSDT",
        side: "long",
        contracts: 1,
        notionalQuote: 10,
        entryPrice: 1,
        markPrice: 1,
        unrealizedPnl: 0,
        leverage: 10,
      }),
    ).toThrow();
  });
});

describe("MexcFuturesAccountSnapshotSchema", () => {
  it("parses USDT margin balance and positions", () => {
    const parsed = MexcFuturesAccountSnapshotSchema.parse({
      usdt: { total: 100, free: 80, used: 20 },
      positions: [
        {
          symbol: "ETHUSDT",
          side: "short",
          contracts: 0.25,
          notionalQuote: 600,
          entryPrice: 2400,
          markPrice: 2380,
          unrealizedPnl: 5,
          leverage: 30,
        },
      ],
      fetchedAtMs: 1_700_000_000_000,
    });
    expect(parsed.usdt.free).toBe(80);
    expect(parsed.positions[0]?.symbol).toBe("ETHUSDT");
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — order / cancel / fill / exchangeInfo schemas
// ---------------------------------------------------------------------------

describe("MexcOrderResponseSchema (Phase 2)", () => {
  it("parses a CCXT unified market-buy fill", () => {
    const raw = {
      id: "12345",
      clientOrderId: "abc123def456",
      symbol: "ETH/USDT",
      side: "buy" as const,
      type: "market",
      status: "closed",
      amount: 0.001,
      filled: 0.001,
      cost: 3.5,
      price: 3500,
      fee: { cost: 0.0035, currency: "USDT" },
      info: { origClientOrderId: "abc123def456", executedQty: "0.001" },
      timestamp: 1700000000000,
    };
    const parsed = MexcOrderResponseSchema.parse(raw);
    expect(parsed.clientOrderId).toBe("abc123def456");
    expect(parsed.filled).toBe(0.001);
  });

  it("tolerates MEXC raw response in info (passthrough)", () => {
    const raw = {
      symbol: "ETH/USDT",
      side: "sell" as const,
      type: "MARKET",
      info: {
        symbol: "ETHUSDT",
        orderId: "999",
        origClientOrderId: "cafe001",
        executedQty: "0.001",
        cummulativeQuoteQty: "3.5",
        status: "FILLED",
      },
    };
    expect(() => MexcOrderResponseSchema.parse(raw)).not.toThrow();
  });

  it("requires symbol, side, and type", () => {
    expect(() =>
      MexcOrderResponseSchema.parse({ symbol: "ETH/USDT", side: "buy" }),
    ).toThrow();
  });
});

describe("MexcCancelResponseSchema", () => {
  it("lower-cases a CANCELED status", () => {
    const parsed = MexcCancelResponseSchema.parse({
      symbol: "ETH/USDT",
      origClientOrderId: "abc",
      status: "CANCELED",
      info: {},
    });
    expect(parsed.status).toBe("canceled");
  });

  it("preserves an already-lowercase status", () => {
    const parsed = MexcCancelResponseSchema.parse({
      symbol: "ETH/USDT",
      status: "canceled",
      info: {},
    });
    expect(parsed.status).toBe("canceled");
  });
});

describe("MexcFillSchema", () => {
  it("parses a fill with a fee breakdown", () => {
    const parsed = MexcFillSchema.parse({
      id: "trade123",
      order: "order456",
      symbol: "ETH/USDT",
      side: "buy",
      amount: 0.001,
      price: 3500,
      cost: 3.5,
      fee: { cost: 0.0035, currency: "USDT" },
      timestamp: 1700000000000,
    });
    expect(parsed.amount).toBe(0.001);
    expect(parsed.fee.currency).toBe("USDT");
  });

  it("rejects a non-positive amount", () => {
    expect(() =>
      MexcFillSchema.parse({
        symbol: "ETH/USDT",
        side: "buy",
        amount: 0,
        price: 3500,
        cost: 0,
        fee: { cost: 0, currency: "USDT" },
      }),
    ).toThrow();
  });
});

describe("MexcExchangeInfoSchema", () => {
  it("parses ETHUSDT market.info with quoteAmountPrecisionMarket", () => {
    const parsed = MexcExchangeInfoSchema.parse({
      symbol: "ETHUSDT",
      status: "ENABLED",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      baseAssetPrecision: 6,
      quotePrecision: 6,
      quoteAmountPrecision: "0.5",
      quoteAmountPrecisionMarket: "5",
      baseSizePrecision: "0.00001",
      takerCommission: "0.002",
      makerCommission: "0.001",
    });
    expect(parsed.quoteAmountPrecisionMarket).toBe("5");
  });

  it("accepts missing takerCommission (CCXT market.info may omit it)", () => {
    expect(() =>
      MexcExchangeInfoSchema.parse({
        symbol: "ETHUSDT",
        status: "ENABLED",
        baseAsset: "ETH",
        quoteAsset: "USDT",
      }),
    ).not.toThrow();
  });

  it("accepts numeric takerCommission as well as string", () => {
    const parsed = MexcExchangeInfoSchema.parse({
      symbol: "ETHUSDT",
      status: "ENABLED",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      takerCommission: 0.002,
    });
    expect(parsed.takerCommission).toBe(0.002);
  });
});
