import { z } from "zod";
import {
  MarketRegimeSchema,
  SignalHorizonSchema,
  type MarketRegime,
} from "./signals.js";

export const SignalWatchEventTypeSchema = z.enum([
  "regime-changed",
  "idea-opened",
  "idea-updated",
  "idea-closed",
]);
export type SignalWatchEventType = z.infer<typeof SignalWatchEventTypeSchema>;

export const SignalWatchEventSchema = z.object({
  eventId: z.string().min(1),
  symbol: z.string().min(1),
  eventType: SignalWatchEventTypeSchema,
  occurredAtMs: z.number().int().positive(),
  regime: MarketRegimeSchema,
  currentPrice: z.number().positive(),
  title: z.string().min(1),
  message: z.string().min(1),
  previousRegime: MarketRegimeSchema.optional(),
  ideaKey: z.string().min(1).optional(),
  direction: z.enum(["long", "short"]).optional(),
  horizon: SignalHorizonSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  previousConfidence: z.number().min(0).max(1).optional(),
});
export type SignalWatchEvent = z.infer<typeof SignalWatchEventSchema>;

export interface MarketWatchSnapshot {
  readonly symbol: string;
  readonly regime: MarketRegime;
}

