import { z } from "zod";

export const MarketSchema = z.enum(["mexc-futures", "mexc-spot"]);
export type Market = z.infer<typeof MarketSchema>;

export const MarketRegimeSchema = z.enum(["bullish", "bearish", "range"]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const SignalBiasSchema = z.enum(["long", "short", "neutral"]);
export type SignalBias = z.infer<typeof SignalBiasSchema>;

export const SignalHorizonSchema = z.enum(["scalp", "swing"]);
export type SignalHorizon = z.infer<typeof SignalHorizonSchema>;

export const MarketCandleSchema = z
  .object({
    openTimeMs: z.number().int().nonnegative(),
    closeTimeMs: z.number().int().positive(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative(),
    quoteVolume: z.number().nonnegative().optional(),
  })
  .superRefine((candle, ctx) => {
    if (candle.closeTimeMs <= candle.openTimeMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "closeTimeMs must be greater than openTimeMs",
      });
    }
    if (candle.high < candle.low) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "high must be >= low",
      });
    }
    if (candle.high < candle.open || candle.high < candle.close) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "high must be >= open and close",
      });
    }
    if (candle.low > candle.open || candle.low > candle.close) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "low must be <= open and close",
      });
    }
  });
export type MarketCandle = z.infer<typeof MarketCandleSchema>;

export const StrategySignalSchema = z.object({
  strategy: z.string().min(1),
  timeframe: z.string().min(1),
  bias: SignalBiasSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  metrics: z.record(z.string(), z.number()).optional(),
});
export type StrategySignal = z.infer<typeof StrategySignalSchema>;

export const TradeIdeaSchema = z
  .object({
    symbol: z.string().min(1),
    market: MarketSchema,
    direction: z.enum(["long", "short"]),
    horizon: SignalHorizonSchema,
    confidence: z.number().min(0).max(1),
    entryPrice: z.number().positive(),
    invalidationPrice: z.number().positive(),
    targets: z.array(z.number().positive()).min(1),
    thesis: z.string().min(1),
    reasons: z.array(z.string().min(1)).min(1),
    strategies: z.array(StrategySignalSchema),
  })
  .superRefine((idea, ctx) => {
    if (
      idea.direction === "long" &&
      idea.invalidationPrice >= idea.entryPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "long invalidation must sit below entryPrice",
      });
    }
    if (
      idea.direction === "short" &&
      idea.invalidationPrice <= idea.entryPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "short invalidation must sit above entryPrice",
      });
    }
  });
export type TradeIdea = z.infer<typeof TradeIdeaSchema>;

export const MarketScanSchema = z.object({
  symbol: z.string().min(1),
  market: MarketSchema,
  currentPrice: z.number().positive(),
  regime: MarketRegimeSchema,
  warnings: z.array(z.string()),
  strategies: z.array(StrategySignalSchema),
  ideas: z.array(TradeIdeaSchema),
});
export type MarketScan = z.infer<typeof MarketScanSchema>;

