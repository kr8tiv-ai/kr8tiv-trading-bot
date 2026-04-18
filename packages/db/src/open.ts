import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { env } from "@kr8tiv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Open a SQLite database file with the Phase 1 pragmas every downstream
 * ledger table assumes:
 *
 *   journal_mode = WAL     — crash-safe; concurrent readers don't block writer
 *   synchronous  = FULL    — fsync every commit; survives OS crash + power loss
 *   foreign_keys = ON      — FK constraints enforced (off by default in SQLite!)
 *
 * WAL + synchronous=FULL is the "money data" default per PITFALLS.md Pitfall 5.
 * Do NOT loosen synchronous without a ledger-level durability argument.
 */
export function openDatabase(dbPath: string = env.SQLITE_PATH): BetterSqliteDatabase {
  // Ensure parent directory exists (better-sqlite3 does NOT mkdir -p).
  const parent = path.dirname(dbPath);
  mkdirSync(parent, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Close the database cleanly. Runs a WAL checkpoint first so the -wal and
 * -shm files are merged back into the main file — important before copy/backup
 * (Phase 10) and prevents "database is locked" surprises on re-open.
 */
export function closeDatabase(db: BetterSqliteDatabase): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore — if checkpoint fails, still close
  }
  db.close();
}
