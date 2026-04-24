# History Ingest + Style Fingerprint Design

**Date:** 2026-04-23

## Goal

Teach the bot what Matt actually does, not just what the market is doing. This slice adds a normalized trade-history model, a reusable style-fingerprint engine, a first MEXC history ingest path, and style-conflict annotations that can attach to BTC/ETH/SOL trade ideas and future accountability/journal flows.

## Context

- Phase 2 already gives us a safe executor, ledger, panic flow, and live boot path.
- The signal engine now scans BTC/ETH/SOL futures market structure, but it still has no knowledge of Matt's real trading habits.
- Product direction now explicitly prioritizes MEXC futures on BTC/ETH/SOL, plus an accountability journal surface for manual and signal-driven trades.
- The roadmap and requirements already call for:
  - `SIG-01` normalized trade-history ingest
  - `SIG-02` style fingerprint metrics
  - `SIG-04` typed signals with `conflictsWithStyle`
- The current database has ledger tables (`orders`, `fills`, `realized_pnl`) but no long-horizon analytics table for imported history.

## Approaches Considered

### 1. Compute style metrics directly from executor ledger only

Pros:
- No new MEXC read surface
- Reuses existing SQLite data

Cons:
- Useless until Matt has already traded through this bot
- Misses the historical baseline the roadmap explicitly wants

### 2. Ingest raw MEXC trades into SQLite and compute fingerprint from normalized round trips

Pros:
- Matches roadmap and requirements
- Gives us immediate learning value from prior history
- Creates a reusable analytics substrate for leak detectors

Cons:
- Requires history pagination and round-trip reconstruction

### 3. Skip history ingest and add more market-only strategies first

Pros:
- Faster to ship
- More visible signal volume

Cons:
- Optimizes market description, not user improvement
- Delays the core product loop: "help me trade better"

## Recommendation

Choose approach 2.

It is the first slice that turns the bot from "market scanner" into "personal trading copilot." We will keep it generic enough to support futures/wallet ingest and journal accountability, but we will start with the already-working MEXC spot authenticated client so the delivery stays tight while the analytics layer stays market-agnostic.

## Architecture

### 1. Shared schemas

Add shared runtime contracts for:
- imported exchange trades
- reconstructed closed trades
- style fingerprint report
- style conflict annotations

These live in `packages/shared-schemas` so every layer can speak the same typed language.

### 2. New analytics package

Add `@kr8tiv/style-engine` with pure functions for:
- normalizing imported trade rows
- grouping fills into round trips
- computing fingerprint metrics
- generating style conflicts for live trade ideas

This package stays pure and testable. No DB or network code.

### 3. MEXC spot history read path

Extend `MEXCSpotClient` with a read-only `fetchMyTradesPage()` method that:
- accepts symbol, since, limit
- uses CCXT's authenticated trade-history read surface
- parses results through Zod

The client remains read/write-safe:
- no raw HTTP added
- no new ccxt import sites
- whitelist still enforced before network calls

### 4. SQLite storage

Add a new `trades` table to the executor schema for imported history. Keep it separate from executor order/fill tables so imported historical data does not masquerade as bot-executed trades.

Planned columns:
- `id`
- `venue`
- `market`
- `symbol`
- `side`
- `price`
- `size`
- `quote_notional`
- `fee`
- `fee_currency`
- `executed_at_ms`
- `source_trade_id`
- `source_order_id`
- `raw_response`

Uniqueness should be enforced on `(venue, market, source_trade_id)` so repeated ingest is idempotent.

### 5. Operator scripts

Add:
- `pnpm history:ingest`
- `pnpm style:fingerprint`

`history:ingest`:
- fetches paginated MEXC history
- upserts into `trades`
- prints count and newest/oldest timestamps

`style:fingerprint`:
- reads normalized rows from SQLite
- reconstructs closed trades
- prints metrics:
  - avg/median hold time
  - median position size
  - hour-of-day expectancy map
  - win/loss hold asymmetry
  - preferred entry windows

### 6. Signal integration

Extend live `TradeIdea` objects with optional style conflicts. For this slice the style layer will focus on lightweight, explainable flags:
- trading outside preferred hours
- taking materially larger size than historical norm
- low-sample warning when fingerprint evidence is thin

This keeps the first pass honest and useful without pretending we already have the full leak-detector suite. The same style-conflict output will later feed:
- futures trade suggestions
- Telegram approval cards
- the local accountability journal app

## Error Handling

- Empty history: fingerprint command returns a helpful "no trades yet" result, not a crash
- Partial ingest reruns: safe due to unique upsert behavior
- Missing auth / bad keys: history script fails through existing client/auth path
- Mixed symbols: fingerprint functions remain symbol-aware and can filter by requested symbols

## Testing Strategy

TDD in small steps:

1. Shared schema tests for imported and reconstructed trades
2. Style-engine tests for round-trip reconstruction
3. Style-engine tests for fingerprint metrics
4. MEXC spot client tests for paginated trade-history reads
5. Script-level smoke tests for ingest/report formatting where practical
6. Full workspace verification:
   - targeted package tests
   - `pnpm turbo typecheck`
   - `pnpm smoke`

## Out of Scope

- Futures authenticated history ingest
- Full revenge/FOMO/late-exit leak suite
- Telegram card rendering of style conflicts
- Manual trade journal UI
- Automated backtesting
- Real-time websocket account sync

Those build naturally on top of this foundation.
