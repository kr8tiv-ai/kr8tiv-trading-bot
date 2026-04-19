import ccxt, { type Exchange } from "ccxt";
import { env } from "@kr8tiv/config";
import { unsafeReveal, type SecretProvider } from "@kr8tiv/secrets";
import {
  MexcBalanceResponseSchema,
  MexcPingResponseSchema,
  MexcOrderResponseSchema,
  MexcCancelResponseSchema,
  MexcExchangeInfoSchema,
  type AccountInfo,
  type OrderResult,
  type CancelResult,
  type ExchangeInfo,
} from "@kr8tiv/shared-schemas";
import { toCcxtSymbol } from "./symbol.js";

// Derived array schemas — built via the `.array()` method on existing Zod
// schemas so we don't need a direct `zod` import in this package (zod is
// transitively available via @kr8tiv/shared-schemas). The pattern keeps the
// "ccxt imported in exactly 2 files" invariant intact AND avoids adding a
// second cross-package type graph.
const MexcCancelResponseArraySchema = MexcCancelResponseSchema.array();
const MexcOrderResponseArraySchema = MexcOrderResponseSchema.array();

export interface MEXCSpotClientConfig {
  /** SecretProvider that has mexc-spot-access + mexc-spot-secret provisioned. */
  secrets: SecretProvider;
  /** Override for tests. Defaults to env.MEXC_SPOT_BASE_URL. */
  baseUrl?: string;
  /** Override for tests. Defaults to env.MEXC_RECV_WINDOW_MS. */
  recvWindowMs?: number;
}

/**
 * MEXC spot client — read (Phase 1) + write (Phase 2) methods.
 *
 * Phase 1 surface:
 * - ping() for boot-time connectivity smoke test
 * - getAccountInfo() for FND-06 verification (returns Zod-validated balance)
 *
 * Phase 2 surface (this plan — 02-02):
 * - placeMarketBuy / placeMarketSell — market orders with required clientOrderId (EXEC-02)
 * - cancelOrder / cancelAllOrders — cancellation primitives for panic + reconcile
 * - fetchOpenOrders — symbol-scoped open-order listing for reconciler
 * - fetchExchangeInfoForSymbol — quoteAmountPrecisionMarket + takerCommission source (EXEC-04/05)
 *
 * EXEC-03 amendment (2026-04-18, documented in 02-CONTEXT.md §D-05b):
 * MEXC Spot v3 REST does NOT support server-side stop-loss / triggerPrice orders.
 * Supported order types per MEXC docs + CCXT feature map: LIMIT | LIMIT_MAKER |
 * MARKET | IOC | FOK. No stopPrice / triggerPrice / stopLoss / takeProfit
 * parameters are accepted by MEXC's POST /api/v3/order.
 *
 * Therefore this class DOES NOT expose any stop-attachment method or parameter.
 * Any attempt to add such a field to a method signature must be rejected at
 * code review — Phase 2 relies on CLI-driven `pnpm panic` cancel as the only
 * loss-containment mechanism for spot orders, per 02-CONTEXT.md §D-05b.
 *
 * Phase 6 (Futures Write) re-enables server-side stops where MEXC does support
 * `triggerPrice` — on USDT-M contracts, not spot.
 *
 * D-06 (Phase 2 market-only): placeLimitBuy / placeLimitSell are deferred to
 * Phase 4 when the ML/rule signal layer emits specific entry prices.
 */
export class MEXCSpotClient {
  // Exposed read-only for tests that poke at options.defaultType without going
  // through CCXT's public API. Downstream code should NOT use this to place
  // orders — use the typed write methods below, which go through Zod + the
  // ETHUSDT whitelist chokepoint.
  readonly exchange: Exchange;

  private constructor(exchange: Exchange) {
    this.exchange = exchange;
  }

  static async create(config: MEXCSpotClientConfig): Promise<MEXCSpotClient> {
    const baseUrl = config.baseUrl ?? env.MEXC_SPOT_BASE_URL;
    const recvWindow = config.recvWindowMs ?? env.MEXC_RECV_WINDOW_MS;

    const [accessSecret, secretSecret] = await Promise.all([
      config.secrets.get("mexc-spot-access"),
      config.secrets.get("mexc-spot-secret"),
    ]);

    const exchange = new ccxt.mexc({
      apiKey: unsafeReveal(accessSecret),
      secret: unsafeReveal(secretSecret),
      enableRateLimit: true,
      timeout: 10_000,
      options: {
        defaultType: "spot",
        recvWindow,
        // Phase 2 addition — stops ccxt from requiring a `price` argument on
        // market buys (ccxt's default is a Binance-style precision assertion
        // that doesn't match MEXC's $-cost semantics). See 02-RESEARCH.md
        // Pitfall 3 + ccxt issues #3460, #23784.
        createMarketBuyOrderRequiresPrice: false,
        // Phase 2 addition — enables the quoteOrderQty-as-$-cost semantics
        // MEXC actually uses for market buys. With this flag, passing
        // `params.quoteOrderQty` lets us spend exactly N USDT without needing
        // a base-asset amount. See ccxt issue #25660.
        createMarketBuyOrderWithCost: true,
      },
      urls: {
        api: {
          spot: baseUrl,
          spotPublic: baseUrl,
          spotPrivate: baseUrl,
        },
      },
    } as ConstructorParameters<typeof ccxt.mexc>[0]) as Exchange;

    return new MEXCSpotClient(exchange);
  }

  /**
   * FND-08 smoke-test support. Hits public MEXC `/api/v3/time` (no auth needed).
   * CCXT does not expose a unified ping for every exchange, so we use the
   * implicit method or raw fetch as a fallback.
   *
   * Returns `{ serverTime: number }` after Zod parse.
   */
  async ping(): Promise<{ serverTime: number }> {
    // CCXT's MEXC integration exposes `publicGetTime` as an implicit method.
    // Per 01-RESEARCH.md Open Question 2, exact method names can drift; guard with fallback.
    let raw: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
    const implicit = (this.exchange as any).publicGetTime;
    if (typeof implicit === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
      raw = await (this.exchange as any).publicGetTime();
    } else {
      // Fallback: raw fetch against the configured base URL.
      const url = `${env.MEXC_SPOT_BASE_URL}/api/v3/time`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`MEXC spot /time failed: HTTP ${resp.status}`);
      raw = await resp.json();
    }
    return MexcPingResponseSchema.parse(raw);
  }

  /**
   * Read-only: fetch spot account balances via CCXT's unified method.
   * Parsed through Zod — malformed responses throw at the boundary, not
   * silently at the executor.
   */
  async getAccountInfo(): Promise<AccountInfo> {
    const raw = await this.exchange.fetchBalance({ type: "spot" });
    return MexcBalanceResponseSchema.parse(raw);
  }

  // -------------------------------------------------------------------------
  // Phase 2 write methods. See class-level JSDoc + 02-CONTEXT.md D-05b / D-06.
  // Every write method:
  //   1. Goes through toCcxtSymbol() for EXEC-06 whitelist enforcement.
  //   2. Takes clientOrderId as a REQUIRED typed argument (EXEC-02).
  //   3. Parses the ccxt response through the matching Zod schema.
  //   4. Forwards clientOrderId to MEXC via params.newClientOrderId.
  // -------------------------------------------------------------------------

  /**
   * Market buy. clientOrderId is REQUIRED — TypeScript rejects calls without
   * it, enforcing EXEC-02 at compile time.
   *
   * Exactly ONE of `quoteOrderQty` (quote-asset $ cost, e.g. spend 5 USDT) or
   * `quantity` (base-asset amount, e.g. buy 0.001 ETH) should be supplied.
   * Most Phase 2 callers use `quoteOrderQty` because the risk manager sizes
   * in USDT notional. If both are set, MEXC takes `quoteOrderQty` precedence
   * and ignores the `amount` positional arg.
   */
  async placeMarketBuy(p: {
    symbol: string;
    clientOrderId: string;
    quoteOrderQty?: string;
    quantity?: string;
  }): Promise<OrderResult> {
    const ccxtSymbol = toCcxtSymbol(p.symbol); // EXEC-06 chokepoint
    const params: Record<string, unknown> = {
      newClientOrderId: p.clientOrderId,
    };
    if (p.quoteOrderQty !== undefined) params.quoteOrderQty = p.quoteOrderQty;
    // When quoteOrderQty is set, amount is ignored by MEXC (spend-$X semantics
    // win). When quantity is set instead, amount = Number(quantity). If neither
    // is set, MEXC will reject the order with a parameter error — we do not
    // try to enforce "exactly one of" at the TS level because both are optional
    // by design (the risk manager owns that check upstream).
    const amount = p.quantity !== undefined ? Number(p.quantity) : 0;
    const raw = await this.exchange.createOrder(
      ccxtSymbol,
      "market",
      "buy",
      amount,
      undefined,
      params,
    );
    return MexcOrderResponseSchema.parse(raw);
  }

  /**
   * Market sell. Base-asset quantity only — `quoteOrderQty` is not meaningful
   * for sells in MEXC's model (you sell N of an asset, not sell-until-you-get
   * $N). clientOrderId REQUIRED per EXEC-02.
   */
  async placeMarketSell(p: {
    symbol: string;
    clientOrderId: string;
    quantity: string;
  }): Promise<OrderResult> {
    const ccxtSymbol = toCcxtSymbol(p.symbol);
    const params: Record<string, unknown> = {
      newClientOrderId: p.clientOrderId,
    };
    const raw = await this.exchange.createOrder(
      ccxtSymbol,
      "market",
      "sell",
      Number(p.quantity),
      undefined,
      params,
    );
    return MexcOrderResponseSchema.parse(raw);
  }

  // Phase 4 — see 02-CONTEXT D-06 — placeLimitBuy / placeLimitSell when signals
  // need specific entry prices. Not implemented in Phase 2.

  /**
   * Cancel a single order by its origClientOrderId (our idempotency key).
   * Prefer this over exchange.cancelOrder(id) because we may not retain the
   * MEXC orderId across retries; the clientOrderId is deterministic from
   * (signal_id, approval_ts) per the idempotency spec.
   *
   * MEXC's ccxt driver accepts either positional `id` OR
   * `params.origClientOrderId` — we always use the latter.
   */
  async cancelOrder(
    symbol: string,
    clientOrderId: string,
  ): Promise<CancelResult> {
    const ccxtSymbol = toCcxtSymbol(symbol);
    // CCXT's cancelOrder signature requires `id: string`. For MEXC we route
    // via origClientOrderId in params; pass empty string for id (MEXC ignores
    // it when origClientOrderId is present — confirmed in 02-RESEARCH.md).
    const raw = await this.exchange.cancelOrder("", ccxtSymbol, {
      origClientOrderId: clientOrderId,
    });
    return MexcCancelResponseSchema.parse(raw);
  }

  /**
   * Cancel all open orders for a whitelisted symbol. Maps to MEXC's
   * DELETE /api/v3/openOrders?symbol=X (via CCXT unified). Returns the
   * list of cancelled orders (may be empty if none were open).
   *
   * Used by the panic CLI (Plan 02-04) as the first step of the
   * cancel-flatten-freeze sequence.
   */
  async cancelAllOrders(symbol: string): Promise<CancelResult[]> {
    const ccxtSymbol = toCcxtSymbol(symbol);
    const raw = await this.exchange.cancelAllOrders(ccxtSymbol);
    return MexcCancelResponseArraySchema.parse(raw);
  }

  /**
   * Fetch all currently-open orders for a whitelisted symbol. Symbol is
   * REQUIRED per MEXC's ccxt driver (`symbolRequired: true`) — Pitfall 7
   * in 02-RESEARCH.md.
   *
   * Consumed by the reconciler (Plan 02-04 stub / Plan 05 automated) for
   * stale-state recovery at boot.
   */
  async fetchOpenOrders(symbol: string): Promise<OrderResult[]> {
    const ccxtSymbol = toCcxtSymbol(symbol);
    const raw = await this.exchange.fetchOpenOrders(ccxtSymbol);
    return MexcOrderResponseArraySchema.parse(raw);
  }

  /**
   * Fetch MEXC exchangeInfo for a whitelisted symbol, parsed through Zod.
   * Returns `quoteAmountPrecisionMarket` (minNotional for market orders per
   * 02-RESEARCH.md Pattern 2) and `takerCommission` (per Pattern 8 fee cache).
   * Uses CCXT's loaded markets + force refresh so we see the current MEXC
   * state.
   *
   * Consumed by risk-manager (Plan 02-03) for EXEC-04 minNotional check and
   * fee-cache for EXEC-05.
   */
  async fetchExchangeInfoForSymbol(symbol: string): Promise<ExchangeInfo> {
    const ccxtSymbol = toCcxtSymbol(symbol);
    await this.exchange.loadMarkets(true); // force refresh — cheap, O(1) cache line
    const market = this.exchange.market(ccxtSymbol);
    // CCXT's market.info holds the raw MEXC exchangeInfo.symbol entry — the
    // raw object with quoteAmountPrecisionMarket + takerCommission in the
    // original string format. Zod parse validates the subset we consume.
    return MexcExchangeInfoSchema.parse(market.info);
  }
}
