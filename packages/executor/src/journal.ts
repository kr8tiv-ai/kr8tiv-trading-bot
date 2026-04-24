import type Database from "better-sqlite3";
import type {
  AccountableTradePlan,
  AccountabilityCheck,
  AccountabilityIssue,
} from "@kr8tiv/shared-schemas";
import { applySchema } from "./schema.js";

export type TradeJournalEntry = AccountableTradePlan &
  AccountabilityCheck & {
    id: number;
    createdAtMs: number;
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
};

function parseIssues(json: string): AccountabilityIssue[] {
  const parsed = JSON.parse(json) as AccountabilityIssue[];
  return Array.isArray(parsed) ? parsed : [];
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
  };
}

export function saveTradeJournalEntry(
  db: Database.Database,
  plan: AccountableTradePlan,
  review: AccountabilityCheck,
): number {
  applySchema(db);
  const result = db
    .prepare(
      `INSERT INTO trade_journal (
        created_at_ms, symbol, market, direction, horizon, risk_mode, leverage,
        margin_quote, entry_price, stop_loss_price, take_profit_price, thesis,
        journal_note, ok_to_proceed, estimated_loss_quote, estimated_reward_quote,
        risk_reward_ratio, blocks_json, warnings_json, generated_from_signal_id
      ) VALUES (
        @createdAtMs, @symbol, @market, @direction, @horizon, @riskMode, @leverage,
        @marginQuote, @entryPrice, @stopLossPrice, @takeProfitPrice, @thesis,
        @journalNote, @okToProceed, @estimatedLossQuote, @estimatedRewardQuote,
        @riskRewardRatio, @blocksJson, @warningsJson, @generatedFromSignalId
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
    });
  return Number(result.lastInsertRowid);
}

export function listRecentTradeJournalEntries(
  db: Database.Database,
  limit = 25,
): TradeJournalEntry[] {
  applySchema(db);
  const rows = db
    .prepare(
      `SELECT
        id, created_at_ms, symbol, market, direction, horizon, risk_mode,
        leverage, margin_quote, entry_price, stop_loss_price, take_profit_price,
        thesis, journal_note, ok_to_proceed, estimated_loss_quote,
        estimated_reward_quote, risk_reward_ratio, blocks_json, warnings_json,
        generated_from_signal_id
      FROM trade_journal
      ORDER BY created_at_ms DESC, id DESC
      LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as TradeJournalRow[];
  return rows.map(mapRow);
}
