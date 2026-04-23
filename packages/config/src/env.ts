import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { config as loadDotenv } from "dotenv";

// Load .env.local if present (non-secret config only — secrets are in Credential Manager)
loadDotenv({ path: ".env.local" });

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    MEXC_SPOT_BASE_URL: z.string().url().default("https://api.mexc.com"),
    MEXC_FUTURES_BASE_URL: z.string().url().default("https://contract.mexc.com"),
    MEXC_RECV_WINDOW_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
    REDIS_URL: z.string().url().default("redis://127.0.0.1:6379"),
    SQLITE_PATH: z.string().default("./data/core.sqlite"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    LOG_PRETTY: z.coerce.boolean().default(true),
    TELEGRAM_CHAT_ID: z
      .string()
      .regex(/^-?\d+$/, "TELEGRAM_CHAT_ID must be a numeric Telegram chat id")
      .optional(),
    TELEGRAM_SIGNAL_TTL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300000)
      .default(90000),
    TELEGRAM_DAILY_SIGNAL_CAP: z.coerce.number().int().min(1).max(20).default(5),
    TELEGRAM_PAIR_REJECT_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .min(60000)
      .max(86400000)
      .default(1800000),
    TELEGRAM_PRICE_DRIFT_BPS: z.coerce.number().int().min(1).max(500).default(30),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
