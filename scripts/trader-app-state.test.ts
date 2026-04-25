import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase, type BetterSqliteDatabase } from "@kr8tiv/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRecentTradeFeedback,
  readTraderSettings,
  recordTradeFeedback,
  saveTraderSettings,
} from "./trader-app-state.js";

let dir: string;
let db: BetterSqliteDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kr8tiv-trader-app-state-"));
  db = openDatabase(path.join(dir, "state.sqlite"));
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("trader-app-state", () => {
  it("returns default capital settings and persists a partial override", () => {
    expect(readTraderSettings(db)).toMatchObject({
      capitalBudgetQuote: 100,
      defaultMarginQuote: 25,
      mediumMarginQuote: 25,
    });

    const saved = saveTraderSettings(db, {
      capitalBudgetQuote: 250,
      defaultMarginQuote: 50,
    });

    expect(saved).toMatchObject({
      capitalBudgetQuote: 250,
      defaultMarginQuote: 50,
      mediumMarginQuote: 25,
    });
    expect(readTraderSettings(db)).toMatchObject({
      capitalBudgetQuote: 250,
      defaultMarginQuote: 50,
    });
  });

  it("records quick accountable feedback events", () => {
    const saved = recordTradeFeedback(db, {
      journalId: 42,
      action: "broke_rules",
      note: "entered before candle close",
    });

    expect(saved).toMatchObject({
      id: 1,
      journalId: 42,
      action: "broke_rules",
      note: "entered before candle close",
    });
    expect(listRecentTradeFeedback(db, 5)).toEqual([saved]);
  });
});
