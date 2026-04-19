/**
 * @kr8tiv/executor — MEXC spot write path with safety rails.
 *
 * Phase 2 public surface (this plan — 02-01):
 *   • Shared types: ApprovalDecidedEvent, OrderIntent, OrderResult, RiskErrorCode, PanicReport
 *   • Constants:    REDIS_KEYS, STREAMS, EXECUTOR_CONSUMER_GROUP, ALLOWED_PAIRS, DAILY_LOSS_BREAKER_USD
 *   • Schema:       applySchema(db), SCHEMA_SQL
 *
 * Future additions (Plan 02-03):
 *   • startExecutor(redis, handler) — Redis Streams consumer lifecycle
 *   • runRiskGate(order, state)      — pre-order synchronous risk check
 *   • makeClientOrderId(signalId, approvalTsMs) — sha256 idempotency key
 *   • panic(redis, spot, db)         — cancel-flatten-freeze sequence
 *   • ledger write / read helpers    — orders, fills, realized_pnl
 */
export * from "./types.js";
export * from "./schema.js";
