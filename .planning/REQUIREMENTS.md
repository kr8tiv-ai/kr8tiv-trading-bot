# Requirements: kr8tiv-mexc-bot

**Defined:** 2026-04-18
**Core Value:** Make Matt a better trader by surfacing what he already does well and correcting what he consistently does wrong — with a bot that never fires without his approval.

## v1 Requirements

Weekend MVP scope. Everything required to ship "one live ETH spot trade, approved via Telegram, with leak-report evidence from 60 days of history."

### Foundation (FND) — scaffold, secrets, MEXC read access

- [x] **FND-01**: Project scaffolded as pnpm workspaces + Turborepo monorepo on Node.js 22 LTS + TypeScript 5.5+ strict
- [x] **FND-02**: SQLite database initialized with WAL journaling (`journal_mode=WAL`, `synchronous=FULL`) via `better-sqlite3` — satisfied by Plan 01-03 (commit `c618cc9`), 7 tests green (also verifies foreign_keys=ON)
- [x] **FND-03**: Redis instance reachable from core process; connectivity smoke-tested on boot (ioredis) — Plan 01-03 (commit `f6a7532`) ships the factory + pingOrThrow; live-ping verified 2026-04-18 against portable Redis 5.0.14 (no-admin install at `%USERPROFILE%\tools\redis-portable\`) — 5/5 non-fallback tests green including the real PONG round-trip and the unreachable-port negative test
- [x] **FND-04**: `SecretProvider` abstraction with Windows Credential Manager implementation via `@zowe/secrets-for-zowe-sdk` — satisfied by Plan 01-02 (commit `6b5af57`), 6 round-trip tests green against real WinCred
- [x] **FND-05**: MEXC spot API key + secret + Telegram bot token stored in Windows Credential Manager and loaded through `SecretProvider` (no plaintext `.env`, no hardcoded strings) — satisfied by Plan 01-02 (commit `a94e3bd`), `pnpm setup:credentials` + `pnpm verify-env` scripts wired end-to-end
- [ ] **FND-06**: `MEXCSpotClient` class (read-only methods wired first) using CCXT 4.5.48+, with base URL `api.mexc.com` exposed as config, not hardcoded
- [ ] **FND-07**: `MEXCFuturesClient` class stub (read-only methods only in v1) using CCXT, separate auth + rate bucket from spot client, base URL `contract.mexc.com` config-driven
- [ ] **FND-08**: Boot-time smoke test pings both MEXC endpoints (spot ping + futures ping) and fails fast with a clear error if either is unreachable
- [x] **FND-09**: Structured logging via `pino` with automatic redaction of secret patterns (API keys, Telegram tokens, wallet addresses) — satisfied by Plan 01-02 (commit `cc1a55f`), 12 redaction tests green covering depth 1–3, Telegram/wallet scaffolds in place for Phase 3/7
- [x] **FND-10**: `gitleaks` pre-commit hook installed and passing; no secrets ever reach git
- [ ] **FND-11**: MEXC API key is provisioned trading-only (no withdrawals) and IP-whitelisted to the local Windows machine

### Execution (EXEC) — MEXC spot write path with safety rails

- [ ] **EXEC-01**: Risk manager module that gates every order — checks: leverage cap (4x on ETH), daily-loss circuit breaker ($2 USD absolute), per-asset exposure cap, correlation guard. Runs synchronously before any order submission.
- [ ] **EXEC-02**: `MEXCSpotClient` write methods (market + limit orders) require a `newClientOrderId` idempotency key; no order placement without one
- [ ] **EXEC-03**: Every entry order automatically attaches a server-side stop-loss on MEXC (`triggerPrice` order) — no orders placed naked
- [ ] **EXEC-04**: Pre-order `minNotional` check: pulls `contract_detail` from MEXC, computes `minNotional = minVol * contractSize * markPrice`, rejects the order if `2 * minNotional > available margin`
- [ ] **EXEC-05**: Fee rate queried dynamically from MEXC per order (never hardcoded 0, never assumes a promo is still active)
- [ ] **EXEC-06**: Pair whitelist for v1 is exactly `{ETHUSDT}` — any signal or order for another pair is rejected with an explicit reason
- [ ] **EXEC-07**: Panic kill-switch: `/panic` command cancels all open orders, flattens all positions, and freezes the executor until manually re-armed
- [ ] **EXEC-08**: Position-aware hot state in Redis: open positions, pending approvals, rate-limit buckets, all survive process restart
- [ ] **EXEC-09**: Executor process subscribes only to `approvals.decided{approved:true}` stream events — no other code path can invoke order placement (architectural invariant)

### Approval (APP) — Telegram approval loop

- [ ] **APP-01**: grammY Telegram bot bound to Matt's chat ID only — all other chats' messages ignored (whitelist enforced at handler level)
- [ ] **APP-02**: Signal approval card contains: asset, side, entry price, stop price, target price, confidence, regime, funding rate, rationale, **price delta vs current**, fee + slippage USD estimate
- [ ] **APP-03**: Inline keyboard with exactly two buttons — **Approve** and **Reject**. No "widen stop," no "modify" options in v1.
- [ ] **APP-04**: Approval has a 90-second TTL; on expiry the bot edits the original message to "Expired" and discards the signal
- [ ] **APP-05**: Bot calls `answerCallbackQuery` within 50ms of every button press (prevents Telegram-side silent drops)
- [ ] **APP-06**: Signal card includes a conflict-with-style flag when the signal contradicts Matt's typical motion (e.g., "You don't usually trade this hour")
- [ ] **APP-07**: Daily signal cap of 5 cards; overflow signals are logged as suppressed and never shown (alert-fatigue guard)
- [ ] **APP-08**: `/status` command reports open positions, today's PnL, today's signal count, circuit-breaker state, kill-switch armed/disarmed
- [ ] **APP-09**: After a Reject on a given pair, 30-minute cooldown prevents re-signal on the same pair
- [ ] **APP-10**: Price-drift re-check on Approve: if mark price has moved > 0.3% from the card's entry price, the card auto-expires instead of firing

### Analysis (SIG) — style fingerprint + rule-based signal + first leak detector

- [ ] **SIG-01**: Ingest ≥60 days of Matt's MEXC ETHUSDT trade history via paginated API; store normalized rows in SQLite `trades` table (timestamp, pair, side, size, price, fee, venue, pnl, source_order_id)
- [ ] **SIG-02**: Style fingerprint computed from history: avg hold time, median position size, hour-of-day expectancy map, win/loss hold asymmetry, preferred entry time ranges
- [ ] **SIG-03**: Rule-based signal generator implements EMA(20)/EMA(50) crossover gated by ADX regime filter (ADX<15 block, 15≤ADX<25 transitional, ADX≥25 trade)
- [ ] **SIG-04**: Signals emit as typed objects `{asset, side, entry, stop, target, confidence, rationale, regime, fundingRate, conflictsWithStyle}`
- [ ] **SIG-05**: Revenge-trade leak detector — flags entries placed within 30 minutes of a loss on the same pair where size ≥ previous losing size
- [ ] **SIG-06**: Leak detector EV validation: revenge-trade pattern must be backed by ≥20 historical samples AND show negative expected value in Matt's data before it vetoes a signal
- [ ] **SIG-07**: A leak-flagged signal is not auto-blocked — it is surfaced to Matt with an explicit "I would normally do X wrong here; this flag is here to veto it" note, and Matt can still approve
- [ ] **SIG-08**: Draft weekly leak report as a plain-text digest (formatted Telegram digest deferred to v2) — Top 3 leaks with trade IDs + projected $ saved if fixed

### Ledger + Reconciler (LEDG) — close the loop, first live trade

- [ ] **LEDG-01**: Append-only SQLite ledger with event types `signal.emitted`, `approval.pending`, `approval.decided`, `order.submitted`, `order.filled`, `order.cancelled`, `stop.triggered`, `pnl.delta` (current state is a projection of this ledger)
- [ ] **LEDG-02**: Boot-time reconciler pulls last 24h of MEXC fills via API, diffs against local ledger, blocks the executor from new orders until the diff is zero (or Matt manually resolves)
- [ ] **LEDG-03**: Laptop-sleep / wake detection via `wake-event` npm package AND a 5-second heartbeat fallback; wake event triggers the reconciler before any new signal processing
- [ ] **LEDG-04**: Windows power control: while the executor has open positions, call `SetThreadExecutionState` to prevent system-initiated sleep
- [ ] **LEDG-05**: First end-to-end live trade is delivered through the pipeline: signal → approval → order → fill → ledger event → PnL delta → Telegram confirmation. This single trade is the Core Value validator for v1.

## v2 Requirements

Post-weekend iteration. Mapped to Phases 6-10 of the roadmap.

### Futures + Full Leak Suite (FUT)

- **FUT-01**: `MEXCFuturesClient` write methods wired with HMAC signing against `contract.mexc.com` (verify Matt's account has futures write permission; degrade to read-only+alert if 403)
- **FUT-02**: Pair whitelist expanded to ETHUSDT + BTCUSDT + SOLUSDT perpetuals on USDT-M
- **FUT-03**: Leverage caps applied per asset: BTC 5x, ETH 4x, SOL 3x; isolated margin mode only (never cross)
- **FUT-04**: Full leak detector suite: FOMO entry, late exit (bag holding), stop widening, overtrading, ignored stop, time-of-day abuse, size inflation after losses
- **FUT-05**: Each new leak detector validated with ≥20 samples + negative EV before it can veto a signal (same gate as SIG-06)
- **FUT-06**: Weekly formatted Telegram digest: top 3 leaks of the week with trade-ID evidence and projected $ savings
- **FUT-07**: Approval card grows two optional buttons — "Tighter stop" and "Half size" — but never "Widen stop"

### News / Fundamentals + On-chain Ingest (NEWS)

- **NEWS-01**: CryptoPanic integration, polled once every 2 minutes, 5-minute cache, never exceeds 30 req/hr (stays under free-tier floor)
- **NEWS-02**: CoinGecko Demo API integration for market data + dev-activity + social stats
- **NEWS-03**: News acts as a veto / confidence-downgrade only — never raises a signal's confidence above the ML or rule-based standalone output
- **NEWS-04**: Source whitelist for news sentiment flips: Coindesk, The Block, Bloomberg, Reuters, verified project accounts
- **NEWS-05**: ≥2 independent sources required before news triggers a confidence downgrade
- **NEWS-06**: News effect has 15-minute half-life decay
- **NEWS-07**: Solana wallet history ingested via Helius parsed transactions (handles Jupiter multi-hop, decimals, failed-tx filter)
- **NEWS-08**: Ethereum wallet history ingested via viem + Alchemy `getAssetTransfers` (decoded swaps only)
- **NEWS-09**: On-chain trades merged into the same unified `trades` table with `venue='solana'` / `venue='ethereum'` discriminator

### Machine Learning Signal (ML)

- **ML-01**: Python trainer in `apps/trainer-py` using XGBoost 2.1+ / LightGBM 4.5+ with heavy regularization (`min_child_samples≥20`, `max_depth≤4`, `num_leaves≤15`, L1/L2 ≥1.0)
- **ML-02**: Walk-forward cross-validation with purge + embargo (de Prado methodology)
- **ML-03**: Feature count capped at `floor(sqrt(n_samples))` — typically ≤14 features for Matt's data size
- **ML-04**: Two-target classifier: `entry_attractiveness` AND `entry_profitable` must both agree before a candidate signal is emitted
- **ML-05**: Leak-flagged trades masked from training data (model does not learn Matt's losing patterns)
- **ML-06**: Trained model exported to ONNX and consumed by Node via `onnxruntime-node` (zero runtime Python)
- **ML-07**: ML signal goes live only after out-of-sample profit factor is documented in the range 1.3–2.0; otherwise stays rule-based

### Dashboards (UI)

- **UI-01**: Local web dashboard on `127.0.0.1:3000` (never exposed to LAN) — Fastify + Vite + React + lightweight-charts. Shows positions, PnL, signal history, leak report, approval log.
- **UI-02**: CLI dashboard via Ink — positions, PnL, event stream tail, kill-switch state
- **UI-03**: Both dashboards consume the same core WS stream — zero local state, zero duplicated business logic

### VPS Failover (VPS)

- **VPS-01**: Hostinger VPS provisioned on Ubuntu 24.04 with PM2 + systemd; encrypted secrets via `age` (Windows Credential Manager not available on Linux)
- **VPS-02**: VPS ships as **read-only observer** for ≥1 week of live running before any write capability is toggled on
- **VPS-03**: Distributed lock via single shared Redis: `SET core.leader NX EX 30`, renewed every 10 seconds. Only lock-holder calls executors.
- **VPS-04**: Every order carries a MEXC `newClientOrderId` = `sha256(signal_id + approval_timestamp)` so even a split-brain misfire is idempotent
- **VPS-05**: Telegram webhook is served by the VPS only (not the Windows primary) to avoid duplicate delivery when both are alive
- **VPS-06**: Soft-failback behavior: Windows re-acquires leader role on wake; VPS gracefully demotes without canceling in-flight orders

## Out of Scope

Explicitly excluded. Anti-features from PROJECT.md + research belong here with warnings.

| Feature | Reason |
|---------|--------|
| Fully autonomous execution (no approval) | Violates Core Value — approval IS the product. A signal firing without Matt's tap removes the discipline layer that the entire system exists to create. |
| Paper trading mode | Matt explicitly chose "live $10 is the test." Paper doubles the code surface for zero Core Value. |
| Stop-widening button in approval UI | Stop-widening is itself a tracked leak. Exposing it as a button undercuts the leak-correction story. Only "Tighter stop" (v2) and "Half size" (v2) modifiers will ever exist. |
| Copy-trading / mirror strategies | Defeats style preservation. The whole point is Matt's own motion, not someone else's. |
| LLM / deep-learning signal generation | Violates CPU-only hard constraint and contradicts the "small, regularized, overfit-resistant" ML design. |
| News as a *primary* signal source | News is lagging, ambiguously sentimented, and optimizing on it literally recreates the FOMO-chasing leak the bot is built to detect. Veto-only, never primary. |
| Auto-trust upgrade to autonomy after N successful trades | Removes Matt from the loop → removes the core edge. No escalation path exists. |
| Mobile-native app (iOS / Android / React Native) | Telegram is the mobile surface. Native app would be a full separate product. |
| Tax reporting / portfolio accounting export | The internal ledger exists for the bot, not as a consumer-facing tax product. |
| Strategy marketplace / user-shared presets | Single-user tool by design; sharing strategies imports other people's style and breaks style preservation. |
| X/Twitter monitoring in v1 | X API v2 Basic tier is $200/mo, scraping violates ToS. Feature deferred until Matt has ≥4 weeks of live running and explicit demand signal. Can revisit with Tweetscout or similar aggregators later. |
| KuCoin / Binance / Bybit / Coinbase execution | MEXC-only for v1 executor. Other-venue history ingest may come later but execution stays on MEXC to keep the auth + risk layer simple. |
| Auto-retraining pipeline for the ML model | Manual weekly retrain is fine for v1; automation is scope creep until we know retraining cadence actually matters. |
| CoinGecko dev-activity + social-stats features | Low signal relative to price/funding/regime. Only market data fields used in v2. |

## Traceability

Populated by roadmap generation 2026-04-18. Every v1 and v2 requirement mapped to exactly one phase.

### v1 Requirements (Phases 1-5, weekend MVP)

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete (Plan 01-01) |
| FND-02 | Phase 1 | Pending |
| FND-03 | Phase 1 | Pending |
| FND-04 | Phase 1 | Pending |
| FND-05 | Phase 1 | Pending |
| FND-06 | Phase 1 | Pending |
| FND-07 | Phase 1 | Pending |
| FND-08 | Phase 1 | Pending |
| FND-09 | Phase 1 | Pending |
| FND-10 | Phase 1 | Complete (Plan 01-01) |
| FND-11 | Phase 1 | Pending |
| EXEC-01 | Phase 2 | Pending |
| EXEC-02 | Phase 2 | Pending |
| EXEC-03 | Phase 2 | Pending |
| EXEC-04 | Phase 2 | Pending |
| EXEC-05 | Phase 2 | Pending |
| EXEC-06 | Phase 2 | Pending |
| EXEC-07 | Phase 2 | Pending |
| EXEC-08 | Phase 2 | Pending |
| EXEC-09 | Phase 2 | Pending |
| APP-01 | Phase 3 | Pending |
| APP-02 | Phase 3 | Pending |
| APP-03 | Phase 3 | Pending |
| APP-04 | Phase 3 | Pending |
| APP-05 | Phase 3 | Pending |
| APP-06 | Phase 3 | Pending |
| APP-07 | Phase 3 | Pending |
| APP-08 | Phase 3 | Pending |
| APP-09 | Phase 3 | Pending |
| APP-10 | Phase 3 | Pending |
| SIG-01 | Phase 4 | Pending |
| SIG-02 | Phase 4 | Pending |
| SIG-03 | Phase 4 | Pending |
| SIG-04 | Phase 4 | Pending |
| SIG-05 | Phase 4 | Pending |
| SIG-06 | Phase 4 | Pending |
| SIG-07 | Phase 4 | Pending |
| SIG-08 | Phase 4 | Pending |
| LEDG-01 | Phase 5 | Pending |
| LEDG-02 | Phase 5 | Pending |
| LEDG-03 | Phase 5 | Pending |
| LEDG-04 | Phase 5 | Pending |
| LEDG-05 | Phase 5 | Pending |

### v2 Requirements (Phases 6-10, post-weekend iteration)

| Requirement | Phase | Status |
|-------------|-------|--------|
| FUT-01 | Phase 6 | Pending |
| FUT-02 | Phase 6 | Pending |
| FUT-03 | Phase 6 | Pending |
| FUT-04 | Phase 6 | Pending |
| FUT-05 | Phase 6 | Pending |
| FUT-06 | Phase 6 | Pending |
| FUT-07 | Phase 6 | Pending |
| NEWS-01 | Phase 7 | Pending |
| NEWS-02 | Phase 7 | Pending |
| NEWS-03 | Phase 7 | Pending |
| NEWS-04 | Phase 7 | Pending |
| NEWS-05 | Phase 7 | Pending |
| NEWS-06 | Phase 7 | Pending |
| NEWS-07 | Phase 7 | Pending |
| NEWS-08 | Phase 7 | Pending |
| NEWS-09 | Phase 7 | Pending |
| ML-01 | Phase 8 | Pending |
| ML-02 | Phase 8 | Pending |
| ML-03 | Phase 8 | Pending |
| ML-04 | Phase 8 | Pending |
| ML-05 | Phase 8 | Pending |
| ML-06 | Phase 8 | Pending |
| ML-07 | Phase 8 | Pending |
| UI-01 | Phase 9 | Pending |
| UI-02 | Phase 9 | Pending |
| UI-03 | Phase 9 | Pending |
| VPS-01 | Phase 10 | Pending |
| VPS-02 | Phase 10 | Pending |
| VPS-03 | Phase 10 | Pending |
| VPS-04 | Phase 10 | Pending |
| VPS-05 | Phase 10 | Pending |
| VPS-06 | Phase 10 | Pending |

**Coverage:**
- v1 requirements: 43 total, 43 mapped (Phases 1-5) ✓
- v2 requirements: 32 total, 32 mapped (Phases 6-10) ✓
- Grand total: 75/75 mapped, 0 unmapped, 0 duplicated

---
*Requirements defined: 2026-04-18*
*Last updated: 2026-04-17 after Plan 01-01 execution — FND-01, FND-10 marked complete*
