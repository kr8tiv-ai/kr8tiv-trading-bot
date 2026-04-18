<!-- GSD:project-start source:PROJECT.md -->
## Project

**kr8tiv-mexc-bot**

A personal trading **copilot** for BTC, ETH, and SOL on **MEXC** (spot + USDT-M futures) that learns from Matt's last ~60 days of real trading activity, detects his behavioral leaks, and suggests entries/exits aligned with his trading "motion" but corrected for recurring mistakes — cross-referenced with crypto news and on-chain fundamentals. The bot runs a **local CPU-only ML model** (no GPU, no cloud inference), operates semi-autonomously (drafts orders → Telegram ping → Matt taps approve → bot fires), and starts with a live $10 bankroll as the first real test.

It is for Matt, a DeFi/AI builder (kr8tiv-ai org) who already trades on MEXC and runs on-chain on Solana + Ethereum. The goal is not to maximize PnL on $10 — that's physically hard. The goal is to turn Matt's own trade history into a self-improvement loop that compounds over many cycles.

**Core Value:** **Make Matt a better trader by surfacing what he already does well and correcting what he consistently does wrong — with a bot that never fires without his approval.**

If everything else fails but this works (leaks identified, style preserved, one actionable correction per week), the project has succeeded. PnL on $10 is a side effect, not the goal.

### Constraints

- **Capital**: $10 live starting bankroll — shapes all position sizing, strategy selection, and risk limits.
- **Compute**: CPU-only local ML. No GPU, no cloud inference (OpenAI/Anthropic/Replicate all out). XGBoost/LightGBM or similar classical ML.
- **Authorization**: Semi-auto only in v1 — bot must never place an order without explicit Telegram approval.
- **Tech stack**: Node.js + TypeScript for the bot core, Python allowed for ML training pipeline if needed (most sensible ML tooling is Python). Redis for state.
- **Exchange**: MEXC only for execution. Spot + USDT-M perpetual futures. Separate API bases (`api.mexc.com` for spot, `contract.mexc.com` for futures) with distinct auth schemes and rate limits.
- **Secrets**: Windows Credential Manager for all sensitive keys (MEXC spot + futures API creds, wallets, Telegram bot token).
- **Deployment**: Local-first on Windows 11; Hostinger VPS as secondary instance for 24/7 coverage.
- **Timeline**: Target weekend delivery for v1 (aspirational). Realistic v1 = thin vertical slice that ingests history, builds a minimal style fingerprint, emits at least one approved-via-Telegram trade, and executes it live. Everything else iterates from there.
- **Identity**: All git commits authored as **Matt-Aurora-Ventures** (`lucidbloks@gmail.com`) — the GitHub identity at https://github.com/Matt-Aurora-Ventures. Never as Claude, Kr8tiv AI, or any other name. No `Co-Authored-By: Claude` lines.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Executive Summary
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | **22.x LTS** (active LTS through Apr 2027) | Runtime for bot core, UIs, execution layer | Node 20 hits EOL 2026-04-30 — using it now is a liability. Node 24 LTS is current but 22 has the largest ecosystem alignment (onnxruntime-node, better-sqlite3, native crypto) and one more year of runway than 20. Node 24 is viable; 22 is safer for ship-this-weekend. |
| TypeScript | **5.5+** (5.7 current) | Type-safe core, infers MEXC response shapes, enables strict null checks on order objects | Non-negotiable for a bot handling real money — runtime errors on order construction are catastrophic. Strict mode must be on. |
| CCXT | **4.5.48+** (released daily, pick latest stable at install time) | Unified client for MEXC spot + USDT-M swap (futures), order book WS | Active development (daily releases), first-class MEXC `swap` support marked `true` in the abstract, handles HMAC-SHA256 signing internally, supports WebSocket orderbook + trades via `ccxt.pro`. The only library that covers both venues with one auth abstraction. |
| Redis | **7.4+** | State (positions, open orders, PnL ledger snapshot, signal queue, rate-limit buckets, order-approval pending queue) | Standard for trading bots. Sub-ms latency. BullMQ requires it. On Hostinger VPS: use the apt package (`redis-server` 7.x on Ubuntu 24.04). On Windows: Memurai or WSL2 Redis (native Windows Redis was discontinued). |
| ioredis | **5.4+** | Redis client for Node | Both ioredis and node-redis are solid in 2026. Choose **ioredis** here because BullMQ uses it internally (zero duplicate connection pool) and because its cluster + Lua script support is battle-tested for trading use cases. |
| Python | **3.12** (separate process, ML pipeline only) | XGBoost/LightGBM training, feature engineering notebooks, ONNX export | TypeScript has no usable native gradient-boosted tree training library. Python owns this layer. Keep it quarantined to training only; inference stays in Node via ONNX. |
| XGBoost | **2.1+** | Gradient-boosted trees for signal generation | Industry default for tabular CPU ML. Trains in minutes on 60 days of trade + candle features. Exports cleanly to ONNX. |
| LightGBM | **4.5+** | Alternative/companion to XGBoost | Faster training on sparse features (useful when news/sentiment features dominate). Same ONNX pathway. Keep both — ensemble often beats single model. |
| ONNX Runtime for Node | **onnxruntime-node 1.22+** | CPU inference of XGBoost/LightGBM models from Node at runtime | Lets the bot core stay 100% TypeScript at runtime. Requires Node 16+ (strongly recommend 20+). Windows x64 + Linux x64 both first-class. CPU-only is explicitly supported as the default execution provider — no GPU, no cloud, satisfies the hard constraint. |
| better-sqlite3 | **11.7+** | Local trade ledger (MEXC trades, on-chain swaps, signals, approvals, PnL) | Synchronous API = no race conditions on ledger writes. ~2000 qps with indexes. Perfect for embedded append-mostly ledger. Redis holds hot state; SQLite holds history. |
| Zod | **3.23+** | Runtime validation of every MEXC API response and every cross-chain swap record | Order objects **must** be validated before execution. Valibot is smaller but Zod's ecosystem + error messages are worth it server-side where bundle size doesn't matter. Parse-don't-validate discipline prevents a malformed MEXC response from becoming a bad order. |
### MEXC Execution Layer
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **ccxt** | 4.5.48+ | Primary MEXC client, spot + swap | Default for all order placement, balance fetching, trade history ingestion, orderbook snapshots, WS subscriptions via `ccxt.pro`. Covers 95% of needs. |
| **ccxt.pro** | bundled with ccxt 4.5+ | WebSocket streams for MEXC (orderbook, trades, kline) | Needed for low-latency signal generation. Note known issue: slow orderbook WS startup on low-volume MEXC pairs ([ccxt#18281](https://github.com/ccxt/ccxt/issues/18281)) — BTC/ETH/SOL are fine. |
| **Native `node:crypto` HMAC-SHA256** | built-in | Direct calls to MEXC endpoints CCXT doesn't unify (e.g. broker-specific, promo-eligibility, specific margin modes) | Fallback escape hatch. MEXC signature is `hmac-sha256(secret, queryString)` with `ApiKey`, `Request-Time`, `Signature` headers for spot V3; contract API uses a different combined string format — always check the docs per endpoint. |
| **ws** | 8.18+ | Raw WebSocket when CCXT doesn't cover a MEXC contract channel | Direct `wss://contract.mexc.com/ws` for futures private channels if needed. |
| **@theothergothamdev/mexc-sdk** | 1.3.0 | **Reference only** — community fork of the abandoned official SDK | Read its source to cross-check signature implementations. **Do NOT adopt as primary dependency** — no guarantee of ongoing maintenance. |
### On-Chain Parsing
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **@solana/kit** | 2.1+ (this is the renamed `@solana/web3.js` v2 SDK, renamed Dec 2024 to avoid confusion) | Solana RPC client, tree-shakable, modern FP API | Primary Solana client. ~26% smaller bundles, ~10x faster crypto ops vs web3.js v1. Keypair is now `KeyPairSigner`. |
| **@solana/compat** | 2.x | Interop between `@solana/kit` and legacy `@solana/web3.js` v1 objects (PublicKey, Keypair, VersionedTransaction) | Use only if you pull in a dependency still on v1. Matt's project is greenfield — probably not needed. |
| **Helius SDK** (`helius-sdk`) | latest (check npm) | Transaction parsing, `getTransactionsForAddress` (gTFA), enhanced transaction API | Purpose-built for Solana wallet history. `gTFA` is 2–10x faster than `getSignaturesForAddress + getTransaction` loop. Free tier exists; paid plans 100 credits per `gTFA` call. Helius's 100+ parsers handle Jupiter, Raydium, Orca, pump.fun — exactly what Matt's Phantom/Solflare wallets will contain. |
| **viem** | 2.21+ | Ethereum client (Wallet/Public clients, ABI-typed reads) | 35kb, tree-shakable, TypeScript-native with ABI inference. For a new Ethereum project in 2026, viem is the default over ethers.js. Ethers.js is fine but bigger + less type-safe. |
| **Alchemy SDK** (`alchemy-sdk`) | 3.5+ | Enriched Ethereum wallet history (transfers, token events, decoded logs) | Raw `eth_getLogs` is painful. Alchemy's `getAssetTransfers` returns decoded ERC-20/ERC-721 transfers across EOA + contract wallets. Free tier is generous for a solo bot at $10 scale. |
| **Etherscan API** | V2 | Fallback for internal txs, contract ABIs, gas metrics | Alchemy covers 90%; Etherscan for the 10% edge cases (contract verification status, gas usage per tx). Free key supports 5 req/sec. |
### ML Pipeline (Python-only, quarantined)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **xgboost** | 2.1+ | Gradient-boosted classifier/regressor | Primary signal model. Target variable: "was next N-minute move > threshold in direction X". CPU-only. |
| **lightgbm** | 4.5+ | Alternative GBT | Ensemble partner; faster on sparse features (one-hot encoded news tokens). |
| **pandas** | 2.2+ | Feature engineering on trade + candle data | Standard. |
| **polars** | 1.x | Alternative to pandas, faster for larger windows | Use if pandas gets slow on >6 months of minute candles. |
| **scikit-learn** | 1.5+ | Preprocessing (StandardScaler, train_test_split), baseline models | Even if XGB wins, keep a LogisticRegression baseline — if XGB underperforms logreg, something is broken. |
| **ta-lib** (Python binding) or **pandas-ta** 0.3.14b+ | current | EMA/RSI/ATR/ADX/MACD computation offline | Compute once per candle batch. Cache in SQLite. (Node-side uses `technicalindicators` for live updates.) |
| **onnx** + **onnxmltools** + **skl2onnx** | latest | Export XGB/LGB models to ONNX format for Node inference | Critical bridge: Python trains, Node serves. Training pipeline outputs `.onnx` files into `models/` directory; Node loads them with `onnxruntime-node`. |
| **jupyterlab** | 4.x | EDA on Matt's trade history, leak-pattern discovery | Not a runtime dep — a development tool for the "understand Matt" phase. |
### UIs
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **grammY** | 1.30+ | Telegram bot framework | Clear 2026 winner over Telegraf for a new TypeScript project. First-class TS types (Telegraf v4's types are notoriously painful), better docs, inline-keyboard helpers are ergonomic, webhook OR long-polling both work. Matt's approval buttons become ~10 lines. |
| **Fastify** | 4.28+ / 5.x | Local web dashboard HTTP + WS server | 3x faster than Express, first-class TypeScript, schema validation built-in, excellent docs. Hono is also great but overkill for a single-user local dashboard; Fastify's Node-focus is fine here. |
| **Vite** | 5.4+ | React dev server + build for dashboard | Instant HMR. Template `npm create vite@latest` → `react-ts`. |
| **React** | 18.3+ | Dashboard UI framework | Matt's existing JS ecosystem fluency; plenty of chart/table component libraries. |
| **lightweight-charts** | 4.2+ (TradingView) | Price + PnL charts, position markers | 45kb, canvas-based, built by TradingView, designed for exactly this use case. Candlesticks + markers for Matt's actual fills. |
| **Ink** | 5.x + `@inkjs/ui` | CLI dashboard (terminal TUI) | React-in-terminal. TypeScript types shipped. Same mental model as web dashboard — much less cognitive switching than blessed/blessed-contrib (blessed-contrib last published 4 years ago — stay away). Scaffold with `npx create-ink-app --typescript`. |
### News / Fundamentals
| Library/API | Tier | Purpose | Notes |
|-------------|------|---------|-------|
| **CryptoPanic API** | Free: 50–200 req/hr | Aggregated crypto news with impact tagging | Still operational in 2026, not deprecated. Free tier ample for this bot. Use as confirmation/veto layer per project decision. |
| **CoinGecko API** | Demo (free): 30 calls/min, 10K/month | Coin prices, dev activity, social stats, trending | Demo plan requires a free account (separate from the anonymous public endpoint which is 5–15 req/min). Paid plans start $129/month — not needed at v1. |
| **X/Twitter** | — | KOL monitoring | **Warning**: X API v2 Basic tier is $200/mo with heavy restrictions. Cheaper alternatives: `x-scrape` community libraries (terms of service risk), or pay for [tweetcatcher.xyz](https://tweetcatcher.xyz) / similar. For v1, consider deferring X integration — use CryptoPanic for social-trending signal proxy. Flag this as a phase-2 problem. |
| **Etherscan API + Solscan API + Helius** | Free tiers | On-chain signal (exchange flows, whale wallet moves) | Use Helius for Solana whale tracking (built-in DAS-style queries), Etherscan for Ethereum. |
| **axios** 1.7+ or native `fetch` | — | HTTP client for all external APIs | Native fetch in Node 22+ is fine; use axios if you want automatic retry interceptors without writing them. |
| **p-queue** | 8.x | Rate-limit rolling window across multiple external APIs | Trivial to configure per-API concurrency + interval; essential when CoinGecko Demo caps at 30/min. |
### State, Queues, Secrets, Deployment
| Layer | Technology | Version | Notes |
|-------|------------|---------|-------|
| Queue | **BullMQ** | 5.x | Delayed jobs (order-approval timeout), repeatable jobs (signal regeneration every N minutes), retries with backoff. TypeScript-native successor to Bull. Uses ioredis internally. Active development, Redis-based. |
| Persistence | **better-sqlite3** | 11.7+ | Trade ledger, signal history, leak reports. Synchronous = deterministic write order. |
| Secrets | **@zowe/secrets-for-zowe-sdk** | 9.x | **Replacement for deprecated keytar**. node-keytar was archived Dec 2022 and is unmaintained — using it in 2026 is a known-broken-any-day risk. Zowe Secrets is the explicit keytar drop-in with ongoing maintenance from IBM/Zowe team. On Windows it uses the Windows Credential Manager (wincred) via native binding. |
| Logging | **pino** | 9.5+ | Structured JSON logs, ~5x faster than winston, Fastify uses it natively. Pipe to pino-pretty locally; ship raw JSON on VPS for grep-ability. |
| Env config | **dotenv** 16.x + **@t3-oss/env-core** 0.11+ | — | Zod-validated environment variable parsing. Catches `MEXC_API_KEY` missing at startup not at first order. |
| Process mgmt (Windows) | **PM2** 5.4+ with **pm2-windows-service** | — | PM2 is stable on Windows but doesn't self-daemonize there — `pm2-windows-service` installs it as a true Windows Service that survives logout and reboot. |
| Process mgmt (Hostinger VPS) | **PM2** 5.4+ with **systemd** | — | `pm2 startup systemd` generates the unit file. Standard Ubuntu 24.04 LTS setup. Log rotation via `pm2-logrotate`. |
| Deployment target (VPS) | **Ubuntu 24.04 LTS** on Hostinger KVM | — | Hostinger's basic KVM 1 (1 vCPU, 4GB RAM) is enough for bot + Redis + SQLite. Node 22 from NodeSource apt. Redis 7 from default apt. UFW + SSH keys + fail2ban. |
| Time sync | **NTP** (w32tm on Windows, chrony on Ubuntu) | — | MEXC `recvWindow` rejects requests where local time drifts > 5s from server time. Clock skew is the #1 most confusing bug on Windows laptops that sleep. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| **pnpm** | Package manager | Fastest, smallest disk usage, workspaces for `apps/bot`, `apps/web-dashboard`, `apps/cli`, `packages/shared`. Monorepo from day 1 avoids later migration. |
| **tsx** 4.19+ | Dev runner for TypeScript | Replaces `ts-node` (unmaintained for ESM). Native ESM support. |
| **tsup** 8.3+ | Zero-config TypeScript bundler | Compile bot + CLI to single-file JS for VPS deployment. |
| **vitest** 2.1+ | Testing framework | TS-native, Jest-compatible API, fast. |
| **biome** 1.9+ | Lint + format (replaces ESLint + Prettier) | Single tool, Rust-fast. Biggest productivity win of 2026. |
| **lefthook** or **husky** + **lint-staged** | Git hooks | Run biome check + vitest on pre-commit; prevent committing broken code on a live trading bot. |
## Installation
# Initialize (pnpm + monorepo)
# Core runtime
# MEXC + exchange
# (ccxt covers spot + swap; ws installed as fallback for raw futures WS)
# Redis, queues, storage
# On-chain
# ML inference (Node-side; training is Python-side in separate folder)
# Technical indicators (live updates in Node; offline batch uses Python pandas-ta)
# Telegram
# Web dashboard
# (in apps/web-dashboard) - Vite + React setup
# CLI dashboard
# Secrets (Windows Credential Manager / macOS Keychain / libsecret on Linux)
# News / APIs (no SDK needed — plain HTTP with p-queue rate limiting)
# Process manager (install globally on production machines)
# On Windows, additionally:
### Python side (separate `ml/` directory, separate venv)
# Windows: ml\.venv\Scripts\activate  |  Linux/Mac: source ml/.venv/bin/activate
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **CCXT** | Direct `axios` + `node:crypto` against MEXC REST | Use for endpoints CCXT doesn't unify, or if you hit a CCXT bug on an endpoint mid-ship. Native calls let you implement exactly what the MEXC docs specify — no abstraction bugs. Kept as escape hatch, not the primary. |
| **CCXT** | `mexc-api-sdk` (official) or forks (`@theothergothamdev/mexc-sdk`, `@max89701/mexc-futures-sdk`) | **Almost never.** Official SDK is abandoned (signature bugs, 2-year gaps between releases, open issues from late 2025 unresolved). Forks are unofficial and don't guarantee ongoing maintenance. Only useful as reference for tricky signature quirks. |
| **ioredis** | **node-redis** v4+ | If you want the officially-maintained-by-Redis-Inc client. Both are fine. Chose ioredis because BullMQ uses it natively. |
| **Fastify** | Hono | If you plan to deploy on Cloudflare Workers / Bun / edge later. Not the case here (local + Ubuntu VPS). |
| **Fastify** | Express | Never for new code. 3x slower, TS support is community-maintained, API is showing its age. |
| **grammY** | Telegraf | If you already have a Telegraf codebase. For greenfield, grammY's TS story wins decisively. |
| **Telegraf** | node-telegram-bot-api | Never. `node-telegram-bot-api` has callback-style API and flaky maintenance. |
| **@solana/kit** | `@solana/web3.js` v1 | Only if you're using Anchor's older client patterns. For wallet history parsing, kit (v2) is strictly better. |
| **viem** | ethers.js v6 | If you need a huge battle-tested ecosystem or you're integrating code that already uses ethers. For greenfield 2026 TS, viem. |
| **better-sqlite3** | DuckDB (duckdb-async) | If analytics queries over 12+ months of data get slow. DuckDB is an analytical DB, SQLite is transactional — different tools. Start with SQLite. |
| **better-sqlite3** | LibSQL / Turso | If you want multi-region replication. Not needed at $10 scale, solo-user bot. |
| **XGBoost + LightGBM** | CatBoost | CatBoost is great with categorical features. For this project's numeric-heavy features (prices, volumes, indicators), XGB+LGB suffices. |
| **ONNX Runtime** | `xgboost-node` (unofficial direct binding) | ONNX is the multi-library abstraction — if you later want to run a LightGBM model or even a small NN, no code changes in Node. xgboost-node locks you to XGB. |
| **Helius** | QuickNode for Solana | QN is solid alternative; Helius's transaction parser is the killer feature here (Matt's Phantom wallet will be full of Jupiter/Raydium/pump swaps that need human-readable decoding). |
| **Alchemy** | Moralis / Bitquery | Moralis is also good for wallet APIs. Alchemy's Node SDK + larger free tier swing it for a solo-dev prototype. |
| **Ink** (React TUI) | blessed / blessed-contrib | blessed-contrib was last published 4 years ago. Ink is actively maintained and mental-models cleanly with React dashboard. |
| **pnpm** | npm | npm works; pnpm's disk savings + workspace ergonomics matter once you have 3 packages. |
| **tsx** | `ts-node` / `nodemon` + `ts-node` | ts-node's ESM story is broken; tsx is the 2026 default. |
| **biome** | ESLint + Prettier | ESLint+Prettier still works but is 10x slower + double config surface. Biome is now stable. |
| **@zowe/secrets-for-zowe-sdk** | keytar | keytar is archived and deprecated. Do not use. |
| **@zowe/secrets-for-zowe-sdk** | PowerShell bridge (`Get-Credential` via `child_process`) | Works, but adds PS dependency on Windows and breaks on Linux. Zowe Secrets is cross-platform (Credential Manager on Win, Keychain on macOS, libsecret on Linux). |
| **PM2** | Oxmgr (Rust PM2 alternative, 2026-new) | Oxmgr is promising but new. PM2 is boring and battle-tested. Stick with boring for a live-money bot. |
| **PM2** | systemd-only (no PM2) | Valid on Linux. But loses clustering, log rotation, and `pm2 list`/`pm2 logs` ergonomics. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `mexc-api-sdk` (official) as primary dep | Unmaintained ~2 years; open signature bugs (#87 invalid signature 700002, #112, etc.); breaks on newer Node versions | CCXT |
| `@theothergothamdev/mexc-sdk` as primary dep | Community fork, no SLA, could vanish | CCXT; consult source only for reference |
| `oboshto/mexc-futures-sdk` (browser-session-token-based) | **Explicitly reverse-engineered via browser session tokens and "bypasses maintenance mode"** — this is tacitly against MEXC ToS and will get your account banned | Official futures API (now public since Mar 31, 2026) via CCXT |
| `vecful/mexc-futures-api` ("Bypass, Multi-Account & Custom Bots") | Same reason — bypass-style client | Official futures API via CCXT |
| `keytar` (atom/node-keytar) | Archived Dec 2022, unmaintained, will break on new Node versions | `@zowe/secrets-for-zowe-sdk` |
| `blessed-contrib` | Last published 4 years ago | Ink + `@inkjs/ui` |
| `ts-node` as dev runner | Broken ESM, slow, unmaintained for modern patterns | `tsx` |
| `Express` for new servers | Slower, weaker TS, older paradigm | Fastify |
| `Telegraf` for new bots | Hard-to-use TypeScript types, less-good docs than grammY | grammY |
| `mongoose` / MongoDB for ledger | ACID matters for money; MongoDB adds ops burden for zero benefit at this scale | better-sqlite3 |
| `node-redis` v3 (callback style) | Deprecated; use v4+ promise API or ioredis | ioredis |
| `ethers.js` v5 | End-of-life; use v6 or viem | viem (preferred for new) |
| `@solana/web3.js` v1 as primary | In maintenance mode | `@solana/kit` (the renamed v2) |
| `bull` (original, not BullMQ) | EOL 2026 — explicit end of life | BullMQ |
| Using `pm2 resurrect` on Windows without `pm2-windows-service` | Won't survive reboots | `pm2-windows-service` or NSSM |
| Running Python ML in the same process as the Node bot | `child_process` bridges are fragile, data-copying is slow, one crash kills both | Python writes ONNX models to disk; Node loads them with onnxruntime-node. Zero runtime coupling. |
| `dotenv` without schema validation | Missing env var at 3am = missing API key at the worst moment | `@t3-oss/env-core` wrapper around Zod |
| `npm install -g ts-node nodemon pm2` as setup | Global installs rot; pin versions in workspace | Use `pnpm dlx` for one-offs; pin `pm2` version in project root |
| Storing API keys in `.env` committed to git | Obvious, but: MEXC keys stolen → drained account | Windows Credential Manager via Zowe Secrets SDK for real keys; `.env` only for non-secret config |
## Stack Patterns by Variant
### If running ONLY on Windows (primary machine, no VPS yet):
- PM2 + pm2-windows-service
- Redis via Memurai (native Windows Redis successor, free tier) OR WSL2 Redis
- Windows Credential Manager via Zowe Secrets
- No changes to rest of stack — all Node/Python packages run on Windows x64 fine
### If running ONLY on Hostinger VPS (failover active):
- Ubuntu 24.04 LTS KVM
- Redis from apt (`redis-server` 7.x)
- PM2 + systemd startup
- libsecret via Zowe Secrets (NOT the Windows path) — or simply use a `.env` file with 0600 perms on the VPS if libsecret isn't worth the daemon overhead (acceptable because the VPS is single-tenant)
- `ufw allow 22`, deny everything else; bind dashboard to `127.0.0.1` only and SSH-tunnel for access
### If running BOTH (recommended — Windows active, VPS failover):
- Both run the same bot binary
- **Only one writes orders at a time** — use a Redis lease (`SET leader:active <hostname> EX 60 NX`) that each instance renews every 20s. Lost lease → instance goes read-only. This prevents double-firing orders when the laptop wakes up.
- Shared signal state via Redis replication OR a nightly `pg_dump`-style SQLite sync OR both pointing at a single Upstash Redis / Hostinger-hosted Redis. Simplest: run Redis on VPS only, tunnel from Windows.
- Telegram bot should use **webhook**, not long-polling, so only the VPS holds the bot token (no duplicate message delivery).
### If v1 weekend target slips and you need to cut:
- Cut the **web dashboard** first (Fastify + Vite + React + lightweight-charts) — biggest surface area
- Keep: CCXT + bot core + Redis + BullMQ + Telegram (grammY) + CLI (Ink) + Python ML
- Telegram alone can deliver v1 value: alert, approve, fire. The web dashboard is for deep-dive reviews that can happen in iteration 2.
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `ccxt` 4.5.x | Node 18+ (22 recommended) | Node 16 deprecated in CCXT recent releases |
| `better-sqlite3` 11.x | Node 20+, requires Python + build tools on install for native compilation; **provides prebuilt binaries for Windows x64, Linux x64, macOS** — Windows users should not need Visual Studio unless on arm64 |
| `onnxruntime-node` 1.22 | Node 16+ (20+ recommended). Prebuilt CPU binaries for Windows x64, Linux x64, macOS x64+arm64. Linux arm64 (Hostinger VPS on ARM) — verify prebuilt exists before choosing VPS arch |
| `@zowe/secrets-for-zowe-sdk` | Node 18+. Native addon built per-platform; binary install should succeed automatically on Windows 11 + Ubuntu 24.04 |
| `grammY` 1.30+ | Node 18+, TypeScript 4.7+ |
| `BullMQ` 5.x | ioredis 5+; requires Redis 6.2+ (use Redis 7) |
| `@solana/kit` 2.x | Node 20+ (uses native WebCrypto) |
| `viem` 2.x | Node 18+ (native fetch), TypeScript 5.0.4+ for full type inference |
| `lightweight-charts` 4.x | Modern browser; if using in Vite, the package is ESM-first |
| `pnpm` workspaces | Node 18+; use `.npmrc` with `link-workspace-packages=true` for monorepo |
## MEXC-Specific Gotchas (Critical)
## CCXT vs Native MEXC: The Definitive Tradeoff
| Axis | CCXT | Native (`node:crypto` + fetch) |
|------|------|-------------------------------|
| Coverage | Spot + Swap unified under one API shape | Only what you implement |
| Type safety | Loose on exchange-specific fields (CCXT normalizes to unified schema, losing MEXC-specific fields) | You own the types (bind exact MEXC response schema with Zod) |
| Keeping up with MEXC API changes | Volunteer-maintained but actively updated (daily) | You update manually |
| Bug blast radius | A CCXT regression affects you | Only your bugs affect you |
| Signature correctness | Handled | Your responsibility (get it wrong = no orders fire) |
| New MEXC endpoints (e.g., futures launch Mar 2026) | Usually added within weeks | You can implement same-day |
| Dependency weight | Large (supports 100+ exchanges) | Minimal |
## Windows Credential Manager Integration
## Hostinger VPS Specifics
- **Plan**: Cheapest KVM VPS plan (KVM 1 or KVM 2) — 1 vCPU, 4GB RAM plenty for bot + Redis + SQLite.
- **OS**: Ubuntu 24.04 LTS (LTS until 2029). Debian 12 works too.
- **Install order**:
- **Backup**: Snapshot weekly. SQLite ledger rsynced to Windows machine daily (cron + ssh).
- **Monitoring**: `pm2 monit` for process; `pm2 logs` for tails. If you want more: Grafana Cloud free tier + `pm2-grafana-beacon`, but not needed at v1.
- **Dashboard access from outside**: **Do not expose dashboard publicly.** Bind Fastify to `127.0.0.1:3000`, SSH-tunnel to it: `ssh -L 3000:localhost:3000 user@vps-ip`. Alternatively, use Tailscale — the VPS and Windows laptop both join the tailnet, dashboard is reachable at the VPS's magic DNS name only from Matt's machines.
- **Time sync**: `apt install chrony && systemctl enable --now chrony` — mandatory for MEXC `recvWindow`.
## Sources
- [MEXC: Introducing API Futures Trading on Mar 31, 2026](https://www.mexc.com/announcements/article/introducing-api-futures-trading-on-mar-31-2026-17827791534551) — HIGH: official announcement, retail API futures launch
- [MEXC API v3 Spot - General Info](https://www.mexc.com/api-docs/spot-v3/general-info) — HIGH: official spot auth + rate limits
- [MEXC API - Futures Integration Guide](https://www.mexc.com/api-docs/futures/integration-guide) — HIGH: official futures auth
- [MEXC Contract API v1 docs (legacy GitHub Pages)](https://mexcdevelop.github.io/apidocs/contract_v1_en/) — HIGH (but verify against current www.mexc.com docs)
- [MEXC Spot Order Rate Limit Adjustment (Mar 25, 2025)](https://www.mexc.com/announcements/article/mexc-to-adjust-api-spot-order-rate-limit-effective-mar-25-2025-17827791522801) — HIGH: current rate limit numbers
- [CCXT on npm](https://www.npmjs.com/package/ccxt) — HIGH: 4.5.48 current as of research date
- [CCXT MEXC docs](https://docs.ccxt.com/exchanges/mexc) — HIGH: unified client reference
- [mexc-api-sdk on GitHub](https://github.com/mexcdevelop/mexc-api-sdk) — HIGH (for abandonment evidence): open issues through Dec 2025 unresolved, 1.0.3 latest
- [ccxt issue #18281 - Slow orderbook WS on MEXC](https://github.com/ccxt/ccxt/issues/18281) — MEDIUM: known issue for low-volume pairs
- [ccxt issue #24970 - MEXC broker endpoint signature](https://github.com/ccxt/ccxt/issues/24970) — MEDIUM: signature gotcha reference
- [Node.js 22 LTS support schedule](https://nodejs.org/en/about/previous-releases) — HIGH: v22 LTS through Apr 2027
- [onnxruntime-node on npm](https://www.npmjs.com/package/onnxruntime-node) — HIGH: CPU inference verified cross-platform
- [@solana/kit (formerly web3.js v2) blog](https://blog.triton.one/intro-to-the-new-solana-kit-formerly-web3-js-2/) — HIGH: renaming + migration path
- [Helius getTransactionsForAddress](https://www.helius.dev/blog/introducing-gettransactionsforaddress) — HIGH: gTFA 2-10x faster
- [viem docs](https://viem.sh/docs/introduction) — HIGH: modern Ethereum TS client
- [grammY comparison vs Telegraf](https://grammy.dev/resources/comparison) — HIGH: documentation + TS story
- [BullMQ docs](https://docs.bullmq.io) — HIGH: TS-native, Redis-based, Bull EOL 2026
- [better-sqlite3 on GitHub](https://github.com/WiseLibs/better-sqlite3) — HIGH: fastest Node SQLite
- [@zowe/secrets-for-zowe-sdk](https://medium.com/zowe/secrets-for-zowe-sdk-d8f6a485c7ae) — HIGH: explicit keytar drop-in replacement
- [keytar archived Dec 2022](https://github.com/atom/node-keytar) — HIGH: deprecation confirmed
- [CryptoPanic API plans](https://cryptopanic.com/developers/api/plans) — MEDIUM: free tier operational in 2026
- [CoinGecko API pricing](https://www.coingecko.com/en/api/pricing) — HIGH: Demo plan 30 req/min, 10K/month
- [TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/docs) — HIGH: 45kb canvas financial charts
- [Ink (React for terminals)](https://github.com/vadimdemedes/ink) — HIGH: active, TS types shipped
- [PM2 Windows Service guide](https://medium.com/@gzthomasliang/run-pm2-as-service-on-windows-server-in-modern-way-286b9f4b8228) — MEDIUM: Windows PM2 deployment pattern
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
