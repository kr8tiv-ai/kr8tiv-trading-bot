/**
 * @kr8tiv/executor — MEXC spot write path with safety rails.
 *
 * Phase 2 public surface:
 *   • Types + constants (Plan 02-01): ApprovalDecidedEvent, OrderIntent,
 *     OrderResult, RiskErrorCode, PanicReport, REDIS_KEYS, STREAMS,
 *     EXECUTOR_CONSUMER_GROUP, ALLOWED_PAIRS, DAILY_LOSS_BREAKER_USD.
 *   • Schema (Plan 02-01): applySchema(db), SCHEMA_SQL.
 *   • Idempotency (Plan 02-03): makeClientOrderId(signalId, approvalTsMs).
 *   • Circuit breaker (Plan 02-03): CircuitBreaker, DAILY_LOSS_BREAKER_USD.
 *   • State helpers (Plan 02-03): isArmed, setArmed, recordOrder,
 *     stalePositionsExist, getFreeUsdtBalance.
 *   • Risk manager (Plan 02-03): RiskError, ensureOrderPossible, PreOrderCheck.
 *   • Fee cache (Plan 02-03): getTakerFeeBps, resetFeeCache.
 *   • Ledger (Plan 02-03): writeSubmitted, writeAcceptedOrRejected, writeFill,
 *     readRealizedPnlForUtcToday.
 *   • Panic (Plan 02-03): panic(spot, redis, db, log) — cancel-flatten-freeze.
 *   • Executor loop (Plan 02-03): startExecutor, buildApprovalHandler,
 *     parseApprovalDecided, ApprovalHandler type.
 */

export { CircuitBreaker, DAILY_LOSS_BREAKER_USD } from "./breaker.js";
export type { ApprovalHandler } from "./executor.js";
export {
  buildApprovalHandler,
  parseApprovalDecided,
  startExecutor,
} from "./executor.js";
export { getTakerFeeBps, resetFeeCache } from "./fee-cache.js";
export { makeClientOrderId } from "./idempotency.js";
export type {
  SaveTradeJournalOptions,
  TradeJournalApprovalStatus,
  TradeJournalEntry,
} from "./journal.js";
export {
  findTradeJournalEntry,
  listRecentTradeJournalEntries,
  recordApprovalDecision,
  recordTelegramDispatch,
  saveTradeJournalEntry,
} from "./journal.js";
export {
  readRealizedPnlForUtcToday,
  writeAcceptedOrRejected,
  writeFill,
  writeSubmitted,
} from "./ledger.js";
export { panic } from "./panic.js";
export type {
  InsertPaperOrderArgs,
  PaperOrder,
  PaperOrderStatus,
} from "./paper-orders.js";
export {
  closePaperOrderManual,
  computeRealizedPnl,
  insertPaperOrder,
  listOpenPaperOrders,
  listRecentPaperOrders,
  tickPaperOrders,
} from "./paper-orders.js";
export type { PreOrderCheck } from "./risk-manager.js";
export { ensureOrderPossible, RiskError } from "./risk-manager.js";
export * from "./schema.js";
export {
  getFreeUsdtBalance,
  isArmed,
  recordOrder,
  setArmed,
  stalePositionsExist,
} from "./state.js";
export * from "./types.js";
