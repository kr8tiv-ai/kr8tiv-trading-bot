import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_SQL, applySchema } from "./schema.js";

describe("applySchema", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "exec-schema-"));
    dbPath = join(tmpDir, "test.db");
    db = new Database(dbPath);
    // Match the @kr8tiv/db openDatabase() pragmas so the test mirrors production.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates executor, history, and journal tables + positions view on first apply", () => {
    applySchema(db);
    const objs = db
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
      )
      .all() as Array<{ name: string; type: string }>;
    const names = objs.map((o) => o.name);
    expect(names).toContain("orders");
    expect(names).toContain("fills");
    expect(names).toContain("realized_pnl");
    expect(names).toContain("trades");
    expect(names).toContain("trade_journal");
    expect(names).toContain("executor_state");
    expect(names).toContain("positions");
    const positionsType = objs.find((o) => o.name === "positions")?.type;
    expect(positionsType).toBe("view");
  });

  it("is idempotent — re-apply does not throw and leaves tables intact", () => {
    applySchema(db);
    applySchema(db);
    applySchema(db);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name IN ('orders','fills','realized_pnl','trades','trade_journal','executor_state')",
      )
      .get() as { c: number };
    expect(count.c).toBe(6);
  });

  it("enforces orders.side CHECK constraint", () => {
    applySchema(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO orders (client_order_id, pair, side, type, status, submitted_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)",
        )
        .run("abc", "ETHUSDT", "BOGUS", "market", "submitted", 1, 1),
    ).toThrow();
  });

  it("enforces orders.status CHECK constraint", () => {
    applySchema(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO orders (client_order_id, pair, side, type, status, submitted_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)",
        )
        .run("abc", "ETHUSDT", "buy", "market", "weird-status", 1, 1),
    ).toThrow();
  });

  it("SCHEMA_SQL contains the expected DDL headlines", () => {
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS orders");
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS fills");
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS realized_pnl");
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS trades");
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS trade_journal");
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS executor_state");
    expect(SCHEMA_SQL).toContain("CREATE VIEW IF NOT EXISTS positions");
  });

  it("roundtrips a trade_journal row with accountability verdict fields", () => {
    applySchema(db);
    db.prepare(
      `INSERT INTO trade_journal (
        created_at_ms, symbol, market, direction, horizon, risk_mode, leverage,
        margin_quote, entry_price, stop_loss_price, take_profit_price, thesis,
        journal_note, ok_to_proceed, estimated_loss_quote, estimated_reward_quote,
        risk_reward_ratio, blocks_json, warnings_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      1700000000000,
      "BTCUSDT",
      "mexc-futures",
      "long",
      "scalp",
      "sniper",
      75,
      12,
      93500,
      93140,
      94400,
      "15m reclaim after sweep",
      "planned, not revenge",
      1,
      3.47,
      8.66,
      2.5,
      "[]",
      '[{"code":"high_leverage"}]',
    );
    const row = db
      .prepare(
        "SELECT symbol, direction, risk_mode, leverage, ok_to_proceed, risk_reward_ratio FROM trade_journal WHERE symbol = ?",
      )
      .get("BTCUSDT") as {
      symbol: string;
      direction: string;
      risk_mode: string;
      leverage: number;
      ok_to_proceed: number;
      risk_reward_ratio: number;
    };
    expect(row).toEqual({
      symbol: "BTCUSDT",
      direction: "long",
      risk_mode: "sniper",
      leverage: 75,
      ok_to_proceed: 1,
      risk_reward_ratio: 2.5,
    });
  });

  it("roundtrips an orders row end-to-end", () => {
    applySchema(db);
    db.prepare(
      "INSERT INTO orders (client_order_id, pair, side, type, status, submitted_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)",
    ).run("abc123", "ETHUSDT", "buy", "market", "submitted", 1700000000000, 1700000000000);
    const row = db
      .prepare("SELECT client_order_id, pair, side FROM orders WHERE client_order_id = ?")
      .get("abc123") as { client_order_id: string; pair: string; side: string };
    expect(row.client_order_id).toBe("abc123");
    expect(row.pair).toBe("ETHUSDT");
    expect(row.side).toBe("buy");
  });
});
