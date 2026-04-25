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

export type StrategyBacktestSnapshotInput = {
  generatedAtMs: number;
  interval: string;
  limit: number;
  symbol: string;
  currentPrice: number;
  comparison: {
    recommendation: string;
    best: ({ strategy: string } & Record<string, unknown>) | null;
    results: Array<{
      strategy: string;
      trades?: unknown[];
      netPnlPct: number;
      winRate: number;
      profitFactor: number;
      maxDrawdownPct: number;
      warnings?: string[];
    }>;
  };
};

export type StrategyEffectivenessStrategy = {
  strategy: string;
  samples: number;
  latestGeneratedAtMs: number;
  latestNetPnlPct: number;
  latestWinRate: number;
  latestProfitFactor: number;
  latestMaxDrawdownPct: number;
  latestTradeCount: number;
  avgNetPnlPct: number;
  avgProfitFactor: number;
  score: number;
  warnings: string[];
};

export type StrategyEffectiveness = {
  symbol: string;
  bestStrategy: string | null;
  latestRecommendation: string;
  latestCurrentPrice: number;
  latestGeneratedAtMs: number;
  snapshotCount: number;
  strategies: StrategyEffectivenessStrategy[];
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

type StrategyBacktestSnapshotRow = {
  id: number;
  generated_at_ms: number;
  interval: string;
  candle_limit: number;
  symbol: string;
  strategy: string;
  current_price: number;
  net_pnl_pct: number;
  win_rate: number;
  profit_factor: number;
  max_drawdown_pct: number;
  trade_count: number;
  recommendation: string;
  is_best: 0 | 1;
  warnings_json: string;
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

    CREATE TABLE IF NOT EXISTS strategy_backtest_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at_ms INTEGER NOT NULL,
      interval TEXT NOT NULL,
      candle_limit INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      strategy TEXT NOT NULL,
      current_price REAL NOT NULL,
      net_pnl_pct REAL NOT NULL,
      win_rate REAL NOT NULL,
      profit_factor REAL NOT NULL,
      max_drawdown_pct REAL NOT NULL,
      trade_count INTEGER NOT NULL,
      recommendation TEXT NOT NULL,
      is_best INTEGER NOT NULL DEFAULT 0 CHECK (is_best IN (0, 1)),
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS strategy_backtest_snapshots_symbol_generated
      ON strategy_backtest_snapshots(symbol, generated_at_ms DESC, id DESC);
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

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeWarnings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function recordBacktestComparison(
  db: BetterSqliteDatabase,
  input: StrategyBacktestSnapshotInput,
  nowMs: number = Date.now(),
): void {
  ensureTraderAppStateTables(db);
  const stmt = db.prepare(
    `INSERT INTO strategy_backtest_snapshots (
       generated_at_ms,
       interval,
       candle_limit,
       symbol,
       strategy,
       current_price,
       net_pnl_pct,
       win_rate,
       profit_factor,
       max_drawdown_pct,
       trade_count,
       recommendation,
       is_best,
       warnings_json,
       created_at_ms
     ) VALUES (
       @generatedAtMs,
       @interval,
       @limit,
       @symbol,
       @strategy,
       @currentPrice,
       @netPnlPct,
       @winRate,
       @profitFactor,
       @maxDrawdownPct,
       @tradeCount,
       @recommendation,
       @isBest,
       @warningsJson,
       @createdAtMs
     )`,
  );

  for (const result of input.comparison.results) {
    stmt.run({
      generatedAtMs: input.generatedAtMs,
      interval: input.interval,
      limit: input.limit,
      symbol: input.symbol,
      strategy: result.strategy,
      currentPrice: finiteNumber(input.currentPrice),
      netPnlPct: finiteNumber(result.netPnlPct),
      winRate: finiteNumber(result.winRate),
      profitFactor: finiteNumber(result.profitFactor),
      maxDrawdownPct: finiteNumber(result.maxDrawdownPct),
      tradeCount: Array.isArray(result.trades) ? result.trades.length : 0,
      recommendation: input.comparison.recommendation,
      isBest: input.comparison.best?.strategy === result.strategy ? 1 : 0,
      warningsJson: JSON.stringify(result.warnings ?? []),
      createdAtMs: nowMs,
    });
  }
}

export function listStrategyEffectiveness(
  db: BetterSqliteDatabase,
  limit = 240,
): StrategyEffectiveness[] {
  ensureTraderAppStateTables(db);
  const rows = db
    .prepare(
      `SELECT *
       FROM strategy_backtest_snapshots
       ORDER BY generated_at_ms DESC, id DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(1000, Math.floor(limit)))) as StrategyBacktestSnapshotRow[];

  const bySymbol = new Map<string, StrategyBacktestSnapshotRow[]>();
  for (const row of rows) {
    const bucket = bySymbol.get(row.symbol) ?? [];
    bucket.push(row);
    bySymbol.set(row.symbol, bucket);
  }

  return [...bySymbol.entries()]
    .map(([symbol, symbolRows]) => {
      const latest = [...symbolRows].sort(
        (a, b) => b.generated_at_ms - a.generated_at_ms || b.id - a.id,
      )[0]!;
      const distinctSnapshots = new Set(
        symbolRows.map((row) => String(row.generated_at_ms)),
      );
      const byStrategy = new Map<string, StrategyBacktestSnapshotRow[]>();
      for (const row of symbolRows) {
        const bucket = byStrategy.get(row.strategy) ?? [];
        bucket.push(row);
        byStrategy.set(row.strategy, bucket);
      }

      const strategies = [...byStrategy.entries()]
        .map(([strategy, strategyRows]) => {
          const latestStrategyRow = [...strategyRows].sort(
            (a, b) => b.generated_at_ms - a.generated_at_ms || b.id - a.id,
          )[0]!;
          const avgNetPnlPct =
            strategyRows.reduce((sum, row) => sum + row.net_pnl_pct, 0) /
            strategyRows.length;
          const avgProfitFactor =
            strategyRows.reduce((sum, row) => sum + row.profit_factor, 0) /
            strategyRows.length;
          const score =
            latestStrategyRow.net_pnl_pct * 0.72 +
            avgNetPnlPct * 0.28 +
            Math.min(latestStrategyRow.profit_factor, 3) * 0.25 -
            latestStrategyRow.max_drawdown_pct * 0.55 -
            (latestStrategyRow.trade_count === 0 ? 2 : 0);

          return {
            strategy,
            samples: strategyRows.length,
            latestGeneratedAtMs: latestStrategyRow.generated_at_ms,
            latestNetPnlPct: round(latestStrategyRow.net_pnl_pct),
            latestWinRate: round(latestStrategyRow.win_rate),
            latestProfitFactor: round(latestStrategyRow.profit_factor),
            latestMaxDrawdownPct: round(latestStrategyRow.max_drawdown_pct),
            latestTradeCount: latestStrategyRow.trade_count,
            avgNetPnlPct: round(avgNetPnlPct),
            avgProfitFactor: round(avgProfitFactor),
            score: round(score),
            warnings: safeWarnings(latestStrategyRow.warnings_json),
          };
        })
        .sort((a, b) => b.score - a.score);

      return {
        symbol,
        bestStrategy: strategies[0]?.strategy ?? null,
        latestRecommendation: latest.recommendation,
        latestCurrentPrice: round(latest.current_price),
        latestGeneratedAtMs: latest.generated_at_ms,
        snapshotCount: distinctSnapshots.size,
        strategies,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
