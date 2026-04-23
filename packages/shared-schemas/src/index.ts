/**
 * Shared Zod runtime schemas for kr8tiv-mexc-bot.
 *
 * Plan 01-04 populates the MEXC surface. Further schemas per phase:
 * - Plan 02-xx: order-placement request/response schemas
 * - Plan 03-xx: Telegram approval-loop payloads and status responses
 * - Plan 04-xx: trade history + style fingerprint schemas
 */
export * from "./mexc.js";
export * from "./telegram.js";
