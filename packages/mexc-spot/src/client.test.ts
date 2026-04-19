import { describe, expect, it, vi } from "vitest";
import { MEXCSpotClient } from "./client.js";
import { wrap, type SecretProvider } from "@kr8tiv/secrets";
import type { SecretName, Secret } from "@kr8tiv/shared-types";

/**
 * Test-only stand-in for the tiny subset of ccxt's Exchange surface we need
 * to mock. Keeping this local (not importing from "ccxt") preserves the
 * "ccxt imported in exactly 2 files" invariant — only the actual clients
 * (mexc-spot/client.ts + mexc-futures/client.ts) carry a ccxt import line.
 */
type ExchangeMock = {
  createOrder?: (...args: unknown[]) => unknown;
  cancelOrder?: (...args: unknown[]) => unknown;
  cancelAllOrders?: (...args: unknown[]) => unknown;
  fetchOpenOrders?: (...args: unknown[]) => unknown;
  loadMarkets?: (...args: unknown[]) => unknown;
  market?: (...args: unknown[]) => unknown;
};

// Mock SecretProvider — returns deterministic branded values
function mockProvider(overrides: Partial<Record<SecretName, string>> = {}): SecretProvider {
  const values: Partial<Record<SecretName, string>> = {
    "mexc-spot-access": "mx0mockaccess1234567890",
    "mexc-spot-secret": "mockmocksecret0123456789abcdef01",
    "mexc-whitelist-ip": "127.0.0.1",
    ...overrides,
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

/**
 * Build a MEXCSpotClient stub that bypasses the private constructor + ccxt
 * factory. Tests that only exercise the write-method logic (not auth/network)
 * use this to inject a hand-rolled exchange mock.
 */
function makeStubClient(exchangeMock: ExchangeMock): MEXCSpotClient {
  // The constructor is private; cast via `unknown` is the idiomatic test-only
  // escape hatch. Matches the "client just makes calls" pattern — we're
  // testing the wrapper, not CCXT's internals.
  return new (
    MEXCSpotClient as unknown as { new (ex: unknown): MEXCSpotClient }
  )(exchangeMock);
}

describe("MEXCSpotClient.create (unit)", () => {
  it("constructs a CCXT mexc instance with options.defaultType = 'spot'", async () => {
    const client = await MEXCSpotClient.create({ secrets: mockProvider() });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.defaultType).toBe("spot");
  });

  it("reads mexc-spot-access and mexc-spot-secret from the SecretProvider", async () => {
    const client = await MEXCSpotClient.create({ secrets: mockProvider() });
    expect(client.exchange.apiKey).toBe("mx0mockaccess1234567890");
    expect(client.exchange.secret).toBe("mockmocksecret0123456789abcdef01");
  });

  it("uses baseUrl override when provided", async () => {
    const client = await MEXCSpotClient.create({
      secrets: mockProvider(),
      baseUrl: "https://test.example.com",
    });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    const urls = (client.exchange as any).urls.api;
    expect(urls.spot).toBe("https://test.example.com");
  });

  it("uses recvWindowMs override when provided", async () => {
    const client = await MEXCSpotClient.create({
      secrets: mockProvider(),
      recvWindowMs: 3000,
    });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.recvWindow).toBe(3000);
  });

  it("sets createMarketBuyOrderRequiresPrice = false (Phase 2 / Pitfall 3)", async () => {
    const client = await MEXCSpotClient.create({ secrets: mockProvider() });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.createMarketBuyOrderRequiresPrice).toBe(false);
  });

  it("sets createMarketBuyOrderWithCost = true (Phase 2 / ccxt #25660)", async () => {
    const client = await MEXCSpotClient.create({ secrets: mockProvider() });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.createMarketBuyOrderWithCost).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 write methods — EXEC-02 + EXEC-03 (amendment) + EXEC-04/05 + EXEC-06
// ---------------------------------------------------------------------------

describe("placeMarketBuy (Phase 2 EXEC-02 + EXEC-06)", () => {
  it("forwards clientOrderId as newClientOrderId + quoteOrderQty in params", async () => {
    const createOrder = vi.fn().mockResolvedValue({
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      info: {},
    });
    const client = makeStubClient({ createOrder } as ExchangeMock);

    await client.placeMarketBuy({
      symbol: "ETHUSDT",
      clientOrderId: "deadbeef",
      quoteOrderQty: "5",
    });

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledWith(
      "ETH/USDT",
      "market",
      "buy",
      0,
      undefined,
      { newClientOrderId: "deadbeef", quoteOrderQty: "5" },
    );
  });

  it("forwards quantity via amount when quoteOrderQty is absent", async () => {
    const createOrder = vi.fn().mockResolvedValue({
      symbol: "ETH/USDT",
      side: "buy",
      type: "market",
      info: {},
    });
    const client = makeStubClient({ createOrder } as ExchangeMock);

    await client.placeMarketBuy({
      symbol: "ETHUSDT",
      clientOrderId: "feedface",
      quantity: "0.002",
    });

    expect(createOrder).toHaveBeenCalledWith(
      "ETH/USDT",
      "market",
      "buy",
      0.002,
      undefined,
      { newClientOrderId: "feedface" },
    );
  });

  it("throws 'pair not whitelisted' for BTCUSDT and NEVER calls createOrder", async () => {
    const createOrder = vi.fn();
    const client = makeStubClient({ createOrder } as ExchangeMock);

    await expect(
      client.placeMarketBuy({
        symbol: "BTCUSDT",
        clientOrderId: "x",
        quoteOrderQty: "5",
      }),
    ).rejects.toThrow(/pair not whitelisted/i);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("throws ZodError when ccxt returns a malformed response (Zod boundary)", async () => {
    // Missing 'symbol' + 'side' — not a valid OrderResult
    const createOrder = vi.fn().mockResolvedValue({});
    const client = makeStubClient({ createOrder } as ExchangeMock);

    await expect(
      client.placeMarketBuy({
        symbol: "ETHUSDT",
        clientOrderId: "abc",
        quoteOrderQty: "5",
      }),
    ).rejects.toThrow(); // ZodError — the exact type varies by zod version
  });
});

describe("placeMarketSell (Phase 2 EXEC-02 + EXEC-06)", () => {
  it("forwards clientOrderId and quantity-as-amount", async () => {
    const createOrder = vi.fn().mockResolvedValue({
      symbol: "ETH/USDT",
      side: "sell",
      type: "market",
      info: {},
    });
    const client = makeStubClient({ createOrder } as ExchangeMock);

    await client.placeMarketSell({
      symbol: "ETHUSDT",
      clientOrderId: "cafe",
      quantity: "0.001",
    });

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder).toHaveBeenCalledWith(
      "ETH/USDT",
      "market",
      "sell",
      0.001,
      undefined,
      { newClientOrderId: "cafe" },
    );
  });

  it("throws 'pair not whitelisted' for DOGEUSDT and NEVER calls createOrder", async () => {
    const createOrder = vi.fn();
    const client = makeStubClient({ createOrder } as ExchangeMock);

    await expect(
      client.placeMarketSell({
        symbol: "DOGEUSDT",
        clientOrderId: "x",
        quantity: "100",
      }),
    ).rejects.toThrow(/pair not whitelisted/i);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("cancelOrder (Phase 2 EXEC-06 + origClientOrderId mapping)", () => {
  it("invokes exchange.cancelOrder('', 'ETH/USDT', { origClientOrderId })", async () => {
    const cancelOrder = vi.fn().mockResolvedValue({
      symbol: "ETH/USDT",
      status: "CANCELED",
      info: {},
    });
    const client = makeStubClient({ cancelOrder } as ExchangeMock);

    const result = await client.cancelOrder("ETHUSDT", "abc123");

    expect(cancelOrder).toHaveBeenCalledTimes(1);
    // CCXT's cancelOrder signature requires string (not undefined) for id;
    // we pass empty string and route via params.origClientOrderId for MEXC.
    expect(cancelOrder).toHaveBeenCalledWith("", "ETH/USDT", {
      origClientOrderId: "abc123",
    });
    // Zod lowercases the status field at parse time.
    expect(result.status).toBe("canceled");
    expect(result.symbol).toBe("ETH/USDT");
  });

  it("throws pre-network for non-whitelisted symbol", async () => {
    const cancelOrder = vi.fn();
    const client = makeStubClient({ cancelOrder } as ExchangeMock);

    await expect(client.cancelOrder("DOGEUSDT", "x")).rejects.toThrow(
      /pair not whitelisted/i,
    );
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});

describe("cancelAllOrders (Phase 2 EXEC-06)", () => {
  it("invokes exchange.cancelAllOrders('ETH/USDT') and returns parsed array", async () => {
    const cancelAllOrders = vi.fn().mockResolvedValue([
      { symbol: "ETH/USDT", status: "CANCELED", info: {} },
      { symbol: "ETH/USDT", status: "CANCELED", info: {} },
    ]);
    const client = makeStubClient({
      cancelAllOrders,
    } as ExchangeMock);

    const result = await client.cancelAllOrders("ETHUSDT");

    expect(cancelAllOrders).toHaveBeenCalledWith("ETH/USDT");
    expect(result).toHaveLength(2);
    expect(result[0]?.symbol).toBe("ETH/USDT");
    expect(result[0]?.status).toBe("canceled");
  });

  it("throws pre-network for non-whitelisted symbol", async () => {
    const cancelAllOrders = vi.fn();
    const client = makeStubClient({
      cancelAllOrders,
    } as ExchangeMock);

    await expect(client.cancelAllOrders("BTCUSDT")).rejects.toThrow(
      /pair not whitelisted/i,
    );
    expect(cancelAllOrders).not.toHaveBeenCalled();
  });
});

describe("fetchOpenOrders (Phase 2 EXEC-06 + Pitfall 7 symbol-required)", () => {
  it("invokes exchange.fetchOpenOrders('ETH/USDT') and returns parsed array", async () => {
    const fetchOpenOrders = vi.fn().mockResolvedValue([
      {
        id: "1",
        symbol: "ETH/USDT",
        side: "buy",
        type: "market",
        info: {},
      },
    ]);
    const client = makeStubClient({
      fetchOpenOrders,
    } as ExchangeMock);

    const result = await client.fetchOpenOrders("ETHUSDT");

    expect(fetchOpenOrders).toHaveBeenCalledWith("ETH/USDT");
    expect(result).toHaveLength(1);
    expect(result[0]?.symbol).toBe("ETH/USDT");
  });

  it("throws pre-network for non-whitelisted symbol", async () => {
    const fetchOpenOrders = vi.fn();
    const client = makeStubClient({
      fetchOpenOrders,
    } as ExchangeMock);

    await expect(client.fetchOpenOrders("SOLUSDT")).rejects.toThrow(
      /pair not whitelisted/i,
    );
    expect(fetchOpenOrders).not.toHaveBeenCalled();
  });
});

describe("fetchExchangeInfoForSymbol (Phase 2 EXEC-04 + EXEC-05)", () => {
  it("calls loadMarkets(true) + market('ETH/USDT') + parses market.info", async () => {
    const loadMarkets = vi.fn().mockResolvedValue({});
    const market = vi.fn().mockReturnValue({
      info: {
        symbol: "ETHUSDT",
        status: "1",
        baseAsset: "ETH",
        quoteAsset: "USDT",
        quoteAmountPrecisionMarket: "5",
        takerCommission: "0.002",
      },
    });
    const client = makeStubClient({
      loadMarkets,
      market,
    } as ExchangeMock);

    const info = await client.fetchExchangeInfoForSymbol("ETHUSDT");

    expect(loadMarkets).toHaveBeenCalledWith(true);
    expect(market).toHaveBeenCalledWith("ETH/USDT");
    expect(info.symbol).toBe("ETHUSDT");
    expect(info.quoteAmountPrecisionMarket).toBe("5");
    expect(info.takerCommission).toBe("0.002");
  });

  it("throws pre-network for non-whitelisted symbol (never calls loadMarkets)", async () => {
    const loadMarkets = vi.fn();
    const market = vi.fn();
    const client = makeStubClient({
      loadMarkets,
      market,
    } as ExchangeMock);

    await expect(client.fetchExchangeInfoForSymbol("BTCUSDT")).rejects.toThrow(
      /pair not whitelisted/i,
    );
    expect(loadMarkets).not.toHaveBeenCalled();
    expect(market).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EXEC-02 + EXEC-03 amendment — compile-time TypeScript guarantees.
// These tests use `@ts-expect-error` to prove that the method signatures
// REJECT invalid call shapes at the type layer. Vitest typechecks test files,
// so if any of these stop erroring, the test file won't compile.
// ---------------------------------------------------------------------------

describe("EXEC-02 + EXEC-03 TypeScript enforcement (compile-time)", () => {
  it("rejects placeMarketBuy() call missing clientOrderId (EXEC-02)", () => {
    const client = makeStubClient({} as ExchangeMock);
    // @ts-expect-error - clientOrderId is required by EXEC-02
    void client.placeMarketBuy({ symbol: "ETHUSDT", quoteOrderQty: "5" });
    expect(true).toBe(true); // the assertion is the ts-expect-error above
  });

  it("rejects placeMarketSell() call missing clientOrderId (EXEC-02)", () => {
    const client = makeStubClient({} as ExchangeMock);
    // @ts-expect-error - clientOrderId is required by EXEC-02
    void client.placeMarketSell({ symbol: "ETHUSDT", quantity: "0.001" });
    expect(true).toBe(true);
  });

  it("rejects placeMarketSell() call missing quantity", () => {
    const client = makeStubClient({} as ExchangeMock);
    // @ts-expect-error - quantity is required (market sells need base-asset amount)
    void client.placeMarketSell({ symbol: "ETHUSDT", clientOrderId: "x" });
    expect(true).toBe(true);
  });

  it("rejects stopPrice param (EXEC-03 amendment D-05b — MEXC spot has no server-side stops)", () => {
    const client = makeStubClient({} as ExchangeMock);
    void client.placeMarketBuy({
      symbol: "ETHUSDT",
      clientOrderId: "x",
      quoteOrderQty: "5",
      // @ts-expect-error - stopPrice is NOT a valid param (EXEC-03 amendment, see 02-CONTEXT.md D-05b)
      stopPrice: "3000",
    });
    expect(true).toBe(true);
  });

  it("rejects triggerPrice param (EXEC-03 amendment D-05b)", () => {
    const client = makeStubClient({} as ExchangeMock);
    void client.placeMarketSell({
      symbol: "ETHUSDT",
      clientOrderId: "x",
      quantity: "0.001",
      // @ts-expect-error - triggerPrice is NOT a valid param (EXEC-03 amendment, see 02-CONTEXT.md D-05b)
      triggerPrice: "2900",
    });
    expect(true).toBe(true);
  });

  it("rejects stopLoss / takeProfit params (EXEC-03 amendment D-05b)", () => {
    const client = makeStubClient({} as ExchangeMock);
    void client.placeMarketBuy({
      symbol: "ETHUSDT",
      clientOrderId: "x",
      quoteOrderQty: "5",
      // @ts-expect-error - stopLoss is NOT a valid param (EXEC-03 amendment)
      stopLoss: "2800",
    });
    void client.placeMarketBuy({
      symbol: "ETHUSDT",
      clientOrderId: "x",
      quoteOrderQty: "5",
      // @ts-expect-error - takeProfit is NOT a valid param (EXEC-03 amendment)
      takeProfit: "3500",
    });
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 write-surface invariant: the Phase 1 test used to assert that
// 'createOrder' / 'cancelOrder' / 'placeOrder' were NOT on the wrapper. That
// changed in Phase 2 — cancelOrder is now a legit method. We keep the narrower
// check for the ambiguous 'placeOrder' + 'createOrder' (never added; we use
// typed placeMarketBuy/placeMarketSell instead).
// ---------------------------------------------------------------------------

describe("MEXCSpotClient wrapper surface", () => {
  it("does NOT expose raw placeOrder or createOrder (Phase 2 uses typed placeMarketBuy/placeMarketSell)", () => {
    const proto = Object.getPrototypeOf(MEXCSpotClient.prototype);
    const wrapperMethods = [
      ...Object.getOwnPropertyNames(MEXCSpotClient.prototype),
      ...Object.getOwnPropertyNames(proto),
    ];
    expect(wrapperMethods).not.toContain("placeOrder");
    expect(wrapperMethods).not.toContain("createOrder");
  });

  it("exposes the 5 Phase 2 write methods + fetchExchangeInfoForSymbol", () => {
    const methods = Object.getOwnPropertyNames(MEXCSpotClient.prototype);
    for (const m of [
      "placeMarketBuy",
      "placeMarketSell",
      "cancelOrder",
      "cancelAllOrders",
      "fetchOpenOrders",
      "fetchExchangeInfoForSymbol",
    ]) {
      expect(methods).toContain(m);
    }
  });
});
