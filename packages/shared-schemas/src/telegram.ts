import { z } from "zod";

/**
 * Phase 3 approval card payload rendered to Telegram. This is the
 * user-visible contract for the approval loop and stays transport-agnostic so
 * tests can validate it without a live Telegram bot token.
 */
export const TelegramApprovalCardSchema = z.object({
  signalId: z.string().min(1),
  pair: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  entryPrice: z.number().positive(),
  stopPrice: z.number().positive(),
  targetPrice: z.number().positive(),
  confidence: z.number().min(0).max(1),
  regime: z.string().min(1),
  fundingRatePct: z.number().finite().nullable(),
  rationale: z.string().min(1),
  currentPrice: z.number().positive(),
  priceDeltaBps: z.number().finite(),
  estimatedFeeUsd: z.number().nonnegative(),
  estimatedSlippageUsd: z.number().nonnegative(),
  conflictsWithStyle: z.string().min(1).nullable(),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
});
export type TelegramApprovalCard = z.infer<typeof TelegramApprovalCardSchema>;

/**
 * Compact callback payload encoded into Telegram's 64-byte callback_data
 * limit. `issuedAtMs` doubles as the cache-busting timestamp and the
 * idempotency-linked approval timestamp input.
 */
export const TelegramApprovalCallbackSchema = z.object({
  version: z.literal("ap1"),
  action: z.enum(["approve", "reject"]),
  signalId: z.string().min(1),
  issuedAtMs: z.number().int().positive(),
});
export type TelegramApprovalCallback = z.infer<
  typeof TelegramApprovalCallbackSchema
>;

/**
 * Snapshot returned by `/status`.
 */
export const TelegramStatusSnapshotSchema = z.object({
  openPositions: z.number().int().nonnegative(),
  todaysPnlUsd: z.number().finite(),
  todaysSignalCount: z.number().int().nonnegative(),
  circuitBreakerTripped: z.boolean(),
  executorArmed: z.boolean(),
});
export type TelegramStatusSnapshot = z.infer<typeof TelegramStatusSnapshotSchema>;
