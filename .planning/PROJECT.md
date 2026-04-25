# kr8tiv-mexc-bot

## What This Is

A personal trading **copilot** for BTC, ETH, and SOL on **MEXC USDT-M futures first** that learns from Matt's real trading activity, detects his behavioral leaks, and suggests long/short entries/exits aligned with his trading "motion" but corrected for recurring mistakes — cross-referenced with market context, fundamentals, and backtested strategy effectiveness. The web app is the primary v1 cockpit: scan setups, compare strategy families, adjust capital, log why a trade exists, and keep Matt accountable before risk leaves his hands.

It is for Matt, a DeFi/AI builder (kr8tiv-ai org) who already trades on MEXC and runs on-chain on Solana + Ethereum. The goal is not to maximize PnL on $10 — that's physically hard. The goal is to turn Matt's own trade history into a self-improvement loop that compounds over many cycles.

## Core Value

**Make Matt a better trader by surfacing what he already does well and correcting what he consistently does wrong — with a futures cockpit that turns signals, backtests, and journaling into accountable decisions.**

If everything else fails but this works (leaks identified, style preserved, one actionable correction per week), the project has succeeded. PnL on $10 is a side effect, not the goal.

## Requirements

### Validated

(None yet — ship to validate)

### Active

**Data ingestion**
- [ ] Ingest 60+ days of MEXC spot + futures trade history via API
- [ ] Parse Solana on-chain swap history for provided Phantom/Solflare wallet(s)
- [ ] Parse Ethereum on-chain swap history for provided MetaMask wallet(s)
- [ ] Normalize all trades into unified schema (timestamp, pair, side, size, price, fee, venue, pnl)

**Behavioral analysis**
- [ ] Extract "trading style fingerprint" — avg hold time, preferred pairs, entry timing patterns, size sizing, time-of-day bias, drawdown tolerance
- [ ] Detect recurring leak patterns — late exits, revenge trades, chasing pumps, ignoring stops, overtrading, FOMO entries, widening stops
- [ ] Produce human-readable weekly "leak report" (top 3 mistakes with evidence from trades)

**Signal generation**
- [ ] Local CPU-only ML model (XGBoost/LightGBM candidate) trained on engineered features: EMA/RSI/ATR/ADX, funding rate, orderbook imbalance, news sentiment, user-style features
- [ ] Regime detection (trend vs range via ADX) to gate strategy selection
- [ ] Emit `{asset, side, entry, stop, target, confidence, rationale, conflicts_with_style?}` suggestion objects
- [ ] Suggestions explicitly preserve Matt's "motion" but flag when he'd normally make a mistake here

**News + fundamentals layer**
- [ ] CryptoPanic integration for aggregated crypto news + sentiment
- [ ] CoinGecko API for market data, dev activity, social stats
- [ ] X/Twitter monitoring — bot analyzes Matt's trade history to propose a starter KOL list
- [ ] On-chain signal monitoring — exchange flows, whale moves (free tier: Arkham-lite, Etherscan, Solscan)
- [ ] News acts as **confirmation or veto** layer on top of ML signals (not primary driver)

**Execution**
- [ ] MEXC Spot API integration (read + write, with risk gating) — base `api.mexc.com`
- [ ] MEXC USDT-M Futures API integration (read + write, with leverage limits) — base `contract.mexc.com`
- [ ] Semi-auto order flow: bot drafts → Telegram alert → user approve → bot fires within a short window
- [ ] Portfolio-level risk manager (per-asset caps, correlation-aware drawdown kill, daily loss circuit breaker)
- [ ] Leverage ceiling enforced by bot (max 5x BTC, 4x ETH, 3x SOL — never MEXC's max)

**User interfaces (all three)**
- [ ] Telegram bot — alerts, inline approve/reject buttons, `/status`, `/panic` kill-switch
- [ ] Local web dashboard (http://localhost:3000) — positions, PnL, signal history, leak report
- [ ] CLI dashboard — terminal live view for ops

**Platform & deployment**
- [ ] Node.js + TypeScript runtime
- [ ] Redis for state (positions, open orders, PnL ledger, signal queue)
- [ ] Windows Credential Manager for API keys, wallet addresses, Telegram token
- [ ] Run primarily on Matt's local Windows machine
- [ ] Hostinger VPS as backup/failover for 24/7 coverage
- [ ] Handle laptop-sleep gracefully (reconcile state on wake)

### Out of Scope

- **Paper-trading mode** — Matt explicitly chose "live from day 1" with $10. The $10 IS the test. Paper ledger would be a needless code path.
- **Multi-exchange execution** — all live orders route to MEXC in v1. Other CEX history (if ever imported) would be read-only; keeps exec layer simple.
- **GPU-dependent ML** — CPU-only by hard constraint. No deep transformers, no large embeddings — gradient-boosted trees or tiny classical models only.
- **Fully autonomous mode (no approval)** — Every order passes through Telegram approval in v1. A future milestone may unlock "trusted" strategies (e.g., mechanical funding farm) for auto-execute, but not v1.
- **Copy-trading / mirror strategies** — Not learning from other traders; learning from Matt's own history.
- **Mobile-native app** — Telegram is the mobile surface. No React Native / iOS app.
- **Tax reporting / portfolio accounting** — Ledger exists internally for the bot but is not a tax product.

## Context

- **Matt's background**: DeFi/AI builder in kr8tiv-ai org; ships on Bags.fm; already trades MEXC live; runs Solana (Phantom/Solflare) + Ethereum (MetaMask) wallets on-chain. Adjacent workspace projects include `kr8tiv-training` (Gemma 4 31B LoRA fine-tunes for KIN companions, GPU-based — NOT this project's ancestor, but shares Python-train → local-runtime pattern) and `kr8tiv-mission-control` (another GSD-managed full-stack workspace).
- **Hardware**: Windows 11 primary — AMD Ryzen 7 7445HS (6 physical / 12 logical cores @ 3.2GHz), 39GB RAM, RTX 4050 Laptop GPU (6GB VRAM) + Radeon 740M. **GPU is NOT used** — CPU-only ML is a hard constraint. XGBoost/LightGBM on ~200 trade samples train in seconds on these 12 threads. Hostinger KVM 1 VPS as backup (1 vCPU, 4GB RAM, Ubuntu 24.04 LTS). Occasional laptop use (must resume cleanly after sleep).
- **GitHub org**: `kr8tiv-ai` (https://github.com/kr8tiv-ai). This repo publishes as `kr8tiv-ai/kr8tiv-trading-bot`. A GitHub PAT is stored in Windows Credential Manager at target `kr8tiv-mexc-bot/github-pat` — used for CI, release automation, and repo creation. Never in git config, `.env`, or source.
- **Capital reality**: $10 live bankroll. This forces the design to optimize for *learning* and *signal quality*, not for printing money. At $10, MEXC futures minimum position sizes become the binding constraint — only a few contracts viable at a time, mostly on ETH (lowest contract notional of the three). MEXC's advantage here is that it often runs zero-fee or low-fee promotions on USDT-M futures, which matters disproportionately at small size.
- **Why MEXC**: Matt trades there. MEXC has broad altcoin reach, periodic zero-fee futures promos, and generally looser KYC tiers. Trade history + live execution both stay on the same venue.
- **Why the copilot framing**: A pure autonomous bot on $10 is mathematically doomed (fees + slippage eat any edge). But a copilot that makes Matt 20% more disciplined compounds forever — that's the actual edge.
- **"Style preservation" is load-bearing**: Matt doesn't want a generic bot; he wants his own strategy + his own taste, with the dumb mistakes filtered out. The signal generator must be biased toward Matt's observed patterns, not toward textbook optimal.

## Constraints

- **Capital**: $10 live starting bankroll — shapes all position sizing, strategy selection, and risk limits.
- **Compute**: CPU-only local ML. No GPU, no cloud inference (OpenAI/Anthropic/Replicate all out). XGBoost/LightGBM or similar classical ML.
- **Authorization**: Semi-auto only in v1 — bot must never place an order without explicit Telegram approval.
- **Tech stack**: Node.js + TypeScript for the bot core, Python allowed for ML training pipeline if needed (most sensible ML tooling is Python). Redis for state.
- **Exchange**: MEXC only for execution. Spot + USDT-M perpetual futures. Separate API bases (`api.mexc.com` for spot, `contract.mexc.com` for futures) with distinct auth schemes and rate limits.
- **Secrets**: Windows Credential Manager for all sensitive keys (MEXC spot + futures API creds, wallets, Telegram bot token).
- **Deployment**: Local-first on Windows 11; Hostinger VPS as secondary instance for 24/7 coverage.
- **Timeline**: Target weekend delivery for v1 (aspirational). Realistic v1 = thin vertical slice that ingests history, builds a minimal style fingerprint, emits at least one approved-via-Telegram trade, and executes it live. Everything else iterates from there.
- **Identity**: All git commits authored as **Matt-Aurora-Ventures** (`lucidbloks@gmail.com`) — the GitHub identity at https://github.com/Matt-Aurora-Ventures. Never as Claude, Kr8tiv AI, or any other name. No `Co-Authored-By: Claude` lines.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Execution venue: MEXC | Matt's active venue; broad altcoin reach; frequent zero-fee futures promos matter at $10 scale | — Pending |
| Web-first futures cockpit, Telegram secondary | Matt now wants the local app/panel to be the basis: signal scan, backtest lab, capital controls, quick trade logging, and accountability prompts. Telegram remains optional notification plumbing, not the core product. | ✅ Updated 2026-04-25 |
| Local CPU ML (XGBoost/LightGBM candidate), no GPU | Matt's explicit constraint; keeps bot self-contained + private | — Pending |
| MEXC-only execution, multi-venue history | Matt's active venue; simplifies exec layer; history still captures full picture | — Pending |
| Three UIs (Telegram + local web + CLI) | Matt wants all three; each serves a different mode (approval, deep-dive, ops) | ⚠️ Revisit — may trim if weekend target slips |
| Live from day 1, no paper mode | Matt's explicit choice — "$10 IS the test" | — Pending |
| Windows Credential Manager for secrets | Matt's explicit choice — most secure OS-level option | — Pending |
| Primary Windows + Hostinger VPS backup | Covers laptop sleep / offline risk while staying cheap | — Pending |
| Style-preserving, not style-overriding model | Core Value: make Matt better, not replace him | — Pending |
| News as confirmation/veto, not primary signal | ML + user style drives entries; news filters false positives | — Pending |
| Futures risk modes: sniper / medium / core | Matt sometimes takes 30x-100x snipes, but the app must label them, shrink margin, demand a clear reason, and default most lower-confidence app ideas into medium risk. | ✅ Updated 2026-04-25 |
| Backtest before capital | Every visible strategy family should show recent replay evidence (net PnL, win rate, PF, drawdown, trade count) so Matt can see whether breakout or adaptive grid is currently effective for BTC/ETH/SOL. | ✅ Updated 2026-04-25 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-18 after initialization*
