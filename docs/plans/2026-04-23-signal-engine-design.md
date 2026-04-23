# Signal Engine Design

Date: 2026-04-23

## Goal

Add the first real trading-brain slice to `kr8tiv-mexc-bot`: a read-only signal engine that turns MEXC market candles into typed BTC/ETH/SOL long-short trade ideas for scalp and swing windows.

This slice does not place orders. It only observes, scores, and summarizes setups so the execution rails we already proved stay isolated from the new strategy brain.

## Context

The current repo is strong on execution safety:

- authenticated spot write path
- panic / arm / reconcile controls
- Redis pipeline contracts
- smoke-tested boot and environment checks

What is still missing is the thing the product is really for: market interpretation. The user wants the bot to help them make smarter MEXC trades, especially leverage ideas on BTC, ETH, and SOL, and asked that we reuse the local `Jarvis` repo's strategy work.

The most reusable Jarvis components are:

- RSI divergence
- MACD crossover / histogram trend
- breakout and false-breakout detection
- higher-timeframe trend framing from moving averages

## Approaches Considered

### 1. Put all strategy code directly in `apps/core`

Pros:
- fastest to wire

Cons:
- mixes market intelligence with execution orchestration
- harder to test in isolation
- makes future Telegram / dashboard integrations noisier

Verdict: not recommended.

### 2. Add a dedicated `@kr8tiv/signal-engine` package and keep it read-only

Pros:
- clean boundary between "think" and "act"
- easy to test with synthetic candles
- reusable from scripts, core, Telegram, and later dashboards
- safe to expand toward Phase 4 without tangling executor code

Cons:
- small upfront scaffolding cost

Verdict: recommended.

### 3. Skip a package and build a one-off scanner script first

Pros:
- quickest visible output

Cons:
- logic would be trapped in a CLI
- weak type/contracts story
- guaranteed refactor debt once signals need to flow into Telegram and dashboards

Verdict: useful later, but only after the engine exists.

## Selected Design

We will implement Approach 2:

1. Extend `@kr8tiv/shared-schemas` with market-candle and trade-idea contracts.
2. Add `@kr8tiv/signal-engine` with:
   - indicators: EMA, RSI, MACD, ATR
   - strategy analyzers: RSI divergence, MACD crossover, breakout
   - fusion logic: combine short-term and higher-timeframe context into typed trade ideas
3. Extend `@kr8tiv/mexc-futures` with a public `fetchCandles()` method using the official MEXC futures kline endpoint.
4. Add a read-only scanner CLI that fetches BTC/ETH/SOL futures candles and prints structured opportunities.

## Contracts

### Input

- canonical symbols: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`
- market source: MEXC futures public klines
- short timeframe: `15m`
- anchor timeframe: `4h`

### Output

For each symbol, the engine should emit:

- regime: bullish / bearish / range
- strategy readings:
  - RSI divergence / overextension
  - MACD crossover / histogram trend
  - breakout / breakdown / false breakout risk
- 0..N trade ideas with:
  - direction: `long` or `short`
  - horizon: `scalp` or `swing`
  - confidence: `0..1`
  - entry price
  - invalidation price
  - target prices
  - thesis / reasons

## Error Handling

- If candles are insufficient, emit no idea rather than guessing.
- If the futures payload shape changes, fail at the schema boundary.
- If a symbol is unsupported, reject before any network call.
- The scanner remains read-only even when run in a fully live environment.

## Verification Plan

- unit tests for schemas
- unit tests for indicator math directionality
- unit tests for bullish and bearish signal fusion
- unit tests for the futures kline adapter
- `pnpm -F "@kr8tiv/signal-engine" test`
- `pnpm -F "@kr8tiv/mexc-futures" test`
- `pnpm -F "@kr8tiv/shared-schemas" test`
- `pnpm turbo typecheck`
- `pnpm smoke`

## Assumptions

Because the user explicitly asked for autonomous continuation, this design assumes:

- futures market data is the right read-only source for leverage-focused signals
- BTC/ETH/SOL are the only symbols in scope for this slice
- the first version should prioritize trustworthy structure over exotic strategy breadth

