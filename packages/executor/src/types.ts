/**
 * Shared types for @kr8tiv/executor — consumed by risk-manager, executor loop,
 * panic sequence, ledger, and the CLI harnesses. Types + constants only; no
 * runtime code (network, I/O, DB). This file exists to give every downstream
 * Phase 2 / Phase 3+ plan a stable contract surface.
 */

/**
 * Event payload read from the `approvals.decided` Redis stream. The test
 * harness (`pnpm place-order` CLI, Plan 02-04) emits these; Phase 3 (Telegram)
 * will replace the origin but preserve this shape.
 *
 * All fields arrive as strings from Redis — the executor parses them into
 * the typed shape below before invoking the handler (Plan 02-03).
 */
export interface ApprovalDecidedEvent {
  /** UUID v4 from the signals.candidate origin. */
  readonly signalId: string;
  /** Executor IGNORES events where approved=false (EXEC-09 architectural invariant). */
  readonly approved: boolean;
  /** Trading pair in MEXC format (e.g. 'ETHUSDT'). Only ETHUSDT allowed in v1 (EXEC-06). */
  readonly pair: string;
  readonly side: "buy" | "sell";
  /** Quote-asset spend for a market buy; for sell, {@link OrderIntent.quantity} is used instead. */
  readonly notionalUsdt: number;
  /** Epoch milliseconds. Part of the sha256 idempotency-key input for `newClientOrderId`. */
  readonly approvalTsMs: number;
}

/**
 * Normalized order-placement intent constructed by the executor from the
 * approval event + pre-order checks. Consumed by @kr8tiv/mexc-spot client
 * wrappers (Plan 02-02).
 *
 * Runtime invariant (enforced by the risk manager, Plan 02-03): exactly ONE of
 * {@link quantity} or {@link quoteOrderQty} MUST be set.
 */
export interface OrderIntent {
  /** MEXC format (e.g. 'ETHUSDT'). */
  readonly pair: string;
  readonly side: "buy" | "sell";
  /** Phase 2 ships market-only per D-06; limit orders enter in Phase 4. */
  readonly type: "market";
  /** 32-char hex — sha256(signalId + approvalTsMs) truncated. Never empty. */
  readonly clientOrderId: string;
  readonly signalId: string;
  readonly approvalTsMs: number;
  /** Base-asset qty for sells (e.g. '0.001' ETH). Exclusive with {@link quoteOrderQty}. */
  readonly quantity?: string;
  /** Quote-asset notional for buys (e.g. '5' USDT). Exclusive with {@link quantity}. */
  readonly quoteOrderQty?: string;
}

/**
 * Result returned after MEXC accepts (or rejects) an order. Shape matches
 * {@link import("@kr8tiv/shared-schemas").MexcOrderResponseSchema} — re-exported
 * here as `OrderResult` for consumer convenience so downstream code imports
 * just from `@kr8tiv/executor`.
 */
export type { OrderResult } from "@kr8tiv/shared-schemas";

/**
 * Reasons the risk manager may reject an order. Exact string literals are
 * part of the error contract — tests grep for these; panic / ledger switch on
 * them. Extend with care (add to unit-test exhaustiveness check).
 */
export type RiskErrorCode =
  | "NOT_ARMED" /** executor:armed=false in Redis — run `pnpm arm` */
  | "PAIR_NOT_WHITELISTED" /** pair is not ETHUSDT (EXEC-06) */
  | "CIRCUIT_TRIPPED" /** realized PnL today <= -$2 (EXEC-01 + D-03) */
  | "BELOW_MIN_NOTIONAL" /** notional < quoteAmountPrecisionMarket (EXEC-04) */
  | "INSUFFICIENT_BALANCE" /** 2*minNotional > free USDT balance (EXEC-04 safety margin) */
  | "DUPLICATE_CLIENT_ORDER_ID" /** MEXC rejected a re-submission (EXEC-02 idempotency) */
  | "UNKNOWN_ERROR"; /** any other exchange / network error */

/**
 * Report returned by the panic sequence (Plan 02-03). Written to the ledger +
 * logged + returned by the `pnpm panic` CLI for operator confirmation.
 */
export interface PanicReport {
  /** True iff executor:armed was set to 'false' during the panic run. */
  frozen: boolean;
  /** ClientOrderIds that were successfully cancelled (may be empty). */
  cancelled: string[];
  /** Base-asset quantity sold during the flatten step (0 if no open position). */
  flattenedQty: number;
  /** ClientOrderId of the flatten order, set only when a flatten was placed. */
  flattenClientOrderId?: string;
  /** Non-fatal issues logged but not thrown (partial cancel failures, etc.). */
  errors: string[];
}

/**
 * Redis key namespace constants. Single source of truth — risk-manager, panic,
 * ledger, boot, CLIs all import these rather than hard-coding strings.
 */
export const REDIS_KEYS = {
  ARMED: "executor:armed",
  /** Append `clientOrderId` for per-order state. */
  ORDER_PREFIX: "executor:orders:",
  /** Append `pair` (e.g. `executor:positions:ETHUSDT`). */
  POSITION_PREFIX: "executor:positions:",
  /** Append UTC date `YYYY-MM-DD` for per-day breaker rollup. */
  BREAKER_PREFIX: "executor:breaker:",
  CONSUMER_LAST_ACK: "executor:consumer:last-ack-id",
} as const;

/**
 * Redis Stream names. Pipeline:
 *   signals.candidate → signals.filtered → approvals.pending → approvals.decided
 *
 * The executor subscribes ONLY to approvals.decided (EXEC-09 — architectural
 * invariant). Phase 4 replaces the origin of `signals.candidate` (ML model);
 * Phase 3 replaces the `approvals.pending → approvals.decided` link (Telegram).
 */
export const STREAMS = {
  SIGNALS_CANDIDATE: "signals.candidate",
  SIGNALS_FILTERED: "signals.filtered",
  APPROVALS_PENDING: "approvals.pending",
  APPROVALS_DECIDED: "approvals.decided",
} as const;

/** Redis Streams consumer group name for the executor. */
export const EXECUTOR_CONSUMER_GROUP = "executor-v1";

/**
 * Phase 2 whitelist. Phase 6 (futures write) will expand this.
 * @see EXEC-06 in REQUIREMENTS.md
 */
export const ALLOWED_PAIRS: readonly string[] = ["ETHUSDT"] as const;

/**
 * Daily realized-PnL circuit breaker threshold in USD (D-03). Crossing this
 * blocks new orders until UTC midnight OR manual `pnpm arm` re-arms.
 */
export const DAILY_LOSS_BREAKER_USD = -2.0;
