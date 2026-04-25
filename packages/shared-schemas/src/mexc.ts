import { z } from "zod";
import { AccountableSymbolSchema } from "./risk.js";

/**
 * GET /api/v3/time (MEXC spot)
 * Response: { serverTime: number }
 * Docs: https://www.mexc.com/api-docs/spot-v3/market-data-endpoints
 */
export const MexcSpotTimeSchema = z.object({
  serverTime: z.number().int().positive(),
});
export type MexcSpotTime = z.infer<typeof MexcSpotTimeSchema>;

/**
 * GET /api/v1/contract/ping (MEXC futures/contract)
 * Response: { success: boolean, code: number|string, data: number|string }
 * Where `data` is the server timestamp (ms).
 *
 * Empirical finding 2026-04-18 against live contract.mexc.com: this endpoint
 * returns `code` and `data` as STRINGS ("0" and "1763515965654") not numbers
 * despite docs showing them as numbers. Use z.coerce.number() to accept both.
 * Docs: https://www.mexc.com/api-docs/futures/market-endpoints
 */
export const MexcFuturesPingSchema = z.object({
  success: z.boolean(),
  code: z.coerce.number(),
  data: z.coerce.number().int().positive(),
});
export type MexcFuturesPing = z.infer<typeof MexcFuturesPingSchema>;

/**
 * GET /api/v1/contract/kline/{symbol} (MEXC futures/contract)
 * Public futures candlesticks used by the Phase 4 signal scanner. The API
 * returns parallel numeric arrays keyed by `time/open/close/high/low/vol`.
 * `time` is in epoch SECONDS (empirically verified 2026-04-23).
 *
 * Docs: https://www.mexc.com/api-docs/futures/market-endpoints
 */
const MexcNumericSeriesSchema = z.array(z.coerce.number());
export const MexcFuturesKlineDataSchema = z
  .object({
    time: z.array(z.coerce.number().int().positive()),
    open: MexcNumericSeriesSchema,
    close: MexcNumericSeriesSchema,
    high: MexcNumericSeriesSchema,
    low: MexcNumericSeriesSchema,
    vol: MexcNumericSeriesSchema,
    amount: MexcNumericSeriesSchema.optional().default([]),
  })
  .superRefine((data, ctx) => {
    const requiredLengths = [
      data.time.length,
      data.open.length,
      data.close.length,
      data.high.length,
      data.low.length,
      data.vol.length,
    ];
    if (new Set(requiredLengths).size !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "kline arrays must all have identical lengths",
      });
    }
    if (data.amount.length !== 0 && data.amount.length !== data.time.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "amount array must be empty or match time.length",
      });
    }
  });
export type MexcFuturesKlineData = z.infer<typeof MexcFuturesKlineDataSchema>;

export const MexcFuturesKlineResponseSchema = z.object({
  success: z.boolean(),
  code: z.coerce.number(),
  data: MexcFuturesKlineDataSchema,
});
export type MexcFuturesKlineResponse = z.infer<
  typeof MexcFuturesKlineResponseSchema
>;

/**
 * Unified ping response used by both MEXCSpotClient.ping() and MEXCFuturesClient.ping().
 * The clients adapt each surface's raw response into this shape so the boot
 * sequence (plan 01-05) gets a consistent `{ serverTime: number }`.
 */
export const MexcPingResponseSchema = z.object({
  serverTime: z.number().int().positive(),
});
export type MexcPingResponse = z.infer<typeof MexcPingResponseSchema>;

/**
 * CCXT unified fetchBalance response (trimmed to the fields we guarantee).
 *
 * CCXT returns:
 *   {
 *     info: <raw exchange response — opaque>,
 *     total: Record<currency, number>,
 *     free:  Record<currency, number>,
 *     used:  Record<currency, number>,
 *     [currency: string]: { total, free, used }
 *   }
 *
 * We capture only the four well-known keys; the per-currency access pattern
 * `bal.USDT.free` is not modeled in this schema (CCXT's types are too dynamic
 * to pin down safely — callers use the records instead).
 */
export const MexcBalanceResponseSchema = z.object({
  info: z.unknown(),
  total: z.record(z.string(), z.number()),
  free: z.record(z.string(), z.number()),
  used: z.record(z.string(), z.number()),
});
export type AccountInfo = z.infer<typeof MexcBalanceResponseSchema>;

export const MexcFuturesPositionSchema = z.object({
  symbol: AccountableSymbolSchema,
  side: z.enum(["long", "short", "flat"]),
  contracts: z.number().nonnegative(),
  notionalQuote: z.number().nonnegative(),
  entryPrice: z.number().nonnegative(),
  markPrice: z.number().nonnegative(),
  unrealizedPnl: z.number(),
  leverage: z.number().nonnegative(),
  liquidationPrice: z.number().nonnegative().optional(),
  marginMode: z.string().min(1).optional(),
  rawResponse: z.string().optional(),
});
export type MexcFuturesPosition = z.infer<typeof MexcFuturesPositionSchema>;

export const MexcFuturesAccountSnapshotSchema = z.object({
  usdt: z.object({
    total: z.number().nonnegative(),
    free: z.number().nonnegative(),
    used: z.number().nonnegative(),
  }),
  positions: z.array(MexcFuturesPositionSchema),
  fetchedAtMs: z.number().int().positive(),
});
export type MexcFuturesAccountSnapshot = z.infer<
  typeof MexcFuturesAccountSnapshotSchema
>;

const MexcFuturesTickerDataSchema = z.object({
  symbol: z.string().min(1),
  lastPrice: z.coerce.number().positive(),
  bid1: z.coerce.number().positive().optional(),
  ask1: z.coerce.number().positive().optional(),
  volume24: z.coerce.number().nonnegative(),
  amount24: z.coerce.number().nonnegative(),
  holdVol: z.coerce.number().nonnegative(),
  lower24Price: z.coerce.number().positive(),
  high24Price: z.coerce.number().positive(),
  riseFallRate: z.coerce.number(),
  riseFallValue: z.coerce.number().optional(),
  indexPrice: z.coerce.number().positive(),
  fairPrice: z.coerce.number().positive(),
  fundingRate: z.coerce.number(),
  timestamp: z.coerce.number().int().positive(),
});

export const MexcFuturesTickerResponseSchema = z.object({
  success: z.boolean(),
  code: z.coerce.number(),
  data: MexcFuturesTickerDataSchema,
});
export type MexcFuturesTickerResponse = z.infer<
  typeof MexcFuturesTickerResponseSchema
>;

const MexcFuturesFundingRateDataSchema = z.object({
  symbol: z.string().min(1),
  fundingRate: z.coerce.number(),
  maxFundingRate: z.coerce.number(),
  minFundingRate: z.coerce.number(),
  collectCycle: z.coerce.number().int().positive(),
  nextSettleTime: z.coerce.number().int().positive(),
  timestamp: z.coerce.number().int().positive(),
});

export const MexcFuturesFundingRateResponseSchema = z.object({
  success: z.boolean(),
  code: z.coerce.number(),
  data: MexcFuturesFundingRateDataSchema,
});
export type MexcFuturesFundingRateResponse = z.infer<
  typeof MexcFuturesFundingRateResponseSchema
>;

export const MexcFuturesMarketContextSchema = z.object({
  symbol: AccountableSymbolSchema,
  lastPrice: z.number().positive(),
  indexPrice: z.number().positive(),
  fairPrice: z.number().positive(),
  basisPct: z.number(),
  fundingRate: z.number(),
  nextSettleTime: z.number().int().positive(),
  collectCycleHours: z.number().int().positive(),
  volume24: z.number().nonnegative(),
  amount24: z.number().nonnegative(),
  holdVol: z.number().nonnegative(),
  riseFallRate: z.number(),
  high24Price: z.number().positive(),
  low24Price: z.number().positive(),
  timestamp: z.number().int().positive(),
});
export type MexcFuturesMarketContext = z.infer<
  typeof MexcFuturesMarketContextSchema
>;

// ---------------------------------------------------------------------------
// Phase 2 additions — order / cancel / fill / exchangeInfo response shapes.
// Consumed by @kr8tiv/mexc-spot write methods (Plan 02-02) and @kr8tiv/executor
// risk-manager + fee-cache (Plan 02-03). "Zod at the response boundary" — every
// MEXC write-path response parses through one of these before reaching
// downstream code.
// ---------------------------------------------------------------------------

/**
 * CCXT unified `createOrder` / `fetchOrder` / `fetchOpenOrders` response.
 * MEXC's raw fields live in `info`. We capture the unified fields we actually
 * read downstream, and allow `info` to be passed through opaque (z.unknown).
 *
 * Docs: https://docs.ccxt.com/#/README?id=order-structure
 * MEXC raw docs: https://www.mexc.com/api-docs/spot-v3/spot-account-trade
 */
export const MexcOrderResponseSchema = z.object({
  id: z.string().min(1).optional(), // CCXT unified orderId
  clientOrderId: z.string().min(1).optional(), // CCXT unified — may be null if exchange didn't echo
  symbol: z.string().min(1), // e.g. 'ETH/USDT'
  side: z.enum(["buy", "sell"]),
  type: z.string().min(1), // e.g. 'market', 'limit' — looser than enum for future exp.
  status: z.string().min(1).optional(), // e.g. 'open', 'closed', 'canceled', 'filled' (CCXT) or 'FILLED'/'NEW' (MEXC raw)
  amount: z.number().nonnegative().optional(), // base-asset requested qty
  filled: z.number().nonnegative().optional(), // base-asset executed qty
  cost: z.number().nonnegative().optional(), // quote-asset notional cost
  price: z.number().positive().optional(), // avg fill price
  fee: z
    .object({ cost: z.number().nonnegative(), currency: z.string().min(1) })
    .optional(),
  info: z.unknown(), // raw MEXC response (origClientOrderId, executedQty, cummulativeQuoteQty, etc.)
  timestamp: z.number().int().nonnegative().optional(),
});
export type OrderResult = z.infer<typeof MexcOrderResponseSchema>;

/**
 * CCXT cancel-order response (both unified and raw MEXC). Status is normalized
 * to lowercase at parse time so downstream code can compare against 'canceled'.
 */
export const MexcCancelResponseSchema = z.object({
  id: z.string().min(1).optional(),
  clientOrderId: z.string().min(1).optional(),
  origClientOrderId: z.string().min(1).optional(), // MEXC raw field — what we match by
  symbol: z.string().min(1),
  status: z
    .string()
    .min(1)
    .transform((s) => s.toLowerCase()) // 'CANCELED' -> 'canceled'
    .optional(),
  info: z.unknown(),
});
export type CancelResult = z.infer<typeof MexcCancelResponseSchema>;

/**
 * Fill (trade) returned by MEXC after order execution. CCXT unified shape.
 * The `fills` table in SQLite (schema.sql) mirrors this schema.
 */
export const MexcFillSchema = z.object({
  id: z.string().min(1).optional(),
  order: z.string().min(1).optional(), // references the parent order's id
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  amount: z.number().positive(),
  price: z.number().positive(),
  cost: z.number().nonnegative(),
  fee: z.object({ cost: z.number().nonnegative(), currency: z.string().min(1) }),
  timestamp: z.number().int().nonnegative().optional(),
  info: z.unknown().optional(),
});
export type FillResult = z.infer<typeof MexcFillSchema>;

/**
 * Subset of MEXC's exchangeInfo.symbols[] entry — the fields the risk manager
 * + fee cache consume. Accepts CCXT's `market.info` passthrough.
 * `quoteAmountPrecisionMarket` is the ONLY source of truth for market-order
 * minNotional per 02-RESEARCH.md Pattern 2.
 *
 * Docs: https://www.mexc.com/api-docs/spot-v3/market-data-endpoints
 */
export const MexcExchangeInfoSchema = z.object({
  symbol: z.string().min(1),
  status: z.string().min(1),
  baseAsset: z.string().min(1),
  quoteAsset: z.string().min(1),
  baseAssetPrecision: z.number().int().nonnegative().optional(),
  quotePrecision: z.number().int().nonnegative().optional(),
  // Precision fields — MEXC returns these as strings; keep as strings to avoid
  // float drift.
  quoteAmountPrecision: z.string().min(1).optional(), // min notional for LIMIT orders
  quoteAmountPrecisionMarket: z.string().min(1).optional(), // min notional for MARKET orders (D-06 relies on this)
  baseSizePrecision: z.string().min(1).optional(),
  // Commission rates — nullable because CCXT's market.info doesn't always
  // surface these; fee-cache falls back to a per-exchange call when null.
  takerCommission: z.union([z.string(), z.number()]).nullable().optional(),
  makerCommission: z.union([z.string(), z.number()]).nullable().optional(),
});
export type ExchangeInfo = z.infer<typeof MexcExchangeInfoSchema>;
