# Signal Watch Design

Date: 2026-04-23

## Goal

Turn the one-shot futures scanner into a reusable live observer that:

- keeps watching BTC/ETH/SOL on MEXC futures
- remembers the last scan for each symbol
- emits only meaningful changes
- persists those changes into Redis for later Telegram and dashboard consumers

## Why this slice

The current scanner already answers "what do the markets look like right now?"

What the product still needs is continuity:

- what changed since the last scan
- when a new long or short setup appeared
- when a regime flipped from range to bullish or bearish
- when a previously-good setup weakened or disappeared

Without that memory layer, every downstream surface has to reinvent its own comparison logic.

## Selected design

### Shared contracts

Add a typed `SignalWatchEvent` schema with events like:

- `regime-changed`
- `idea-opened`
- `idea-updated`
- `idea-closed`

### Signal-engine helpers

Add a watch module that:

- derives stable idea keys from the trade-idea shape
- diffs `previousScan` vs `currentScan`
- emits only meaningful events

### Watch script

Add `pnpm signals:watch` that:

- fetches public futures candles repeatedly
- runs the signal engine for BTC/ETH/SOL
- compares current scans with previous scans from Redis
- writes latest scans into Redis keys
- pushes change events into a Redis stream
- prints human-readable updates to stdout

## Redis model

- latest scan key: `signals:latest:<symbol>`
- event stream: `signals.market-watch`

This keeps the watcher stateless across restarts while giving Phase 3 Telegram and future dashboards a clean event feed to consume.

## Safety

- public futures market data only
- no private MEXC write methods
- no executor coupling
- no order placement

## Verification

- shared-schema tests for `SignalWatchEvent`
- signal-engine tests for scan diffing
- `pnpm -F @kr8tiv/signal-engine test`
- `pnpm -F @kr8tiv/shared-schemas test`
- `pnpm turbo typecheck`
- live dry run:
  - `pnpm signals:watch --iterations 1`

