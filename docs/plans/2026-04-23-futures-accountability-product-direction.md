# Futures-First Accountability Product Direction

**Date:** 2026-04-23
**Source:** Matt direct product guidance

## What We Are Optimizing For

This product is not just an execution bot. Its main job is to help Matt make smarter trades on MEXC by combining:
- live market signals
- real-time accountability
- style analysis
- journaling
- risk discipline before, during, and after the trade

## Trading Focus

Current focus is **MEXC futures first**, not spot first, with emphasis on:
- `BTCUSDT`
- `ETHUSDT`
- `SOLUSDT`

The system should support:
- longs and shorts
- scalps and longer holds
- aggressive sniper setups and calmer higher-capital setups

## Risk Modes

The bot should understand two broad trade personalities:

### 1. Sniper / High-Leverage

- smaller capital
- higher leverage
- fast invalidation
- used for sharper, riskier entries
- leverage range Matt may use: **30x to 100x**

### 2. Core / Higher-Capital

- larger capital
- lower leverage
- more deliberate structure
- preferred leverage: **30x and below**

Signals, journaling prompts, and accountability rules should distinguish between these two modes instead of treating all trades as the same kind of decision.

## Accountability Layer

Before a trade is taken, the product should push Matt to define:
- why the trade exists
- whether it is a scalp or longer play
- whether it is a sniper or core setup
- entry thesis
- stop loss
- take profit
- leverage
- invalidation point
- what would make the trade wrong quickly

The product should act like a disciplined trading partner, not a passive logger.

## Manual Trade Input App

We need a small local app surface where Matt can manually enter a trade idea or a live trade and be forced through accountability fields before treating it as "valid."

Minimum concepts for that surface:
- symbol
- long/short
- leverage
- planned entry
- stop loss
- take profit
- capital / notional
- risk mode (`sniper` or `core`)
- journal answer: "Why am I taking this trade?"
- optional emotion / context note

This app is not a toy dashboard. It is part of the discipline loop.

## Journal Behavior

The system should ask reflective questions like:
- Why am I taking this trade now?
- What structure or signal confirms it?
- What makes this invalid?
- Is this revenge, FOMO, boredom, or a real edge?
- Am I oversizing compared to my better trades?
- Am I trading outside my historically strong hours?

The journal should work:
- before entry
- after exit
- during review / leak detection

## Signals Still Matter

The bot must still use signals and market context aggressively:
- multi-timeframe directional bias
- longs and shorts
- scalps and longer plays
- BTC / ETH / SOL futures structure
- leverage-aware trade classification

But signals alone are not enough. The point is:

**signal + accountability + style conflict + journal evidence**

## Implications For The Build

### Near-term

- keep extending the futures-first signal engine for BTC/ETH/SOL
- ingest and analyze Matt's trading history
- compute style fingerprints that reflect leverage, time-of-day, hold time, and size behavior
- build conflict flags for risky deviations from Matt's better patterns

### Mid-term

- add the manual trade accountability app
- store journal answers beside candidate and executed trades
- make Telegram cards and local UI show style conflicts and risk-mode framing

### Longer-term

- use leak detection to show where high-leverage behavior helps vs hurts
- separate "good sniper aggression" from "undisciplined leverage chasing"

## Guardrail

This direction supersedes any future drift toward a generic signal bot. The product should feel like:

**a futures-aware trading coach with execution, not just an execution bot with charts.**
