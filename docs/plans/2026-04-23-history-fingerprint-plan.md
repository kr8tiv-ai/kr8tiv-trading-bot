# History Ingest + Style Fingerprint Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add normalized MEXC history ingest, style fingerprint analytics, and style-conflict annotations for live trade ideas.

**Architecture:** We will add shared schemas plus a pure `@kr8tiv/style-engine` package, then extend the existing MEXC spot client with a read-only trade-history method and wire operator scripts on top. Signal outputs gain optional style conflicts without touching the executor write path.

**Tech Stack:** TypeScript, Zod, CCXT, better-sqlite3, Vitest, pnpm workspaces

---

### Task 1: Shared Schemas For History + Style

**Files:**
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\shared-schemas\src\history.ts`
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\shared-schemas\src\history.test.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\shared-schemas\src\signals.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\shared-schemas\src\index.ts`

**Step 1:** Write failing tests for imported trade rows, reconstructed closed trades, style fingerprint summaries, and `conflictsWithStyle`.

**Step 2:** Run `pnpm -F @kr8tiv/shared-schemas test` and confirm the new tests fail for the missing module/schema.

**Step 3:** Add the minimal Zod schemas and exports to satisfy the tests.

**Step 4:** Re-run `pnpm -F @kr8tiv/shared-schemas test`.

### Task 2: Pure Style Engine

**Files:**
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\style-engine\package.json`
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\style-engine\tsconfig.json`
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\style-engine\src\index.ts`
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\style-engine\src\engine.ts`
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\style-engine\src\engine.test.ts`

**Step 1:** Write failing tests for:
- round-trip reconstruction from buy/sell trade rows
- empty-history behavior
- fingerprint metrics
- style conflict generation for time-of-day and oversize entries

**Step 2:** Run `pnpm -F @kr8tiv/style-engine test` and confirm failure.

**Step 3:** Implement the minimal pure functions to pass.

**Step 4:** Re-run `pnpm -F @kr8tiv/style-engine test`.

### Task 3: MEXC Spot History Read Path

**Files:**
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\mexc-spot\src\client.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\mexc-spot\src\client.test.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\mexc-spot\src\index.ts`

**Step 1:** Write a failing unit test for `fetchMyTradesPage(symbol, since, limit)` proving:
- whitelist enforced first
- CCXT `fetchMyTrades()` is called with parsed symbol/since/limit
- response is parsed through Zod

**Step 2:** Run `pnpm -F @kr8tiv/mexc-spot test` and watch the new test fail.

**Step 3:** Implement the minimal read-only method.

**Step 4:** Re-run `pnpm -F @kr8tiv/mexc-spot test`.

### Task 4: SQLite Schema + Operator Scripts

**Files:**
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\executor\src\schema.sql`
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\scripts\history-ingest.ts`
- Create: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\scripts\style-fingerprint.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\scripts\package.json`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\package.json`

**Step 1:** Write failing tests in `style-engine` or script-adjacent helpers for ingest dedupe and report formatting if helpful.

**Step 2:** Add the `trades` table with unique source identity.

**Step 3:** Implement ingest pagination and SQLite upsert.

**Step 4:** Implement fingerprint reporting from the `trades` table.

**Step 5:** Run focused checks plus script TypeScript validation.

### Task 5: Signal Integration + Verification

**Files:**
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\signal-engine\src\engine.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\packages\signal-engine\src\engine.test.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\scripts\scan-signals.ts`
- Modify: `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\scripts\watch-signals.ts`

**Step 1:** Write failing tests for optional `conflictsWithStyle` attachment.

**Step 2:** Run the focused tests and confirm failure.

**Step 3:** Implement style-aware annotation without changing the existing signal-selection core.

**Step 4:** Re-run all relevant tests and then:
- `pnpm turbo typecheck`
- `pnpm turbo test`
- `pnpm smoke`

**Step 5:** Commit the slice once the evidence is fresh.
