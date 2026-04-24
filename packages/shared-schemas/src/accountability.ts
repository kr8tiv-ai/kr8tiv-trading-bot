import { z } from "zod";
import { MarketSchema } from "./market.js";
import { AccountableSymbolSchema, RiskModeSchema } from "./risk.js";
import { SignalHorizonSchema } from "./signals.js";
export type { AccountableSymbol, RiskMode } from "./risk.js";

export const AccountableTradePlanSchema = z
  .object({
    symbol: AccountableSymbolSchema,
    market: MarketSchema,
    direction: z.enum(["long", "short"]),
    horizon: SignalHorizonSchema,
    riskMode: RiskModeSchema,
    leverage: z.number().min(1).max(100),
    marginQuote: z.number().positive(),
    entryPrice: z.number().positive(),
    stopLossPrice: z.number().positive(),
    takeProfitPrice: z.number().positive(),
    thesis: z.string().min(20),
    journalNote: z.string().min(10),
    generatedFromSignalId: z.string().min(1).optional(),
    createdAtMs: z.number().int().positive().optional(),
  })
  .superRefine((plan, ctx) => {
    if (plan.market !== "mexc-futures") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "accountable trade plans are futures-first",
      });
    }
    if (
      plan.direction === "long" &&
      plan.stopLossPrice >= plan.entryPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "long stopLossPrice must sit below entryPrice",
      });
    }
    if (
      plan.direction === "long" &&
      plan.takeProfitPrice <= plan.entryPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "long takeProfitPrice must sit above entryPrice",
      });
    }
    if (
      plan.direction === "short" &&
      plan.stopLossPrice <= plan.entryPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "short stopLossPrice must sit above entryPrice",
      });
    }
    if (
      plan.direction === "short" &&
      plan.takeProfitPrice >= plan.entryPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "short takeProfitPrice must sit below entryPrice",
      });
    }
  });
export type AccountableTradePlan = z.infer<
  typeof AccountableTradePlanSchema
>;

export const AccountabilityIssueCodeSchema = z.enum([
  "missing-thesis",
  "invalid-stop",
  "invalid-target",
  "leverage-mode-mismatch",
  "high-leverage",
  "poor-risk-reward",
]);
export type AccountabilityIssueCode = z.infer<
  typeof AccountabilityIssueCodeSchema
>;

export const AccountabilityIssueSchema = z.object({
  code: AccountabilityIssueCodeSchema,
  message: z.string().min(1),
});
export type AccountabilityIssue = z.infer<typeof AccountabilityIssueSchema>;

export const AccountabilityCheckSchema = z.object({
  okToProceed: z.boolean(),
  estimatedLossQuote: z.number().nonnegative(),
  estimatedRewardQuote: z.number().nonnegative(),
  riskRewardRatio: z.number().nonnegative(),
  blocks: z.array(AccountabilityIssueSchema),
  warnings: z.array(AccountabilityIssueSchema),
});
export type AccountabilityCheck = z.infer<typeof AccountabilityCheckSchema>;
