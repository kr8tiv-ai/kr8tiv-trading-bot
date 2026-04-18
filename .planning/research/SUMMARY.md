# Project Research Summary

**Project:** kr8tiv-mexc-bot
**Domain:** Personal semi-auto trading copilot (MEXC spot + USDT-M futures, local CPU-only ML, Telegram approval)
**Researched:** 2026-04-18
**Confidence:** MEDIUM-HIGH

## Executive Summary

This is not a trading bot. It is a **copilot that reverse-engineers Matt's own 60-day trade history to detect his behavioral leaks, then gates every order through Telegram approval**. The edge is not alpha — it is discipline. The $10 bankroll exists to force honesty about fees, slippage, and minimum notional; it is a validator, not a profit target. Nothing in the competitive landscape (3Commas, Cornix, Coinrule, Freqtrade) does "learn from MY history + flag MY leaks + veto my usual mistakes." That gap is the product.

The stack is opinionated and load-bearing: **Node 22 LTS + TypeScript + CCXT 4.5.x** for all MEXC access (CCXT is the only sane option since the official `mexc-api-sdk` is abandoned and browser-session-token forks violate ToS), **Python quarantined to ML training** with ONNX handoff to `onnxruntime-node` (zero Python in the trade path), **Redis + better-sqlite3** for hot state + append-only ledger, **grammY** for Telegram, **@zowe/secrets-for-zowe-sdk** as the keytar replacement for Windows Credential Manager. Two critical external dates frame the work: **MEXC opened its Futures API to all KYC'd retail users on March 31, 2026** (pre-2026 "institutional-only" advice is obsolete), and **MEXC migrates the futures access domain on Jan 12, 2026** — base URLs must be config-driven, never hardcoded.

Five risks can kill this project: (1) treating MEXC spot and futures as one client — they have different bases, signatures, rate limits; (2) split-brain double-firing when Windows + VPS both run — solved by a single shared Redis lock + MEXC `newClientOrderId` idempotency; (3) overfitting XGBoost on ~200 samples of Matt's history — solved by making ML *secondary* to rule-based regime filters and leak veto; (4) laptop sleep corrupting state — solved by mandatory server-side stops on MEXC and boot-time reconciliation; (5) leak detectors flagging winning patterns — solved by requiring ≥20 samples + negative EV before any leak vetoes a signal. The weekend v1 avoids all five by being small enough to skip them: **ETHUSDT spot only, Windows-only (no VPS), rule-based signal (no ML), one leak detector (revenge trade), Telegram approval with 90s TTL.**

## Key Findings

### Recommended Stack

**Core runtime:** Node.js 22 LTS + TypeScript 5.5+ strict, managed via pnpm workspaces. Node 20 EOLs April 30, 2026 — using it now is liability.

**MEXC access:** CCXT 4.5.48+ as primary; native `node:crypto` HMAC as escape hatch. Two separate client classes (`MEXCSpotClient`, `MEXCFuturesClient`) from day one — different bases (`api.mexc.com` vs `contract.mexc.com`), different signatures, different rate buckets.

**ML pipeline:** Python 3.12 (quarantined, offline-only) trains XGBoost 2.1+ / LightGBM 4.5+ → exports ONNX → Node loads with `onnxruntime-node` 1.22+. Zero runtime Python coupling.

**State + persistence:** Redis 7.4+ via ioredis (hot state, streams, BullMQ, distributed lock) + better-sqlite3 11.7+ with `PRAGMA journal_mode=WAL; synchronous=FULL` (append-only ledger).

**UIs:** grammY (Telegram — winner over Telegraf for greenfield TS), Fastify + Vite + React + lightweight-charts (web dashboard), Ink (CLI).

**Secrets:** @zowe/secrets-for-zowe-sdk wrapped in a `SecretProvider` abstraction. Windows → Credential Manager via wincred; VPS → encrypted file via `age`/`sops`. Never WinCredMan-only APIs — it breaks on Linux and under Local System.

**On-chain:** @solana/kit (renamed web3.js v2) + Helius parsed transactions for Solana; viem + Alchemy for Ethereum. Helius parsed output > raw RPC (handles decimals, Jupiter multi-hop, wrap/unwrap).

**Do not use:**
- `mexc-api-sdk` (abandoned, signature bugs open since Dec 2025)
- `oboshto/mexc-futures-sdk` or `vecful/mexc-futures-api` (browser-session-token reverse-engineering, ToS violation, account-ban risk)
- `keytar` (archived Dec 2022)
- `blessed-contrib` (last published 2022)
- `ts-node`, `Express`, `Telegraf`, `@solana/web3.js` v1, `Bull` (all superseded in 2026)

Full stack detail: `.planning/research/STACK.md`

### Expected Features

**Must have for v1 (table stakes):**
- MEXC Spot API read + write (HMAC signed, Windows Credential Manager for keys)
- Trade history ingest (60+ days, paginated)
- Unified trade schema (timestamp, pair, side, size, price, fee, venue, pnl)
- Telegram bot with inline Approve/Reject + 90s approval TTL
- Position-aware state (Redis hot + SQLite ledger)
- Leverage cap (4x ETH) + daily loss circuit breaker ($2 absolute)
- Panic kill-switch (`/panic` → cancel-all + halt)
- Signal rationale string in every approval card
- Windows Credential Manager for all secrets

**Differentiators (the reason the product exists):**
- **Style fingerprint** — per-user profile: avg hold, hour-of-day expectancy, size distribution, TP:SL realized, win/loss hold asymmetry
- **Leak detectors** — revenge trade, FOMO entry, late exit (bag holding), stop widening, overtrading, ignored stop, time-of-day abuse, size inflation after losses
- **Conflict-with-style flag** — every signal labels "this matches your motion" vs "this is textbook optimal when you'd usually do X wrong"
- **News as veto only** — CryptoPanic can downgrade confidence; can never upgrade above ML's standalone output
- **Approve-and-modify UI** — Approve / Tighter stop / Half size / Reject (never a "widen stop" button — that's a flagged leak)
- **Weekly leak report** — top 3 mistakes with trade-ID evidence, not generic advice

**Explicitly anti-features:**
- Fully autonomous mode (violates constraint; approval IS the value)
- Paper trading (Matt chose $10 live as the test)
- Generic strategy marketplace / copy-trading (defeats style preservation)
- LLM/deep-learning signal generation (violates CPU-only + explicit ML choice)
- Stop-widening override in approval UI (the widen itself is a tracked leak)
- News-as-primary-signal (lagging, ambiguous, front-run)
- Auto-trust-upgrade to autonomy after N trades (removes Matt from loop = removes edge)

Full feature detail: `.planning/research/FEATURES.md`

### Architecture Approach

Single Node process (`apps/core`) in a pnpm + Turborepo monorepo. Internal components wired through Redis Streams as an event bus (`trades.raw` → `features.v1` → `signals.candidate` → `signals.filtered` → `approvals.pending` → `approvals.decided` → `orders.executed` → `pnl.delta`). Three UIs (Telegram, web, CLI) are thin RPC clients; zero business logic lives in them. Python trainer is a separate offline process communicating via filesystem (ONNX files + SQLite reads).

**Key architectural patterns:**
1. **Append-only ledger** — every state change INSERTs a row; current state is a projection. Matches MEXC's own semantics, makes reconciliation natural.
2. **Executor subscribes ONLY to `approvals.decided{approved:true}`** — type-level invariant that prevents accidental bypass of risk gate + approval.
3. **Two MEXC clients, not one** — separate packages for spot and futures, sharing only the `Order` type. No shared auth, no shared rate bucket, no shared WS.
4. **Python-trained, Node-inferred via ONNX** — model refresh = file drop + hot reload. No live IPC between languages.
5. **Single-Redis + distributed lock (not Sentinel)** for Primary+VPS — with only 2 nodes, any Sentinel quorum is either split-brain-possible (quorum=1) or unfailover-able (quorum=2). Shared Redis holding `core.leader` key with TTL is the correct primitive.

**Major components:**
1. **Ingester** — MEXC spot+futures history + live WS + on-chain swaps → normalized `Trade` rows
2. **Analyzer** — fingerprint extraction + leak detection (pure TS over SQLite)
3. **Signal Generator** — ONNX inference (XGBoost/LightGBM), regime-gated (ADX trend/range)
4. **News/Fundamentals Filter** — CryptoPanic + CoinGecko + on-chain flow → veto or confidence downgrade
5. **Risk Manager** — synchronous pre-trade gate (leverage cap, daily loss, per-asset caps, correlation)
6. **Approval Orchestrator** — BullMQ deferred job with TTL, Telegram round-trip
7. **MEXC Spot Executor + MEXC Futures Executor** — separate clients, separate rate buckets
8. **Ledger + Reconciler** — append-only SQLite + boot/wake state repair against MEXC truth

Full architecture detail: `.planning/research/ARCHITECTURE.md`

### Critical Pitfalls (top 5)

| # | Risk | Mitigation | Phase |
|---|------|-----------|-------|
| 1 | **MEXC spot+futures conflation** → signing bugs, mixed rate buckets, Jan 2026 domain migration breaks silently | Two client classes from day one, config-driven base URLs, smoke test hits both pings on startup | Phase 1 |
| 2 | **Split-brain double-fire** (Windows + VPS both execute same signal = instant liquidation at $10) | VPS ships read-only in v1. Single shared Redis lock (`SET core.leader NX EX 30`). Every order carries MEXC `newClientOrderId` idempotency key = sha256(signal_id + approval_timestamp) | Phase 10+ (VPS deferred until post-v1) |
| 3 | **ML overfitting on ~200 samples** → beautiful in-sample Sharpe 3.0, live money bleed | Rule-based signal in v1; ML is secondary and only ships after walk-forward OOS profit factor 1.3–2.0. Feature count ≤ sqrt(samples). Mask trades flagged as leaks from training. Two-target classifier: `attractive` AND `profitable` must both agree | Phase 8+ (ML deferred past weekend v1) |
| 4 | **Laptop sleep = orphan orders, no stops** — MEXC fills at 4am, bot wakes at 9am, opens 2x position with no stop | Mandatory server-side stops on MEXC (`triggerPrice` orders) for every entry. Boot-time reconciler pulls 24h of fills, diffs vs ledger, blocks trading until clean. Wake detected via `wake-event` npm + soft heartbeat fallback | Phase 2 (exec) + Phase 5 (resume) |
| 5 | **Minimum notional eats bankroll** — naive % sizing at $10 produces `30005` errors; spot fees+slippage = 0.15% round-trip | Pre-order: pull `contract_detail`, compute `minNotional = minVol * contractSize * markPrice`, reject if `2 * minNotional > available_margin`. Whitelist **ETHUSDT only** for v1 (smallest viable contract notional at $10). `requiredEdge = slippage + 2*fee` recomputed per trade, fees queried dynamically (never hardcoded 0 because of current zero-fee promo) | Phase 2 |

Full pitfall detail + 10 more: `.planning/research/PITFALLS.md`

## Implications for Roadmap

The four researchers proposed 6 / 6 / 19 / 15 phases respectively. Reconciled into **one build sequence aligned to the weekend v1 target** below. Each phase is small enough to execute in hours, not days. Phases 1–5 = weekend MVP; Phases 6+ = iterate from live.

### Phase 1: Foundation — Scaffold + Secrets + MEXC Spot Read
**Rationale:** Everything downstream reads from MEXC history. Nothing can ship without secrets handling. Two MEXC clients from day one or you'll rewrite.
**Delivers:** pnpm+Turborepo monorepo, SQLite WAL schema, Redis bus, `SecretProvider` abstraction (WinCredMan on Windows), CCXT-based `MEXCSpotClient` + `MEXCFuturesClient` (read-only, separate), startup smoke test hitting both pings, gitleaks pre-commit hook, log redactor for all secret patterns.
**Uses:** Node 22 + TS strict, CCXT, @zowe/secrets, Zod, pino, ioredis, better-sqlite3.
**Avoids:** Pitfalls 1 (spot/futures conflation), 4 (cross-user secret break), 10 (secret leakage), 11 (WS silent disconnect — handled when WS lands).

### Phase 2: Execution Skeleton — Spot Write Path with Safety Rails
**Rationale:** Prove you can place + kill orders on $10 before any ML or signal generation. The risk manager must exist before the executor.
**Delivers:** MEXC spot order placement with mandatory `newClientOrderId` idempotency, position-aware state in Redis, leverage cap (4x ETH), daily loss circuit breaker ($2), panic kill-switch (`/panic`), server-side stop-loss attached to every entry, pre-order `minNotional` check vs `contract_detail`, fee rate queried dynamically. Pair whitelist: ETHUSDT only.
**Avoids:** Pitfalls 3 (minimum notional), 5 (double-fire — idempotency key even though VPS not yet in play), 6 (server-side stops survive sleep), 12 (zero-fee promo ends), 15 (delisting — whitelist).

### Phase 3: Telegram Approval Loop
**Rationale:** Core Value = "never fires without approval." This IS the safety rail. Needs state machine + TTL or stale approvals bite.
**Delivers:** grammY bot bound to Matt's chat ID only, inline Approve/Reject keyboard, 90-second approval TTL with auto-expire message edit, `answerCallbackQuery` within 50ms (silent-drop prevention), signal card with entry / stop / target / confidence / rationale / **price delta** (current vs signal price) / fee+slippage USD estimate, `/status` and `/panic` commands. Cap: ≤ 5 signals/day. Post-reject 30min cooldown on same pair.
**Avoids:** Pitfall 7 (alert fatigue + stale approvals + silent callbacks).

### Phase 4: Style Fingerprint + Rule-Based Signal + First Leak Detector
**Rationale:** Without style fingerprint the differentiator story collapses. Must be validated early. Rule-based signal (EMA crossover + ADX regime gate) is the scaffold — proves pipeline before investing in XGBoost.
**Delivers:**
- History ingest (MEXC spot 60+ days, paginated, `status=success` filter) into unified schema
- Basic fingerprint: avg hold, median size, hour-of-day expectancy, win/loss hold asymmetry
- Rule-based signal generator (EMA20/EMA50 crossover + ADX gate: <15 block, 15-25 transitional, >25 trade)
- One leak detector: **revenge trade** (entry within 30min of loss, same pair, size ≥ previous). Validated with ≥20 sample EV check.
- Conflict-with-style flag in approval card (at minimum: "you don't usually trade this hour")
- Regime + funding-rate visible in rationale
**Avoids:** Pitfall 8 (false-positive leaks — EV validation baked in from start).

### Phase 5: Ledger + Reconciler + First Live Trade
**Rationale:** Append-only ledger closes the loop. Reconciler is the seatbelt for laptop sleep. Ship the first approved-via-Telegram live ETH spot trade — the project has already succeeded per Core Value.
**Delivers:** Complete signal → approval → order → fill → PnL pipeline written to SQLite ledger. Boot-time reconciler (pulls 24h of MEXC fills, diffs vs ledger, blocks exec until clean). Wake detection via `wake-event` + 5s heartbeat soft-detect. Windows `SetThreadExecutionState` to prevent sleep during active trading mode.
**Avoids:** Pitfall 6 (laptop sleep orphan orders).

**=== END OF WEEKEND v1 ===**

### Phase 6: Futures Write Path + Full Leak Suite + Weekly Report
Enables leverage at small size (ETH contracts ~0.01 ETH = smallest viable at $10). Futures has separate auth, separate WS handshake, separate rate bucket — treat as greenfield, not an extension of spot. Add full leak detector suite (FOMO entry, late exit, stop widening, overtrading, ignored stop, time-of-day abuse, size inflation). Weekly Telegram digest: "Top leak this week: X. Evidence: 3 trades. Projected savings if fixed: $Y." Hits Pitfall 1 again (verify futures write is actually permitted on Matt's account tier — MEXC has historically restricted this; degrade to read-only+alert if 403).

### Phase 7: News Veto Layer + On-chain Ingest
CryptoPanic (poll every 2min, cache 5min, stays under 50/hr free tier) + CoinGecko Demo. News downgrades confidence only — never upgrades above ML standalone output. Source whitelist (Coindesk, The Block, Bloomberg, Reuters, verified project accounts). Require ≥2 independent sources for sentiment flip. Time-decay half-life 15min. On-chain: Solana via Helius parsed transactions (handles Jupiter multi-hop, decimals, failed-tx filter), Ethereum via Alchemy `getAssetTransfers`. Hits Pitfalls 9 (pump-and-dump via news), 14 (on-chain parsing bugs).

### Phase 8: XGBoost/LightGBM ML Signal
Python trainer (quarantined in `apps/trainer-py`), walk-forward CV with purge + embargo (de Prado), heavy regularization (`min_child_samples≥20`, `max_depth≤4`, `num_leaves≤15`, L1/L2 ≥1.0). Features capped at ~14 (sqrt of ~200 samples). **Two-target classifier**: `entry_attractiveness` AND `entry_profitable` must both agree. Mask leak-flagged trades from training. Export ONNX, hot-load in Node. Must demonstrate OOS profit factor 1.3–2.0 before going live — if not, stay rule-based. Hits Pitfalls 2 (overfitting) and 13 (style copy becomes loser copy).

### Phase 9: Web + CLI Dashboards
Fastify + Vite + React + lightweight-charts on `127.0.0.1:3000` (never exposed). Ink CLI for terminal ops view. Both read from the same core WS stream — zero UI-local state.

### Phase 10: Hostinger VPS Failover (READ-ONLY first)
Ubuntu 24.04 + PM2 + systemd, encrypted secrets via `age`. VPS ships **read-only for ≥1 week of live running** before any write toggle. Then add distributed lock (`SET core.leader NX EX 30`, renewed every 10s). Telegram via webhook (VPS only) to avoid duplicate delivery. Windows = primary holder, VPS takes over when heartbeat stops, soft-failback when Windows wakes. Hits Pitfall 5 (split-brain).

### Phase Ordering Rationale

- **Secrets + two-client MEXC BEFORE any order code** — retrofitting either is expensive and dangerous.
- **Risk manager BEFORE executor** — never wire execution without the safety layer.
- **Approval orchestrator BEFORE executor write path** — Core Value preservation.
- **Ledger BEFORE reconciler** — reconciler needs something to diff against.
- **Style fingerprint BEFORE signal generation** — fingerprint informs features AND the "conflict-with-style" flag.
- **Leak detector with EV validation BEFORE ML training** — ML target masks leak-flagged trades; leaks must be real first.
- **Spot write BEFORE futures write** — auth and semantics differ; get one working before adding the other.
- **VPS AFTER ≥1 week of stable local operation** — split-brain on day 1 with $10 is game over.

### Research Flags

**Phases likely needing deeper research during planning:**
- **Phase 6 (Futures write):** Verify Matt's MEXC account actually has futures API write enabled on the key (the Mar 31 2026 public launch grants it in principle; confirm in Matt's key settings). Also verify Jan 12 2026 domain migration status at time of build.
- **Phase 7 (News / on-chain):** CryptoPanic free tier quota (50–200 req/hr claimed, verify at time of use). Helius free-tier limits for Solana parsed transactions on Matt's wallet activity volume.
- **Phase 8 (ML):** Sample count is only knowable once Phase 4 ingest runs. If Matt has <150 usable entries in 60d, consider extending to 90d or deferring ML further. Two-target construction needs empirical tuning.
- **Phase 10 (VPS):** Litestream vs rsync for SQLite sync, WireGuard vs SSH tunnel for Redis exposure. Tailscale is the lowest-friction option worth evaluating.

**Standard patterns (skip research-phase):**
- **Phase 1, 2, 3, 5** — foundation, execution, Telegram, ledger are well-documented. CCXT + grammY + better-sqlite3 are battle-tested.
- **Phase 4** — rule-based EMA/ADX signals are textbook; style fingerprint is straightforward aggregation.

### Critical Open Questions (resolve before or during noted phases)

1. **MEXC futures API write for Matt's personal account** — policy says public since Mar 31 2026, but futures key permission must be explicitly enabled in the MEXC web UI. Failure mode: returns 403, bot degrades to read-only + alert. **Resolve before Phase 6.**
2. **ETH contract notional at live prices** — BTC contract = 0.0001 BTC, SOL contract multiplier is larger than ETH at current prices; ETH at 0.01 ETH is the only consistently affordable contract at $10. Must verify at current ETH price during Phase 2. **Resolve during Phase 2.**
3. **CryptoPanic free-tier quota** — research says 50–200 req/hr, but the floor matters. Poll rate of 1 req / 2min (30/hr) fits the floor. **Resolve during Phase 7.**
4. **Jan 12, 2026 MEXC futures domain migration** — base URL changes. Code must be config-driven; verify active base URL against MEXC docs at time of Phase 1 build. **Resolve during Phase 1.**
5. **X/Twitter KOL feasibility** — API v2 Basic = $200/mo with heavy restrictions. Scraping violates ToS. Tweetcatcher and similar exist but are fragile. **Feature explicitly deferred past v1; revisit only if Matt wants it after ≥4 weeks of live running.**

## What Ships in v1 This Weekend

**Scope (= Phases 1–5):**
- pnpm+Turborepo monorepo, SQLite WAL, Redis, WinCredMan via `SecretProvider` abstraction
- `MEXCSpotClient` (CCXT) with HMAC signing, read-only history ingest for 60+ days of Matt's ETHUSDT trades
- `MEXCSpotClient` write path: market/limit orders with mandatory `newClientOrderId`, server-side stop-loss on every entry, `minNotional` pre-check, pair whitelist = ETHUSDT only
- Risk manager: 4x leverage cap, $2 daily loss circuit breaker, `/panic` command
- Redis hot state: open positions, pending approvals, rate buckets
- Append-only SQLite ledger: signals, approvals, orders, fills, PnL
- grammY Telegram bot: inline Approve/Reject, 90s TTL, price-delta + fee estimate in card, `/status` + `/panic`, chat-ID-locked to Matt
- Rule-based signal: EMA20/EMA50 crossover gated by ADX regime detection (not ML)
- Style fingerprint (basic): avg hold, median size, hour-of-day expectancy, win/loss hold asymmetry
- One leak detector: revenge trade (EV-validated on history)
- Conflict-with-style flag in approval card
- Boot-time + wake-time reconciler: pulls 24h fills from MEXC, diffs vs ledger, blocks exec until clean
- gitleaks pre-commit hook, log redactor, trading-only + IP-whitelisted MEXC API key
- **One live ETH spot trade, approved via Telegram, executed end-to-end.** Core Value validator.

**Success criteria:** Matt receives a Telegram card, taps Approve, bot fires the trade, fill arrives, ledger updated, PnL reflected. First leak report draft (even if only revenge-trade) is computable from his 60-day history. Nothing else matters for v1.

## What's Explicitly Out of v1

| Deferred | Why | When |
|----------|-----|------|
| **X/Twitter monitoring + KOL proposer** | API v2 Basic is $200/mo; scraping fragile; Matt's existing trading flow doesn't depend on KOL signals yet | Revisit only after ≥4 weeks live, if leak reduction signal is already there |
| **Hostinger VPS failover** | Split-brain double-fire kills $10 in one mistake; distributed lock + idempotency key must be proven on local-only first | Phase 10 (after ≥1 week stable local) |
| **MEXC USDT-M futures write path** | Spot proves the vertical slice first; futures has separate auth + confirms sizing works before adding leverage | Phase 6 |
| **Fully autonomous mode** | Violates PROJECT.md constraint; approval IS the product | Never in v1; possible future "trusted strategy" track with hardcoded caps |
| **Paper trading mode** | Matt chose live $10 as the test; paper doubles code paths for zero value | Never |
| **XGBoost/LightGBM ML signal** | ~200 samples on default params = guaranteed overfit; rule-based + leak veto is safer and ships faster | Phase 8, only after walk-forward OOS profit factor 1.3–2.0 documented |
| **Web dashboard + CLI dashboard** | Telegram alone delivers v1 value (alert → approve → fire). Dashboards are deep-dive UIs for iteration 2 | Phase 9 |
| **BTC + SOL pairs** | SOL contract too large at $10 · 3x; BTC contract OK but one whitelist simpler; prove on ETH first | Phase 6+ |
| **Full leak detector suite** (FOMO, late exit, stop widening, overtrading, ignored stop, time-of-day, size inflation) | Revenge trade is easiest + highest-frequency + most damaging; proves the pipeline | Phase 6 |
| **On-chain ingest (Solana + Ethereum wallets)** | Richer fingerprint but not required for first approved trade; MEXC history alone is sufficient for v1 fingerprint | Phase 7 |
| **CryptoPanic news veto** | Adds complexity; ML/rule + style is primary driver | Phase 7 |
| **Weekly leak report** | Stub output in Phase 4; formatted Telegram digest in Phase 6 | Phase 6 |
| **Modify-in-approval buttons** (Tighter stop, Half size) | Approve/Reject only for v1 — simpler state machine; modify is Phase 6 differentiator | Phase 6 |
| **CoinGecko dev-activity + social stats features** | Low priority; ML signal doesn't need them | Phase 7+ |
| **Auto-retraining pipeline** | Weekly offline manual retrain is fine; automation is scope creep | Phase 8+ |

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Ecosystem + Node/ML split verified. MEDIUM on CCXT-vs-native tradeoff (covered by escape-hatch design). HIGH on WinCredMan via Zowe, HIGH on futures API public-since-Mar-31-2026 (official announcement). |
| Features | MEDIUM-HIGH | HIGH on Telegram UX patterns, risk features, MEXC account mechanics. MEDIUM on leak-detection specific thresholds (will tune against Matt's actual data in Phase 4). |
| Architecture | HIGH | Core topology + event bus + ONNX handoff are standard patterns. MEDIUM on split-brain exact mechanics (covered by single-Redis+lock design — simpler and safer than Sentinel). |
| Pitfalls | HIGH | MEXC specifics verified against official docs. ML overfitting backed by de Prado / quant-finance literature. |

**Overall confidence:** HIGH for weekend v1 (Phases 1–5). MEDIUM for Phases 6–10 (depend on empirical data from live running + external constraints not yet resolved).

### Gaps to Address

- **Sample size for ML training** — only knowable after Phase 4 ingest. If <150 usable entries in 60d, extend lookback or stay rule-based indefinitely.
- **MEXC futures API write permission on Matt's account** — assumed granted per Mar 31 2026 public launch, must verify at Phase 6.
- **CryptoPanic free-tier rate limit floor** — research shows 50–200/hr; design for the floor (1 req / 2min = 30/hr) to be safe.
- **Helius free tier volume** — may need to upgrade to $99/mo Developer plan if Matt's wallet activity volume exceeds free quotas during Phase 7 backfill. Cheaper than debugging parsing bugs on $10.
- **MEXC zero-fee promo list for Matt's region** — promos have regional exclusions that changed in Apr 2025 and Aug 2025. Fee rate must be queried dynamically per Pitfall 12, never hardcoded 0.
- **Windows power-broadcast reliability** — `wake-event` npm wraps native handler but soft 5s heartbeat fallback is mandatory as safety net.

---
*Research completed: 2026-04-18*
*Ready for roadmap: yes*
*Detailed research: STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md*
