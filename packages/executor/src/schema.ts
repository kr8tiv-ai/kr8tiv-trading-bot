import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BetterSqliteDatabase } from "@kr8tiv/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Phase 2 SQLite DDL loaded from {@link ./schema.sql}. Kept as an external file
 * (not inline) so operator tooling (golden-diff review, Phase 5 migrations)
 * can cat it directly.
 *
 * Tables: `orders`, `fills`, `realized_pnl`, `trades`, `trade_journal`,
 *         `executor_state`.
 * Views:  `positions`.
 * All CREATE statements use `IF NOT EXISTS` — repeat application is a no-op.
 *
 * trade_journal column migrations landed 2026-04-24 for the MVP (style
 * conflicts + Telegram approval trail). SQLite's `ALTER TABLE ADD COLUMN`
 * does not support `IF NOT EXISTS`, so {@link applyTradeJournalMigrations}
 * inspects `PRAGMA table_info` and adds only the missing columns. Fresh
 * databases get the columns directly from schema.sql; pre-MVP databases get
 * them added in place without data loss.
 */
export const SCHEMA_SQL: string = readFileSync(
  join(__dirname, "schema.sql"),
  "utf8",
);

/**
 * trade_journal columns added in the 2026-04-24 MVP wave. Keep this list in
 * sync with the CREATE TABLE in schema.sql so fresh installs and migrations
 * converge on the same shape.
 */
const TRADE_JOURNAL_MVP_COLUMNS: ReadonlyArray<{
  readonly name: string;
  readonly ddl: string;
}> = [
  { name: "conflicts_json", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { name: "telegram_message_id", ddl: "INTEGER" },
  { name: "telegram_chat_id", ddl: "INTEGER" },
  {
    name: "approval_status",
    ddl: "TEXT CHECK (approval_status IS NULL OR approval_status IN ('pending','approved','rejected','expired'))",
  },
  { name: "approved_at_ms", ddl: "INTEGER" },
  { name: "rejected_at_ms", ddl: "INTEGER" },
];

/**
 * Idempotent per-column ADD COLUMN migrator for trade_journal. Safe to call
 * on every open (re-inspects pragma each time). Rows written before the
 * migration run keep their NULL/default values — the MVP code paths treat
 * null `approval_status` as "no Telegram dispatch yet".
 */
function applyTradeJournalMigrations(db: BetterSqliteDatabase): void {
  const info = db
    .prepare("PRAGMA table_info(trade_journal)")
    .all() as Array<{ name: string }>;
  if (info.length === 0) {
    // Table didn't exist until this applySchema() call — the CREATE TABLE in
    // schema.sql already includes the MVP columns, so nothing to migrate.
    return;
  }
  const existing = new Set(info.map((row) => row.name));
  for (const column of TRADE_JOURNAL_MVP_COLUMNS) {
    if (existing.has(column.name)) continue;
    db.exec(
      `ALTER TABLE trade_journal ADD COLUMN ${column.name} ${column.ddl}`,
    );
  }
  // Index creation happens AFTER ALTER TABLE so pre-MVP databases don't
  // error on the missing approval_status column during schema.sql exec.
  db.exec(
    "CREATE INDEX IF NOT EXISTS trade_journal_approval_status ON trade_journal(approval_status)",
  );
}

/**
 * Apply the Phase 2 + MVP schema to an already-opened SQLite database handle
 * (typically from `@kr8tiv/db` `openDatabase()` which also applies the
 * WAL + synchronous=FULL + foreign_keys=ON pragmas).
 *
 * 1. Runs the idempotent DDL from schema.sql (`CREATE ... IF NOT EXISTS`).
 * 2. Runs the per-column migrator for trade_journal so pre-MVP databases
 *    gain the new columns without touching existing rows.
 *
 * Safe to call on every boot.
 *
 * @param db — an open database handle from `@kr8tiv/db`.
 */
export function applySchema(db: BetterSqliteDatabase): void {
  db.exec(SCHEMA_SQL);
  applyTradeJournalMigrations(db);
}
