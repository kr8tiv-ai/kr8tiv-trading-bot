import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountableTradePlan,
  AccountabilityCheck,
  StyleConflict,
} from "@kr8tiv/shared-schemas";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findTradeJournalEntry,
  listRecentTradeJournalEntries,
  recordApprovalDecision,
  recordTelegramDispatch,
  saveTradeJournalEntry,
} from "./journal.js";

function validPlan(
  overrides: Partial<AccountableTradePlan> = {},
): AccountableTradePlan {
  return {
    symbol: "BTCUSDT",
    market: "mexc-futures",
    direction: "long",
    horizon: "scalp",
    riskMode: "sniper",
    leverage: 75,
    marginQuote: 12,
    entryPrice: 93500,
    stopLossPrice: 93140,
    takeProfitPrice: 94400,
    thesis: "15m reclaim with momentum confirmation after liquidity sweep",
    journalNote:
      "This is planned, not revenge, and invalidates quickly below reclaim.",
    createdAtMs: 1700000000000,
    ...overrides,
  };
}

function review(
  overrides: Partial<AccountabilityCheck> = {},
): AccountabilityCheck {
  return {
    okToProceed: true,
    estimatedLossQuote: 3.47,
    estimatedRewardQuote: 8.66,
    riskRewardRatio: 2.5,
    blocks: [],
    warnings: [{ code: "high-leverage", message: "75x sniper setup." }],
    ...overrides,
  };
}

describe("trade journal persistence", () => {
  let tmpDir: string;
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trade-journal-"));
    db = new Database(join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves an accountability review and reads it back newest-first", () => {
    const firstPlan = validPlan({
      symbol: "BTCUSDT",
      createdAtMs: 1700000000000,
    });
    const secondPlan = validPlan({
      symbol: "SOLUSDT",
      direction: "short",
      entryPrice: 145,
      stopLossPrice: 148,
      takeProfitPrice: 137.5,
      createdAtMs: 1700000005000,
    });

    const firstId = saveTradeJournalEntry(db, firstPlan, review());
    const secondId = saveTradeJournalEntry(db, secondPlan, review());

    expect(firstId).toBe(1);
    expect(secondId).toBe(2);
    expect(listRecentTradeJournalEntries(db, 2)).toMatchObject([
      {
        id: 2,
        symbol: "SOLUSDT",
        direction: "short",
        riskMode: "sniper",
        okToProceed: true,
        riskRewardRatio: 2.5,
      },
      {
        id: 1,
        symbol: "BTCUSDT",
        direction: "long",
        riskMode: "sniper",
        okToProceed: true,
        warnings: [{ code: "high-leverage" }],
      },
    ]);
  });

  it("persists blocked plans too so accountability misses are reviewable", () => {
    const blockedPlan = validPlan({
      riskMode: "core",
      leverage: 50,
      createdAtMs: 1700000010000,
    });
    saveTradeJournalEntry(
      db,
      blockedPlan,
      review({
        okToProceed: false,
        blocks: [
          {
            code: "leverage-mode-mismatch",
            message: "Core trades must stay at 30x leverage or below.",
          },
        ],
        warnings: [],
      }),
    );

    const [entry] = listRecentTradeJournalEntries(db, 1);
    expect(entry).toMatchObject({
      symbol: "BTCUSDT",
      riskMode: "core",
      leverage: 50,
      okToProceed: false,
      blocks: [{ code: "leverage-mode-mismatch" }],
    });
  });

  it("persists style conflicts + approval status on save + reads them back", () => {
    const conflicts: StyleConflict[] = [
      {
        code: "outside-preferred-hours",
        severity: "info",
        message: "Outside your historical strong hours.",
        evidence: "preferred=12,13 current=03",
      },
    ];
    const id = saveTradeJournalEntry(db, validPlan(), review(), {
      conflicts,
      approvalStatus: "pending",
    });
    const entry = findTradeJournalEntry(db, id);
    expect(entry).not.toBeNull();
    expect(entry?.approvalStatus).toBe("pending");
    expect(entry?.conflicts).toEqual(conflicts);
    expect(entry?.telegramMessageId).toBeNull();
    expect(entry?.approvedAtMs).toBeNull();
    expect(entry?.rejectedAtMs).toBeNull();
  });

  it("records a telegram dispatch + idempotently flips approval status pending → approved", () => {
    const id = saveTradeJournalEntry(db, validPlan(), review(), {
      approvalStatus: "pending",
    });
    recordTelegramDispatch(db, id, { chatId: 123, messageId: 456 });
    const afterDispatch = findTradeJournalEntry(db, id);
    expect(afterDispatch?.telegramChatId).toBe(123);
    expect(afterDispatch?.telegramMessageId).toBe(456);
    expect(afterDispatch?.approvalStatus).toBe("pending");

    const first = recordApprovalDecision(db, id, "approved", 1700000100000);
    expect(first).toEqual({ changed: true, priorStatus: "pending" });
    const afterApprove = findTradeJournalEntry(db, id);
    expect(afterApprove?.approvalStatus).toBe("approved");
    expect(afterApprove?.approvedAtMs).toBe(1700000100000);
    expect(afterApprove?.rejectedAtMs).toBeNull();

    const second = recordApprovalDecision(db, id, "rejected", 1700000200000);
    expect(second).toEqual({ changed: false, priorStatus: "approved" });
    const afterSecond = findTradeJournalEntry(db, id);
    expect(afterSecond?.approvalStatus).toBe("approved");
    expect(afterSecond?.rejectedAtMs).toBeNull();
  });

  it("no-ops when recording a decision for a plan that was never dispatched (approval_status null)", () => {
    // Legacy rows (pre-MVP) have approval_status = NULL. Those are never
    // "pending", so the mutator should leave them untouched — the cockpit only
    // flips rows that were actually sent to Telegram.
    const id = saveTradeJournalEntry(db, validPlan(), review());
    const result = recordApprovalDecision(db, id, "approved");
    expect(result.changed).toBe(false);
    expect(result.priorStatus).toBeNull();
    const entry = findTradeJournalEntry(db, id);
    expect(entry?.approvalStatus).toBeNull();
    expect(entry?.approvedAtMs).toBeNull();
  });
});
