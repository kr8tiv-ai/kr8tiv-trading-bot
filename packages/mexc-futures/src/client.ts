import { env } from "@kr8tiv/config";
import { type SecretProvider, unsafeReveal } from "@kr8tiv/secrets";
import {
  type ImportedTrade,
  ImportedTradeSchema,
  type MarketCandle,
  MarketCandleSchema,
  MexcBalanceResponseSchema,
  type MexcFuturesAccountSnapshot,
  MexcFuturesAccountSnapshotSchema,
  MexcFuturesFundingRateResponseSchema,
  MexcFuturesKlineResponseSchema,
  type MexcFuturesMarketContext,
  MexcFuturesMarketContextSchema,
  type MexcFuturesOpenOrder,
  MexcFuturesOpenOrderSchema,
  MexcFuturesPingSchema,
  MexcFuturesTickerResponseSchema,
  MexcPingResponseSchema,
} from "@kr8tiv/shared-schemas";
import ccxt, { type Exchange } from "ccxt";

export interface MEXCFuturesClientConfig {
  secrets: SecretProvider;
  /** Override for tests. Defaults to env.MEXC_FUTURES_BASE_URL. */
  baseUrl?: string;
}

export const SUPPORTED_FUTURES_SIGNAL_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
export type SupportedFuturesSignalSymbol = (typeof SUPPORTED_FUTURES_SIGNAL_SYMBOLS)[number];

export const FUTURES_KLINE_INTERVAL_MS = {
  Min1: 60_000,
  Min5: 300_000,
  Min15: 900_000,
  Min30: 1_800_000,
  Hour1: 3_600_000,
  Hour4: 14_400_000,
  Day1: 86_400_000,
} as const;
export type FuturesKlineInterval = keyof typeof FUTURES_KLINE_INTERVAL_MS;

export interface FetchFuturesCandlesParams {
  symbol: SupportedFuturesSignalSymbol | string;
  interval: FuturesKlineInterval;
  limit?: number;
}

export interface FetchFuturesTradesPageParams {
  symbol: SupportedFuturesSignalSymbol | string;
  since?: number;
  limit?: number;
}

export interface FetchFuturesOpenOrdersParams {
  symbols?: readonly (SupportedFuturesSignalSymbol | string)[];
}

const MarketCandleArraySchema = MarketCandleSchema.array();

function toMexcContractSymbol(symbol: FetchFuturesCandlesParams["symbol"]): string {
  if (!SUPPORTED_FUTURES_SIGNAL_SYMBOLS.includes(symbol as SupportedFuturesSignalSymbol)) {
    throw new Error(`unsupported futures symbol: ${symbol}`);
  }
  return symbol.replace("USDT", "_USDT");
}

function toCcxtSwapSymbol(symbol: FetchFuturesTradesPageParams["symbol"]): string {
  if (!SUPPORTED_FUTURES_SIGNAL_SYMBOLS.includes(symbol as SupportedFuturesSignalSymbol)) {
    throw new Error(`unsupported futures symbol: ${symbol}`);
  }
  return symbol.replace("USDT", "/USDT:USDT");
}

function fromCcxtSwapSymbol(symbol: unknown): SupportedFuturesSignalSymbol | null {
  if (typeof symbol !== "string") return null;
  const normalized = symbol.replace("/USDT:USDT", "USDT");
  return SUPPORTED_FUTURES_SIGNAL_SYMBOLS.includes(normalized as SupportedFuturesSignalSymbol)
    ? (normalized as SupportedFuturesSignalSymbol)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asOptionalNumber(
  value: unknown,
  mode: "nonnegative" | "positive" = "nonnegative",
): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = asNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) return undefined;
  if (mode === "positive") return parsed > 0 ? parsed : undefined;
  return parsed >= 0 ? parsed : undefined;
}

function asString(value: unknown, fallback: string = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Read-only MEXC USDT-M futures (swap) client — STUB in Phase 1.
 *
 * Current behavior:
 * - Public ping works with NO authentication (futures ping is a public endpoint).
 * - Prefer mexc-futures-access / mexc-futures-secret when provisioned.
 * - Fall back to the existing mexc-spot-access / mexc-spot-secret key pair so a
 *   single full-permission MEXC key can power read-only futures account panels.
 * - If neither pair is present, construct with empty apiKey/secret; public
 *   methods keep working and private read methods fail only when called.
 *
 * Phase 6 adds write-path methods (placeFuturesOrder, etc.) AND requires
 * futures credentials to be present.
 *
 * Separation invariant (Pitfall 1 defense):
 * - Own CCXT instance (separate from MEXCSpotClient) -> separate rate-limit bucket.
 * - Own base URL scope (urls.api.swap/swapPublic/swapPrivate) -> Jan 12 2026
 *   MEXC futures domain migration is a one-line env change, not a code change.
 */
export class MEXCFuturesClient {
  readonly exchange: Exchange;
  readonly baseUrl: string;
  private privateClockSync: Promise<void> | null = null;

  private constructor(exchange: Exchange, baseUrl: string) {
    this.exchange = exchange;
    this.baseUrl = baseUrl;
  }

  static async create(config: MEXCFuturesClientConfig): Promise<MEXCFuturesClient> {
    const baseUrl = config.baseUrl ?? env.MEXC_FUTURES_BASE_URL;

    const [hasFuturesAccess, hasFuturesSecret, hasSpotAccess, hasSpotSecret] = await Promise.all([
      config.secrets.has("mexc-futures-access"),
      config.secrets.has("mexc-futures-secret"),
      config.secrets.has("mexc-spot-access"),
      config.secrets.has("mexc-spot-secret"),
    ]);
    const credentialNames =
      hasFuturesAccess && hasFuturesSecret
        ? (["mexc-futures-access", "mexc-futures-secret"] as const)
        : hasSpotAccess && hasSpotSecret
          ? (["mexc-spot-access", "mexc-spot-secret"] as const)
          : null;

    const apiKey =
      credentialNames === null ? "" : unsafeReveal(await config.secrets.get(credentialNames[0]));
    const secret =
      credentialNames === null ? "" : unsafeReveal(await config.secrets.get(credentialNames[1]));

    const exchange = new ccxt.mexc({
      apiKey,
      secret,
      enableRateLimit: true,
      timeout: 10_000,
      options: {
        adjustForTimeDifference: true,
        defaultType: "swap",
        // Private futures reads can fail if Windows clock skew is >5s. Keep
        // boot strict elsewhere, but give the live account panel room to read.
        recvWindow: Math.max(env.MEXC_RECV_WINDOW_MS, 60_000),
      },
      urls: {
        api: {
          swap: baseUrl,
          swapPublic: baseUrl,
          swapPrivate: baseUrl,
        },
      },
    } as ConstructorParameters<typeof ccxt.mexc>[0]) as Exchange;

    return new MEXCFuturesClient(exchange, baseUrl);
  }

  private async ensurePrivateClockSync(): Promise<void> {
    const exchangeWithClock = this.exchange as Exchange & {
      loadTimeDifference?: () => Promise<unknown>;
    };
    if (typeof exchangeWithClock.loadTimeDifference !== "function") return;
    this.privateClockSync ??= exchangeWithClock
      .loadTimeDifference()
      .then(() => undefined)
      .catch(() => undefined);
    await this.privateClockSync;
  }

  /**
   * Public MEXC futures ping: GET /api/v1/contract/ping.
   * Returns `{ success, code, data }` where `data` is the server epoch ms.
   * Adapter converts to the unified `{ serverTime: number }` shape.
   *
   * Per 01-RESEARCH.md Open Question 1, CCXT's implicit method name may drift.
   * Try `contractPublicGetPing` first; fall back to raw fetch.
   */
  async ping(): Promise<{ serverTime: number }> {
    let raw: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
    const implicit = (this.exchange as any).contractPublicGetPing;
    if (typeof implicit === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
      raw = await (this.exchange as any).contractPublicGetPing();
    } else {
      const url = `${this.baseUrl}/api/v1/contract/ping`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`MEXC futures /ping failed: HTTP ${resp.status} from ${url}`);
      }
      raw = await resp.json();
    }

    // Parse through the futures-specific schema first, then adapt.
    const parsed = MexcFuturesPingSchema.parse(raw);
    if (!parsed.success) {
      throw new Error(`MEXC futures /ping returned success=false (code=${parsed.code})`);
    }
    // Unified shape the boot sequence expects.
    return MexcPingResponseSchema.parse({ serverTime: parsed.data });
  }

  /**
   * Public futures kline fetch used by the read-only signal scanner. Uses the
   * official MEXC contract endpoint and returns normalized MarketCandle objects
   * with millisecond timestamps. `limit` is translated into a rolling
   * start/end window because the API exposes a time range rather than a direct
   * `limit=N` parameter.
   */
  async fetchCandles(params: FetchFuturesCandlesParams): Promise<MarketCandle[]> {
    const contractSymbol = toMexcContractSymbol(params.symbol);
    const intervalMs = FUTURES_KLINE_INTERVAL_MS[params.interval];
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 200), 2), 500);
    const endSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = endSeconds - Math.ceil((intervalMs / 1000) * limit);
    const url =
      `${this.baseUrl}/api/v1/contract/kline/${contractSymbol}` +
      `?interval=${params.interval}&start=${startSeconds}&end=${endSeconds}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`MEXC futures kline failed: HTTP ${resp.status} from ${url}`);
    }

    const parsed = MexcFuturesKlineResponseSchema.parse(await resp.json());
    if (!parsed.success) {
      throw new Error(`MEXC futures kline returned success=false (code=${parsed.code})`);
    }

    const candles = parsed.data.time.map((openTimeSec, index) => ({
      openTimeMs: openTimeSec * 1000,
      closeTimeMs: openTimeSec * 1000 + intervalMs,
      open: parsed.data.open[index] ?? 0,
      high: parsed.data.high[index] ?? 0,
      low: parsed.data.low[index] ?? 0,
      close: parsed.data.close[index] ?? 0,
      volume: parsed.data.vol[index] ?? 0,
      quoteVolume: parsed.data.amount[index],
    }));
    return MarketCandleArraySchema.parse(candles);
  }

  /**
   * Read-only authenticated futures trade history page. This is intentionally
   * not a write-path unlock: it only feeds style/fingerprint/accountability
   * analytics from Matt's actual BTC/ETH/SOL futures behavior.
   */
  async fetchMyTradesPage(params: FetchFuturesTradesPageParams): Promise<ImportedTrade[]> {
    await this.ensurePrivateClockSync();
    const ccxtSymbol = toCcxtSwapSymbol(params.symbol);
    const raw = await this.exchange.fetchMyTrades(ccxtSymbol, params.since, params.limit, {
      type: "swap",
    });

    const rows = raw.map((item) => {
      const trade = asRecord(item);
      const info = asRecord(trade.info);
      const fee = asRecord(trade.fee);
      const price = asNumber(trade.price);
      const size = asNumber(trade.amount);
      const timestamp = asNumber(trade.timestamp);
      const sourceOrderId = asString(trade.order);
      const sourceTradeId = asString(
        trade.id,
        asString(info.dealId, `${timestamp}:${trade.side}:${price}:${size}`),
      );

      return {
        venue: "mexc",
        market: "mexc-futures",
        symbol: params.symbol,
        side: trade.side,
        price,
        size,
        quoteNotional: asNumber(trade.cost, price * size),
        fee: asNumber(fee.cost),
        feeCurrency: asString(fee.currency, "USDT"),
        executedAtMs: timestamp,
        sourceTradeId,
        sourceOrderId: sourceOrderId || undefined,
        rawResponse: JSON.stringify(Object.keys(info).length > 0 ? info : trade),
      };
    });

    return ImportedTradeSchema.array().parse(rows);
  }

  /**
   * Read-only authenticated futures open orders for the cockpit exposure panel.
   * This intentionally does not unlock any write path; it only lets the web app
   * show resting BTC/ETH/SOL orders next to current positions.
   */
  async fetchOpenOrders(
    params: FetchFuturesOpenOrdersParams = {},
  ): Promise<MexcFuturesOpenOrder[]> {
    await this.ensurePrivateClockSync();
    const symbols = params.symbols ?? SUPPORTED_FUTURES_SIGNAL_SYMBOLS;
    const fetchOpenOrders = (
      this.exchange as unknown as {
        fetchOpenOrders: (
          symbol?: string,
          since?: number,
          limit?: number,
          params?: unknown,
        ) => Promise<unknown[]>;
      }
    ).fetchOpenOrders;

    const pages = await Promise.all(
      symbols.map(async (symbol) => {
        const ccxtSymbol = toCcxtSwapSymbol(symbol);
        return await fetchOpenOrders.call(this.exchange, ccxtSymbol, undefined, undefined, {
          type: "swap",
        });
      }),
    );

    return pages.flat().flatMap((item) => {
      const order = asRecord(item);
      const info = asRecord(order.info);
      const symbol = fromCcxtSwapSymbol(order.symbol);
      if (symbol === null) return [];
      const side = asString(order.side).toLowerCase();
      if (side !== "buy" && side !== "sell") return [];
      const amount = asOptionalNumber(order.amount);
      const filled = asOptionalNumber(order.filled);
      const cost = asOptionalNumber(order.cost);
      const price = asOptionalNumber(order.price, "positive");
      const timestamp = asOptionalNumber(order.timestamp);
      const normalized = {
        id: asString(order.id) || undefined,
        clientOrderId: asString(order.clientOrderId) || undefined,
        symbol,
        side,
        type: asString(order.type, "unknown"),
        status: asString(order.status) || undefined,
        ...(amount !== undefined ? { amount } : {}),
        ...(filled !== undefined ? { filled } : {}),
        ...(cost !== undefined ? { cost } : {}),
        ...(price !== undefined ? { price } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        rawResponse: JSON.stringify(Object.keys(info).length > 0 ? info : order),
      };
      return [MexcFuturesOpenOrderSchema.parse(normalized)];
    });
  }

  /**
   * Read-only authenticated futures account snapshot for live-time coaching.
   * Normalizes USDT margin balance and currently-open BTC/ETH/SOL positions.
   * This is deliberately observational; no futures write methods are unlocked.
   */
  async fetchAccountSnapshot(): Promise<MexcFuturesAccountSnapshot> {
    await this.ensurePrivateClockSync();
    const [rawBalance, rawPositions, openOrders] = await Promise.all([
      this.exchange.fetchBalance({ type: "swap" }),
      // CCXT's Exchange type can lag exchange-specific support; MEXC swap has it.
      (
        this.exchange as unknown as {
          fetchPositions: (symbols?: string[], params?: unknown) => Promise<unknown[]>;
        }
      ).fetchPositions(
        SUPPORTED_FUTURES_SIGNAL_SYMBOLS.map((symbol) => toCcxtSwapSymbol(symbol)),
        { type: "swap" },
      ),
      this.fetchOpenOrders(),
    ]);

    const balance = MexcBalanceResponseSchema.parse(rawBalance);
    const positions = rawPositions.flatMap((item) => {
      const position = asRecord(item);
      const symbol = fromCcxtSwapSymbol(position.symbol);
      if (symbol === null) return [];
      const contracts = asNumber(position.contracts);
      if (contracts <= 0) return [];
      const info = asRecord(position.info);
      const side = asString(position.side).toLowerCase();
      const leverage = asOptionalNumber(position.leverage, "positive") ?? asNumber(info.leverage);
      const entryPrice =
        asOptionalNumber(position.entryPrice, "positive") ??
        asNumber(info.holdAvgPrice, asNumber(info.holdAvgPriceFullyScale));
      const markPrice =
        asOptionalNumber(position.markPrice, "positive") ??
        asNumber(info.markPrice, asNumber(info.fairPrice, entryPrice));
      const marginQuote = asNumber(info.im, asNumber(info.oim));
      const notionalQuote =
        asOptionalNumber(position.notional, "positive") ??
        (marginQuote > 0 && leverage > 0 ? marginQuote * leverage : 0);
      const liquidationPrice =
        asOptionalNumber(position.liquidationPrice, "positive") ?? asNumber(info.liquidatePrice);
      return {
        symbol,
        side: side === "short" ? "short" : "long",
        contracts,
        notionalQuote,
        entryPrice,
        markPrice,
        unrealizedPnl: asNumber(position.unrealizedPnl),
        leverage,
        liquidationPrice,
        marginMode: asString(position.marginMode) || undefined,
        rawResponse: JSON.stringify(Object.keys(info).length > 0 ? info : position),
      };
    });

    return MexcFuturesAccountSnapshotSchema.parse({
      usdt: {
        total: asNumber(balance.total.USDT),
        free: asNumber(balance.free.USDT),
        used: asNumber(balance.used.USDT),
      },
      positions,
      openOrders,
      fetchedAtMs: Date.now(),
    });
  }

  /**
   * Public futures context for signal scoring. Uses official contract endpoints:
   * - GET /api/v1/contract/ticker?symbol=BTC_USDT
   * - GET /api/v1/contract/funding_rate/BTC_USDT
   *
   * This adds a lightweight "fundamental/context" layer: funding pressure,
   * fair/index basis, 24h amount, and holdVol (MEXC's open-interest-ish field).
   */
  async fetchMarketContext(
    symbol: SupportedFuturesSignalSymbol | string,
  ): Promise<MexcFuturesMarketContext> {
    const contractSymbol = toMexcContractSymbol(symbol);
    const tickerUrl = `${this.baseUrl}/api/v1/contract/ticker?symbol=${contractSymbol}`;
    const fundingUrl = `${this.baseUrl}/api/v1/contract/funding_rate/${contractSymbol}`;

    const [tickerResp, fundingResp] = await Promise.all([fetch(tickerUrl), fetch(fundingUrl)]);

    if (!tickerResp.ok) {
      throw new Error(`MEXC futures ticker failed: HTTP ${tickerResp.status} from ${tickerUrl}`);
    }
    if (!fundingResp.ok) {
      throw new Error(`MEXC futures funding failed: HTTP ${fundingResp.status} from ${fundingUrl}`);
    }

    const ticker = MexcFuturesTickerResponseSchema.parse(await tickerResp.json());
    const funding = MexcFuturesFundingRateResponseSchema.parse(await fundingResp.json());
    if (!ticker.success) {
      throw new Error(`MEXC futures ticker returned success=false (code=${ticker.code})`);
    }
    if (!funding.success) {
      throw new Error(`MEXC futures funding returned success=false (code=${funding.code})`);
    }

    return MexcFuturesMarketContextSchema.parse({
      symbol: contractSymbol.replace("_USDT", "USDT"),
      lastPrice: ticker.data.lastPrice,
      indexPrice: ticker.data.indexPrice,
      fairPrice: ticker.data.fairPrice,
      basisPct:
        ticker.data.lastPrice <= 0
          ? 0
          : (ticker.data.fairPrice - ticker.data.indexPrice) / ticker.data.lastPrice,
      fundingRate: funding.data.fundingRate,
      nextSettleTime: funding.data.nextSettleTime,
      collectCycleHours: funding.data.collectCycle,
      volume24: ticker.data.volume24,
      amount24: ticker.data.amount24,
      holdVol: ticker.data.holdVol,
      riseFallRate: ticker.data.riseFallRate,
      high24Price: ticker.data.high24Price,
      low24Price: ticker.data.lower24Price,
      timestamp: Math.max(ticker.data.timestamp, funding.data.timestamp),
    });
  }

  // NO order-placement methods here. Phase 6 adds placeFuturesOrder etc.
}
