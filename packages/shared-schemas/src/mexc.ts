import { z } from "zod";

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
 * Response: { success: boolean, code: number, data: number }
 * Where `data` is the server timestamp (ms).
 * Docs: https://www.mexc.com/api-docs/futures/market-endpoints
 */
export const MexcFuturesPingSchema = z.object({
  success: z.boolean(),
  code: z.number(),
  data: z.number().int().positive(),
});
export type MexcFuturesPing = z.infer<typeof MexcFuturesPingSchema>;

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
