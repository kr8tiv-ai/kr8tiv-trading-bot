import { z } from "zod";

export const MarketSchema = z.enum(["mexc-futures", "mexc-spot"]);
export type Market = z.infer<typeof MarketSchema>;
