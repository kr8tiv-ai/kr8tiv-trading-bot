import { z } from "zod";
import { MarketSchema } from "./market.js";
import { RiskModeSchema } from "./risk.js";

export const ImportedTradeSchema = z.object({
  venue: z.string().min(1),
  market: MarketSchema,
  symbol: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  price: z.number().positive(),
  size: z.number().positive(),
  quoteNotional: z.number().positive(),
  fee: z.number().nonnegative(),
  feeCurrency: z.string().min(1),
  executedAtMs: z.number().int().positive(),
  sourceTradeId: z.string().min(1),
  sourceOrderId: z.string().min(1).optional(),
  leverage: z.number().min(1).max(100).optional(),
  riskMode: RiskModeSchema.optional(),
  thesis: z.string().min(1).optional(),
  journalNote: z.string().min(1).optional(),
  rawResponse: z.string().min(1).optional(),
});
export type ImportedTrade = z.infer<typeof ImportedTradeSchema>;

export const ReconstructedTradeSchema = z
  .object({
    symbol: z.string().min(1),
    market: MarketSchema,
    direction: z.enum(["long", "short"]),
    entryTimeMs: z.number().int().positive(),
    exitTimeMs: z.number().int().positive(),
    holdTimeMs: z.number().int().nonnegative(),
    entryPrice: z.number().positive(),
    exitPrice: z.number().positive(),
    size: z.number().positive(),
    grossPnlQuote: z.number(),
    feesQuote: z.number().nonnegative(),
    netPnlQuote: z.number(),
    entryTradeIds: z.array(z.string().min(1)).min(1),
    exitTradeIds: z.array(z.string().min(1)).min(1),
  })
  .superRefine((trade, ctx) => {
    if (trade.exitTimeMs <= trade.entryTimeMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exitTimeMs must be greater than entryTimeMs",
      });
    }
  });
export type ReconstructedTrade = z.infer<typeof ReconstructedTradeSchema>;

export const HourOfDayExpectancyEntrySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  avgNetPnlQuote: z.number(),
  winRate: z.number().min(0).max(1),
});
export type HourOfDayExpectancyEntry = z.infer<
  typeof HourOfDayExpectancyEntrySchema
>;

export const StyleFingerprintSchema = z.object({
  symbol: z.string().min(1),
  sampleCount: z.number().int().nonnegative(),
  avgHoldTimeMs: z.number().int().nonnegative(),
  medianHoldTimeMs: z.number().int().nonnegative(),
  medianPositionSizeQuote: z.number().nonnegative(),
  winRate: z.number().min(0).max(1),
  avgWinHoldTimeMs: z.number().int().nonnegative(),
  avgLossHoldTimeMs: z.number().int().nonnegative(),
  preferredEntryHoursUtc: z.array(z.number().int().min(0).max(23)),
  hourOfDayExpectancy: z.record(HourOfDayExpectancyEntrySchema),
});
export type StyleFingerprint = z.infer<typeof StyleFingerprintSchema>;

export const StyleConflictCodeSchema = z.enum([
  "outside-preferred-hours",
  "oversized-vs-style",
  "insufficient-style-sample",
]);
export type StyleConflictCode = z.infer<typeof StyleConflictCodeSchema>;

export const StyleConflictSchema = z.object({
  code: StyleConflictCodeSchema,
  severity: z.enum(["info", "warn"]),
  message: z.string().min(1),
  evidence: z.string().min(1).optional(),
});
export type StyleConflict = z.infer<typeof StyleConflictSchema>;
