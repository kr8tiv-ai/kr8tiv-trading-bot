import type { BetterSqliteDatabase } from "@kr8tiv/db";

export type TradeFeedbackAction =
  | "took_trade"
  | "skipped_trade"
  | "broke_rules"
  | "review_later";

export type TraderSettings = {
  capitalBudgetQuote: number;
  defaultMarginQuote: number;
  sniperMarginQuote: number;
  mediumMarginQuote: number;
  coreMarginQuote: number;
  maxDailyLossQuote: number;
  updatedAtMs: number;
};

export type TradeFeedback = {
  id: number;
  journalId: number | null;
  action: TradeFeedbackAction;
  note: string;
  createdAtMs: number;
};

export const DEFAULT_TRADER_SETTINGS: TraderSettings = {
  capitalBudgetQuote: 100,
  defaultMarginQuote: 25,
  sniperMarginQuote: 10,
  mediumMarginQuote: 25,
  coreMarginQuote: 50,
  maxDailyLossQuote: 25,
  updatedAtMs: 0,
};

const SETTINGS_KEYS = [
  "capitalBudgetQuote",
  "defaultMarginQuote",
  "sniperMarginQuote",
  "mediumMarginQuote",
  "coreMarginQuote",
  "maxDailyLossQuote",
] as const;

type SettingKey = (typeof SETTINGS_KEYS)[number];

type SettingRow = {
  key: SettingKey;
  value: string;
  updated_at_ms: number;
};

type FeedbackRow = {
  id: number;
  journal_id: number | null;
  action: TradeFeedbackAction;
  note: string;
  created_at_ms: number;
};

export function ensureTraderAppStateTables(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_id INTEGER,
      action TEXT NOT NULL CHECK (action IN ('took_trade','skipped_trade','broke_rules','review_later')),
      note TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS trade_feedback_created_at
      ON trade_feedback(created_at_ms DESC);
  `);
}

function sanitizeMoney(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n * 100) / 100;
}

function mapFeedback(row: FeedbackRow): TradeFeedback {
  return {
    id: row.id,
    journalId: row.journal_id,
    action: row.action,
    note: row.note,
    createdAtMs: row.created_at_ms,
  };
}

export function readTraderSettings(db: BetterSqliteDatabase): TraderSettings {
  ensureTraderAppStateTables(db);
  const rows = db
    .prepare(
      `SELECT key, value, updated_at_ms
       FROM trader_settings`,
    )
    .all() as SettingRow[];

  const settings: TraderSettings = { ...DEFAULT_TRADER_SETTINGS };
  for (const row of rows) {
    if (!SETTINGS_KEYS.includes(row.key)) continue;
    settings[row.key] = sanitizeMoney(row.value, settings[row.key]);
    settings.updatedAtMs = Math.max(settings.updatedAtMs, row.updated_at_ms);
  }
  return settings;
}

export function saveTraderSettings(
  db: BetterSqliteDatabase,
  patch: Partial<Omit<TraderSettings, "updatedAtMs">>,
  nowMs: number = Date.now(),
): TraderSettings {
  ensureTraderAppStateTables(db);
  const current = readTraderSettings(db);
  const stmt = db.prepare(
    `INSERT INTO trader_settings (key, value, updated_at_ms)
     VALUES (@key, @value, @updatedAtMs)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at_ms = excluded.updated_at_ms`,
  );

  for (const key of SETTINGS_KEYS) {
    if (patch[key] === undefined) continue;
    stmt.run({
      key,
      value: String(sanitizeMoney(patch[key], current[key])),
      updatedAtMs: nowMs,
    });
  }
  return readTraderSettings(db);
}

export function recordTradeFeedback(
  db: BetterSqliteDatabase,
  input: {
    journalId?: number | null;
    action: TradeFeedbackAction;
    note?: string;
  },
  nowMs: number = Date.now(),
): TradeFeedback {
  ensureTraderAppStateTables(db);
  const journalId =
    input.journalId !== null &&
    input.journalId !== undefined &&
    Number.isInteger(input.journalId) &&
    input.journalId > 0
      ? input.journalId
      : null;
  const result = db
    .prepare(
      `INSERT INTO trade_feedback (journal_id, action, note, created_at_ms)
       VALUES (@journalId, @action, @note, @createdAtMs)`,
    )
    .run({
      journalId,
      action: input.action,
      note: input.note?.trim() ?? "",
      createdAtMs: nowMs,
    });

  const row = db
    .prepare(
      `SELECT id, journal_id, action, note, created_at_ms
       FROM trade_feedback
       WHERE id = ?`,
    )
    .get(Number(result.lastInsertRowid)) as FeedbackRow;
  return mapFeedback(row);
}

export function listRecentTradeFeedback(
  db: BetterSqliteDatabase,
  limit = 20,
): TradeFeedback[] {
  ensureTraderAppStateTables(db);
  const rows = db
    .prepare(
      `SELECT id, journal_id, action, note, created_at_ms
       FROM trade_feedback
       ORDER BY created_at_ms DESC, id DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as FeedbackRow[];
  return rows.map(mapFeedback);
}
