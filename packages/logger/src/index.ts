import pino, { type Logger, type LoggerOptions } from "pino";
import os from "node:os";
import { env } from "@kr8tiv/config";

/**
 * Redaction paths — three defense layers (this plus @kr8tiv/secrets brand type plus gitleaks).
 * Uses pino's path syntax: `a.b`, `a.b.*`, `**.secret`, `a["b-c"].d`.
 * Wildcards carry ~50% overhead vs explicit paths — acceptable in Phase 1; add explicit hot-path
 * paths in later phases if log volume warrants.
 */
export const REDACTION_PATHS = [
  // Top-level shapes
  "apiKey",
  "secret",
  "password",
  "token",
  "apiSecret",
  // Nested one-level
  "*.apiKey",
  "*.secret",
  "*.password",
  "*.token",
  "*.apiSecret",
  // Nested two-level (pino doesn't support `**` arbitrary depth — enumerate depths explicitly)
  "*.*.apiKey",
  "*.*.secret",
  "*.*.password",
  "*.*.token",
  "*.*.apiSecret",
  // Nested three-level — covers deep axios/ccxt error echoes without loop pathology
  "*.*.*.apiKey",
  "*.*.*.secret",
  // HTTP headers (common in axios/ccxt error dumps)
  'req.headers["x-mexc-apikey"]',
  'req.headers["x-mexc-signature"]',
  'req.headers["authorization"]',
  'res.headers["set-cookie"]',
  // MEXC-specific
  "mexc.apiKey",
  "mexc.secret",
  // Telegram (scaffold for Phase 3)
  "telegramToken",
  "telegram.token",
  "*.telegramToken",
  // Wallets (scaffold for Phase 7)
  "walletAddress",
  "*.walletAddress",
  // Generic key patterns
  "*.key",
  "*.Key",
  // Axios/ccxt request config echoes
  "config.apiKey",
  "config.secret",
  "config.headers",
] as const;

export function createLogger(overrides: Partial<LoggerOptions> = {}): Logger {
  const baseOpts: LoggerOptions = {
    name: "kr8tiv-mexc-bot",
    level: env.LOG_LEVEL,
    base: { pid: process.pid, hostname: os.hostname() },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACTION_PATHS],
      censor: "[REDACTED]",
      remove: false,
    },
    ...(env.LOG_PRETTY
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard", singleLine: false },
          },
        }
      : {}),
    ...overrides,
  };
  return pino(baseOpts);
}

export const logger: Logger = createLogger();
