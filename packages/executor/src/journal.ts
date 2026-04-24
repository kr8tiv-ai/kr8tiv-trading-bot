import type Database from "better-sqlite3";
import type {
  AccountableTradePlan,
  AccountabilityCheck,
  AccountabilityIssue,
  StyleConflict,
} from "@kr8tiv/shared-schemas";
import { applySchema } from "./schema.js";

/**
 * trade_journal row as consumed by the cockpit + MVP review loop. Extends the
 * Phase 2 shape with:
 *
 *   - `conflicts[]` — style-fingerprint conflicts computed at review time
 *   - `approvalStatus` / `telegram*` / `approvedAtMs` / `rejectedAtMs`
 *     — Semi-auto Telegram approval state so the cockpit can show a pending
 *       → approved/rejected pill per row.
 *
 * Legacy rows (pre-2026-04-24) have NULL in all new fields; the mapper below
 * coerces them into safe defaults so the UI doesn't need null-guard rails.
 */
export type TradeJournalApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export type TradeJournalEntry = AccountableTradePlan &
  AccountabilityCheck & {
    id: number;
    createdAtMs: number;
    conflicts: StyleConflict[];
    approvalStatus: TradeJournalApprovalStatus | null;
    telegramMessageId: number | null;
    telegramChatId: number | null;
    approvedAtMs: number | null;
    rejectedAtMs: number | null;
  };

type TradeJournalRow = {
  id: number;
  created_at_ms: number;
  symbol: AccountableTradePlan["symbol"];
  market: AccountableTradePlan["market"];
  direction: AccountableTradePlan["direction"];
  horizon: AccountableTradePlan["horizon"];
  risk_mode: AccountableTradePlan["riskMode"];
  leverage: number;
  margin_quote: number;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  thesis: string;
  journal_note: string;
  ok_to_proceed: number;
  estimated_loss_quote: number;
  estimated_reward_quote: number;
  risk_reward_ratio: number;
  blocks_json: string;
  warnings_json: string;
  generated_from_signal_id: string | null;
  conflicts_json: string | null;
  telegram_message_id: number | null;
  telegram_chat_id: number | null;
  approval_status: TradeJournalApprovalStatus | null;
  approved_at_ms: number | null;
  rejected_at_ms: number | null;
};

function parseIssues(json: string): AccountabilityIssue[] {
  const parsed = JSON.parse(json) as AccountabilityIssue[];
  return Array.isArray(parsed) ? parsed : [];
}

function parseConflicts(json: string | null): StyleConflict[] {
  if (json === null || json.length === 0) return [];
  try {
    const parsed = JSON.parse(json) as StyleConflict[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapRow(row: TradeJournalRow): TradeJournalEntry {
  return {
    id: row.id,
    createdAtMs: row.created_at_ms,
    symbol: row.symbol,
    market: row.market,
    direction: row.direction,
    horizon: row.horizon,
    riskMode: row.risk_mode,
    leverage: row.leverage,
    marginQuote: row.margin_quote,
    entryPrice: row.entry_price,
    stopLossPrice: row.stop_loss_price,
    takeProfitPrice: row.take_profit_price,
    thesis: row.thesis,
    journalNote: row.journal_note,
    generatedFromSignalId: row.generated_from_signal_id ?? undefined,
    okToProceed: row.ok_to_proceed === 1,
    estimatedLossQuote: row.estimated_loss_quote,
    estimatedRewardQuote: row.estimated_reward_quote,
    riskRewardRatio: row.risk_reward_ratio,
    blocks: parseIssues(row.blocks_json),
    warnings: parseIssues(row.warnings_json),
    conflicts: parseConflicts(row.conflicts_json),
    approvalStatus: row.approval_status,
    telegramMessageId: row.telegram_message_id,
    telegramChatId: row.telegram_chat_id,
    approvedAtMs: row.approved_at_ms,
    rejectedAtMs: row.rejected_at_ms,
  };
}

export type SaveTradeJournalOptions = {
  readonly conflicts?: StyleConflict[];
  /**
   * When set to 'pending', the row is persisted with approval_status='pending'
   * and the cockpit knows to expect a Telegram dispatch. Subsequent mutators
   * (see below) flip this to 'approved' | 'rejected' | 'expired'.
   *
   * When omitted, approval_status is NULL — meaning "journaled but not sent
   * to Telegram". This is the sensible default when TELEGRAM_CHAT_ID is not
   * configured.
   */
  readonly approvalStatus?: TradeJournalApprovalStatus | null;
};

export function saveTradeJournalEntry(
  db: Database.Database,
  plan: AccountableTradePlan,
  review: AccountabilityCheck,
  options: SaveTradeJournalOptions = {},
): number {
  applySchema(db);
  const result = db
    .prepare(
      `INSERT INTO trade_journal (
        created_at_ms, symbol, market, direction, horizon, risk_mode, leverage,
        margin_quote, entry_price, stop_loss_price, take_profit_price, thesis,
        journal_note, ok_to_proceed, estimated_loss_quote, estimated_reward_quote,
        risk_reward_ratio, blocks_json, warnings_json, generated_from_signal_id,
        conflicts_json, approval_status
      ) VALUES (
        @createdAtMs, @symbol, @market, @direction, @horizon, @riskMode, @leverage,
        @marginQuote, @entryPrice, @stopLossPrice, @takeProfitPrice, @thesis,
        @journalNote, @okToProceed, @estimatedLossQuote, @estimatedRewardQuote,
        @riskRewardRatio, @blocksJson, @warningsJson, @generatedFromSignalId,
        @conflictsJson, @approvalStatus
      )`,
    )
    .run({
      ...plan,
      createdAtMs: plan.createdAtMs ?? Date.now(),
      okToProceed: review.okToProceed ? 1 : 0,
      estimatedLossQuote: review.estimatedLossQuote,
      estimatedRewardQuote: review.estimatedRewardQuote,
      riskRewardRatio: review.riskRewardRatio,
      blocksJson: JSON.stringify(review.blocks),
      warningsJson: JSON.stringify(review.warnings),
      generatedFromSignalId: plan.generatedFromSignalId ?? null,
      conflictsJson: JSON.stringify(options.conflicts ?? []),
      approvalStatus: options.approvalStatus ?? null,
    });
  return Number(result.lastInsertRowid);
}

const SELECT_COLUMNS = `id, created_at_ms, symbol, market, direction, horizon, risk_mode,
  leverage, margin_quote, entry_price, stop_loss_price, take_profit_price,
  thesis, journal_note, ok_to_proceed, estimated_loss_quote,
  estimated_reward_quote, risk_reward_ratio, blocks_json, warnings_json,
  generated_from_signal_id, conflicts_json, telegram_message_id, telegram_chat_id,
  approval_status, approved_at_ms, rejected_at_ms`;

export function listRecentTradeJournalEntries(
  db: Database.Database,
  limit = 25,
): TradeJournalEntry[] {
  applySchema(db);
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
      FROM trade_journal
      ORDER BY created_at_ms DESC, id DESC
      LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as TradeJournalRow[];
  return rows.map(mapRow);
}

export function findTradeJournalEntry(
  db: Database.Database,
  id: number,
): TradeJournalEntry | null {
  applySchema(db);
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
      FROM trade_journal
      WHERE id = ?`,
    )
    .get(id) as TradeJournalRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Record that the cockpit has dispatched a Telegram approval card for this
 * journal row. Stores the chat_id + message_id so follow-up callbacks can
 * edit the original card and mark the row approved/rejected.
 */
export function recordTelegramDispatch(
  db: Database.Database,
  id: number,
  args: {
    readonly chatId: number;
    readonly messageId: number;
  },
): void {
  applySchema(db);
  db.prepare(
    `UPDATE trade_journal
    SET telegram_chat_id = @chatId,
        telegram_message_id = @messageId,
        approval_status = COALESCE(approval_status, 'pending')
    WHERE id = @id`,
  ).run({ id, chatId: args.chatId, messageId: args.messageId });
}

/**
 * Flip approval_status for a pending journal row. Rejects transitions from a
 * terminal state (approved/rejected/expired) — callers should read the row
 * first to see what already happened.
 */
export function recordApprovalDecision(
  db: Database.Database,
  id: number,
  decision: "approved" | "rejected" | "expired",
  nowMs: number = Date.now(),
): { changed: boolean; priorStatus: TradeJournalApprovalStatus | null } {
  applySchema(db);
  const prior = db
    .prepare("SELECT approval_status FROM trade_journal WHERE id = ?")
    .get(id) as { approval_status: TradeJournalApprovalStatus | null } | undefined;
  if (!prior) {
    return { changed: false, priorStatus: null };
  }
  const priorStatus = prior.approval_status;
  if (
    priorStatus === "approved" ||
    priorStatus === "rejected" ||
    priorStatus === "expired"
  ) {
    return { changed: false, priorStatus };
  }
  const result = db
    .prepare(
      `UPDATE trade_journal
      SET approval_status = @decision,
          approved_at_ms = CASE WHEN @decision = 'approved' THEN @nowMs ELSE approved_at_ms END,
          rejected_at_ms = CASE WHEN @decision IN ('rejected','expired') THEN @nowMs ELSE rejected_at_ms END
      WHERE id = @id AND approval_status = 'pending'`,
    )
    .run({ id, decision, nowMs });
  return { changed: result.changes > 0, priorStatus };
}
