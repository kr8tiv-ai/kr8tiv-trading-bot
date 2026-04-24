# Futures MVP Working Model Scope

**Date:** 2026-04-24
**Source:** Matt direct scope correction

## Locked MVP Scope

The first working product is **MEXC futures only**.

Supported symbols:
- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`

Explicitly out of initial scope:
- spot execution as a primary product surface
- other exchanges
- other futures symbols
- fully automated entries without accountability review
- black-box ML models before the rule model is useful and inspectable

## What "Working Model" Means First

For the first usable version, "model" means a deterministic futures signal model that Matt can inspect:
- reads MEXC futures candles
- scans BTC/ETH/SOL only
- emits long/short ideas for scalps and longer plays
- attaches confidence, entry, invalidation, targets, and thesis
- runs style-conflict checks when trade history exists
- feeds the accountability/journal flow before a trade is considered valid

This is intentionally not a deep-learning model yet. A transparent model is better for v1 because it makes bad advice debuggable.

## Trade Modes

### Sniper

- leverage range: `30x` to `100x`
- smaller margin
- tight invalidation
- fast thesis expiry
- warnings required at high leverage (`75x+`)

### Core

- leverage cap: `30x`
- larger margin allowed
- stronger thesis requirement
- better suited to longer holds

## Required Local Product Loop

The local app and CLI should support this loop:

1. Scan MEXC futures BTC/ETH/SOL.
2. Show candidate long/short setup with entry, invalidation, targets, and confidence.
3. Matt manually inputs or edits the trade idea.
4. Accountability layer asks why the trade exists.
5. Risk layer blocks bad leverage mode, bad stops, bad targets, and poor risk/reward.
6. Journal entry is saved whether the trade is approved or blocked.
7. Future style analysis learns from both executed trades and rejected/blocked plans.

## Current Commands

```powershell
pnpm signals:scan --style --symbols 'BTCUSDT,ETHUSDT,SOLUSDT'
pnpm signals:watch --symbols 'BTCUSDT,ETHUSDT,SOLUSDT'
pnpm model:scan --symbols 'BTCUSDT,ETHUSDT,SOLUSDT' --notional 12
pnpm futures:status # requires mexc-futures-access + mexc-futures-secret WCM entries
pnpm trade:review --symbol BTCUSDT --side long --horizon scalp --mode sniper --leverage 75 --margin 12 --entry 93500 --stop 93140 --target 94400 --why "15m reclaim with momentum confirmation after liquidity sweep" --note "planned, not revenge"
pnpm trade:journal --symbol BTCUSDT --side long --horizon scalp --mode sniper --leverage 75 --margin 12 --entry 93500 --stop 93140 --target 94400 --why "15m reclaim with momentum confirmation after liquidity sweep" --note "planned, not revenge"
pnpm trade:app
```

## Build Bias

When in doubt, prioritize:
- futures signal quality
- accountability UX
- journal/styling data capture
- BTC/ETH/SOL leverage risk controls

Do not expand the surface area before this loop is actually useful.
