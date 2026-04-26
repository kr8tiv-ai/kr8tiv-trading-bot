import { describe, expect, it } from "vitest";
import {
  MexcBalanceResponseSchema,
  MexcCancelResponseSchema,
  MexcExchangeInfoSchema,
  MexcFillSchema,
  MexcFuturesAccountSnapshotSchema,
  MexcFuturesFundingRateResponseSchema,
  MexcFuturesMarketContextSchema,
  MexcFuturesOpenOrderSchema,
  MexcFuturesPingSchema,
  MexcFuturesPositionSchema,
  MexcFuturesTickerResponseSchema,
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
    expect(() => MexcFuturesPingSchema.parse({ success: false, code: 0, data: 1 })).not.toThrow();
  });
  it("rejects missing data", () => {
    expect(() => MexcFuturesPingSchema.parse({ success: true, code: 0 })).toThrow();
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

describe("MexcFuturesOpenOrderSchema", () => {
  it("parses a normalized MEXC futures open order for a supported symbol", () => {
    const parsed = MexcFuturesOpenOrderSchema.parse({
      id: "order-123",
      clientOrderId: "client-123",
      symbol: "SOLUSDT",
      side: "buy",
      type: "limit",
      status: "open",
      amount: 4,
      filled: 1,
      cost: 120,
      price: 30,
      timestamp: 1_700_000_000_000,
      rawResponse: "{}",
    });
    expect(parsed.symbol).toBe("SOLUSDT");
    expect(parsed.filled).toBe(1);
  });

  it("rejects unsupported futures open-order symbols", () => {
    expect(() =>
      MexcFuturesOpenOrderSchema.parse({
        symbol: "DOGEUSDT",
        side: "buy",
        type: "limit",
        status: "open",
        amount: 1,
        filled: 0,
      }),
    ).toThrow();
  });
});

describe("MexcFuturesAccountSnapshotSchema", () => {
  it("parses USDT margin balance, positions, and open orders", () => {
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
      openOrders: [
        {
          id: "order-1",
          symbol: "ETHUSDT",
          side: "sell",
          type: "limit",
          status: "open",
          amount: 0.25,
          filled: 0,
        },
      ],
      fetchedAtMs: 1_700_000_000_000,
    });
    expect(parsed.usdt.free).toBe(80);
    expect(parsed.positions[0]?.symbol).toBe("ETHUSDT");
    expect(parsed.openOrders[0]?.side).toBe("sell");
  });
});

describe("MexcFuturesTickerResponseSchema", () => {
  it("parses public contract ticker context with coerced numeric fields", () => {
    const parsed = MexcFuturesTickerResponseSchema.parse({
      success: true,
      code: "0",
      data: {
        symbol: "BTC_USDT",
        lastPrice: "90000",
        bid1: "89999",
        ask1: "90001",
        volume24: "12345",
        amount24: "1110000000",
        holdVol: "55102960",
        lower24Price: "88000",
        high24Price: "92000",
        riseFallRate: "0.025",
        riseFallValue: "2200",
        indexPrice: "89950",
        fairPrice: "90025",
        fundingRate: "-0.00012",
        timestamp: 1_700_000_000_000,
      },
    });

    expect(parsed.data.lastPrice).toBe(90000);
    expect(parsed.data.holdVol).toBe(55102960);
    expect(parsed.data.fundingRate).toBe(-0.00012);
  });
});

describe("MexcFuturesFundingRateResponseSchema", () => {
  it("parses current funding-rate response", () => {
    const parsed = MexcFuturesFundingRateResponseSchema.parse({
      success: true,
      code: 0,
      data: {
        symbol: "BTC_USDT",
        fundingRate: "-0.000489",
        maxFundingRate: "0.001",
        minFundingRate: "-0.001",
        collectCycle: "8",
        nextSettleTime: 1_700_028_800_000,
        timestamp: 1_700_000_000_000,
      },
    });

    expect(parsed.data.collectCycle).toBe(8);
    expect(parsed.data.nextSettleTime).toBe(1_700_028_800_000);
  });
});

describe("MexcFuturesMarketContextSchema", () => {
  it("parses normalized futures context used by signal scoring", () => {
    const parsed = MexcFuturesMarketContextSchema.parse({
      symbol: "BTCUSDT",
      lastPrice: 90000,
      indexPrice: 89950,
      fairPrice: 90025,
      basisPct: 0.000833,
      fundingRate: -0.00012,
      nextSettleTime: 1_700_028_800_000,
      collectCycleHours: 8,
      volume24: 12345,
      amount24: 1_110_000_000,
      holdVol: 55_102_960,
      riseFallRate: 0.025,
      high24Price: 92000,
      low24Price: 88000,
      timestamp: 1_700_000_000_000,
    });

    expect(parsed.symbol).toBe("BTCUSDT");
    expect(parsed.amount24).toBe(1_110_000_000);
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
    expect(() => MexcOrderResponseSchema.parse({ symbol: "ETH/USDT", side: "buy" })).toThrow();
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
