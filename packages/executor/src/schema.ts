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
 * Tables: `orders`, `fills`, `realized_pnl`, `executor_state`.
 * Views: `positions`.
 * All statements use `IF NOT EXISTS` — repeat application is a no-op.
 */
export const SCHEMA_SQL: string = readFileSync(
  join(__dirname, "schema.sql"),
  "utf8",
);

/**
 * Apply the Phase 2 schema to an already-opened SQLite database handle
 * (typically from `@kr8tiv/db` `openDatabase()` which also applies the
 * WAL + synchronous=FULL + foreign_keys=ON pragmas).
 *
 * All DDL is idempotent (`CREATE ... IF NOT EXISTS`), so repeated calls are
 * safe and cheap — callers (Plan 02-03 ledger, Plan 02-04 CLIs, test setup)
 * invoke this on boot without reference-counting.
 *
 * @param db — an open database handle from `@kr8tiv/db`.
 */
export function applySchema(db: BetterSqliteDatabase): void {
  db.exec(SCHEMA_SQL);
}
