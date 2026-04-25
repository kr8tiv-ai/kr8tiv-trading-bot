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

### Medium

- leverage range: `10x` to `50x`
- default margin sits between sniper and core
- used when the model sees a real setup but confidence is not high enough for a sniper
- should be the default for most app-generated BTC/ETH/SOL futures ideas until Matt has trade-history evidence that a tighter mode is better

## Strategy Lab + Backtesting

The app should not only emit a setup; it should show whether the setup family has recently worked.

Initial strategy families:
- `breakout-trailing` — momentum breakout with ATR stop, breakeven after 1R, trailing stop after 1.5R
- `adaptive-grid` — range-bound futures grid planner for BTC/ETH/SOL; decision-support only at first, not autonomous live grid execution
- `futures-context` — funding, fair/index basis, volume, and open-interest context used as confirmation/veto

The Backtest Lab should replay the same candles the signal engine uses and rank strategy effectiveness per symbol. Matt should be able to see:
- best recent strategy per symbol
- net PnL %, win rate, profit factor, max drawdown, and trade count
- whether grid or breakout is currently a better fit
- warnings when there is not enough data or the market is too compressed/wide for a clean grid
- a saved strategy-effectiveness memory so repeated backtests show which family has been working lately instead of only showing a one-off replay

The Grid Planner is separate from live execution. It should:
- build BTC/ETH/SOL futures grid levels from the same MEXC candles used by Backtest Lab
- use saved capital settings and selected leverage
- allocate only a capped slice of configured futures capital
- show long/short levels with entry, take-profit, stop-loss, margin, and notional
- refuse to invent levels when the range is compressed, the budget is invalid, or leverage makes the plan unsafe
- remain decision-support only until a later phase explicitly designs live grid execution

The Grid Trading Candidate panel is the bridge between planner and execution:
- combine adaptive-grid replay, grid levels, and futures context into `paper_grid`, `watch`, or `avoid`
- only call a symbol gridable when the grid replay is positive, adaptive-grid is the best recent family, planner guardrails pass, and futures crowding is not hostile
- keep the output as paper/planner-only until liquidation, partial-fill, funding, and kill-switch handling are designed for live grid orders

The Futures Context panel should make the market backdrop readable before Matt clicks into a trade:
- funding rate
- fair/index basis
- 24h rise/fall
- 24h amount
- MEXC holdVol/open-interest-ish pressure
- a crowding assessment (`longs_crowded`, `shorts_crowded`, or `balanced`)
- a plain-English caution such as "avoid late long chases" when funding + basis look crowded

The Fundamentals Pulse should be a lightweight confirmation/veto layer:
- pull BTC/ETH/SOL market cap, 24h volume, 24h change, and last update age from a public fundamentals source
- score whether broad liquidity and price-extension conditions are `supportive`, `caution`, or `hostile`
- never override the futures setup model by itself; it confirms or warns against taking the setup
- explain the score in plain language so Matt can see when a move is too stale, too illiquid, or overextended

The Setup Board should be the cockpit's fast decision layer:
- one row per `BTCUSDT`, `ETHUSDT`, `SOLUSDT`
- combines deterministic model setup, recent backtest winner, futures context, grid planner readiness, and style conflicts
- returns `consider_long`, `consider_short`, or `wait`
- shows blockers first when the model, backtest, context, or personal style history disagrees
- is advisory only; it should never place futures orders by itself

The Live Account panel should be read-only at first:
- show futures USDT total/free/used when MEXC futures credentials exist
- show open futures positions with side, leverage, notional, entry, mark, liquidation, margin mode, and unrealized PnL
- fail safe when credentials are missing by explaining which WCM entries are required
- never place, modify, or close positions from the panel; panic and execution stay explicit commands until the risk model is proven

The Past-trade panel should coach behavior, not just report stats:
- provide a one-click read-only import for recent BTC/ETH/SOL MEXC futures fills when futures credentials are configured
- flag symbol-level negative expectancy
- flag long-vs-short direction underperformance
- flag losses held much longer than winners
- flag fee drag when churn eats the edge
- translate each leak into a concrete next action, e.g. "avoid BTCUSDT longs unless context, backtest, and setup-board all agree"

## Required Local Product Loop

The local app and CLI should support this loop:

1. Scan MEXC futures BTC/ETH/SOL.
2. Show candidate long/short setup with entry, invalidation, targets, and confidence.
3. Matt manually inputs or edits the trade idea.
4. Fast controls let Matt apply sniper/medium/core presets from saved capital rules instead of typing the same sizing/leverage choices every time.
5. Accountability layer asks why the trade exists.
6. Risk layer blocks bad leverage mode, bad stops, bad targets, and poor risk/reward.
7. Journal entry is saved whether the trade is approved or blocked.
8. Future style analysis learns from both executed trades and rejected/blocked plans.
9. Backtest Lab ranks the active strategy family before Matt risks capital.
10. Past-trade analysis shows symbol + direction leaks so the app can say, "this is the kind of trade you usually mishandle."
11. Strategy memory stores each Backtest Lab run and keeps a ranked view of breakout vs adaptive-grid effectiveness by symbol.
12. Fundamentals Pulse adds a macro/liquidity warning layer before the setup is treated as actionable.

## Current Commands

```powershell
pnpm signals:scan --style --symbols 'BTCUSDT,ETHUSDT,SOLUSDT'
pnpm signals:watch --symbols 'BTCUSDT,ETHUSDT,SOLUSDT'
pnpm model:scan --symbols 'BTCUSDT,ETHUSDT,SOLUSDT' --notional 12
pnpm futures:status # requires mexc-futures-access + mexc-futures-secret WCM entries
pnpm trade:app # local cockpit with quick trade controls, setup board, market context, model scan, grid planner, history analysis, and backtest lab
pnpm trade:review --symbol BTCUSDT --side long --horizon scalp --mode sniper --leverage 75 --margin 12 --entry 93500 --stop 93140 --target 94400 --why "15m reclaim with momentum confirmation after liquidity sweep" --note "planned, not revenge"
pnpm trade:journal --symbol BTCUSDT --side long --horizon scalp --mode sniper --leverage 75 --margin 12 --entry 93500 --stop 93140 --target 94400 --why "15m reclaim with momentum confirmation after liquidity sweep" --note "planned, not revenge"
```

## Build Bias

When in doubt, prioritize:
- futures signal quality
- strategy effectiveness evidence from backtests
- MEXC futures market context: funding, fair/index basis, 24h volume, open interest
- lightweight fundamentals context: liquidity, market cap, 24h extension, stale-data warnings
- accountability UX
- journal/styling data capture
- BTC/ETH/SOL leverage risk controls

Do not expand the surface area before this loop is actually useful.
