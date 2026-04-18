import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "./open.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("openDatabase", () => {
  let tmpDir: string;
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "kr8tiv-db-test-"));
    tmpDbPath = path.join(tmpDir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the file if it does not exist", () => {
    expect(existsSync(tmpDbPath)).toBe(false);
    const db = openDatabase(tmpDbPath);
    expect(existsSync(tmpDbPath)).toBe(true);
    closeDatabase(db);
  });

  it("sets journal_mode = WAL", () => {
    const db = openDatabase(tmpDbPath);
    const result = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(result[0]?.journal_mode).toBe("wal");
    closeDatabase(db);
  });

  it("sets synchronous = FULL (integer value 2)", () => {
    const db = openDatabase(tmpDbPath);
    const result = db.pragma("synchronous") as Array<{ synchronous: number }>;
    expect(result[0]?.synchronous).toBe(2);
    closeDatabase(db);
  });

  it("sets foreign_keys = ON (value 1)", () => {
    const db = openDatabase(tmpDbPath);
    const result = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
    expect(result[0]?.foreign_keys).toBe(1);
    closeDatabase(db);
  });

  it("creates missing parent directories", () => {
    const nested = path.join(tmpDir, "a", "b", "c", "nested.sqlite");
    const db = openDatabase(nested);
    expect(existsSync(nested)).toBe(true);
    closeDatabase(db);
  });

  it("close + reopen works cleanly (checkpoint prevents SQLITE_BUSY)", () => {
    const db1 = openDatabase(tmpDbPath);
    db1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);");
    closeDatabase(db1);
    const db2 = openDatabase(tmpDbPath);
    const row = db2.prepare("SELECT id FROM t").get() as { id: number };
    expect(row.id).toBe(1);
    closeDatabase(db2);
  });

  it("FK constraints actually fire (proof foreign_keys=ON took effect)", () => {
    const db = openDatabase(tmpDbPath);
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child  (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
    `);
    expect(() =>
      db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 99)").run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    closeDatabase(db);
  });
});
