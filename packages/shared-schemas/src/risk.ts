import { z } from "zod";

export const RiskModeSchema = z.enum(["sniper", "core"]);
export type RiskMode = z.infer<typeof RiskModeSchema>;

export const AccountableSymbolSchema = z.enum(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
export type AccountableSymbol = z.infer<typeof AccountableSymbolSchema>;
