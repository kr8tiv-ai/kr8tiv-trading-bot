# kr8tiv-trading-bot

> Personal trading **copilot** for BTC, ETH, and SOL on MEXC — learns from Matt's own 60-day trade history, detects his behavioral leaks, suggests entries/exits aligned with his style but corrected for recurring mistakes. Runs on a local CPU-only ML model. Every order passes through a Telegram approval tap.

**Status:** Phase 1 (Foundation) planned, ready to execute. Weekend v1 target.
**Core Value:** Make Matt a better trader, not outtrade him. $10 live bankroll is the test.

---

## What this is

A **copilot, not an autopilot.** The bot ingests Matt's MEXC spot + futures history (plus Solana + Ethereum on-chain wallet activity), builds a "style fingerprint," flags behavioral leaks (revenge trading, FOMO, late exits, stop widening), and emits `{asset, side, entry, stop, target, confidence, rationale, conflicts_with_style?}` signals that Matt approves or rejects from his phone. News and fundamentals act as a veto layer — never a primary driver.

The edge is not alpha. The edge is **discipline**: making Matt 20% more disciplined compounds forever.

## Why this exists

Generic trading bots at $10 bankroll are mathematically doomed (fees + slippage eat any edge). But a copilot that surfaces *your own* leaks — with receipts from your own history — can pay for itself the first week. Existing tools (3Commas, Cornix, Coinrule, Freqtrade) compete on breadth. This project competes on **depth per user** — one user, one style, one fingerprint, one leak map.

## Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript 5.5+ strict | Node 20 EOL 2026-04-30 |
| Monorepo | pnpm workspaces + Turborepo | Fastest disk, best TS story |
| MEXC client | CCXT 4.5.48+ | Official `mexc-api-sdk` is abandoned |
| ML training | Python 3.12 + XGBoost / LightGBM (CPU-only) | Hard constraint — no GPU, no cloud inference |
| ML inference | ONNX via `onnxruntime-node` | Zero Python in the trade path |
| State | Redis 7.4+ (ioredis) + better-sqlite3 11.7+ (WAL) | Standard for money apps |
| Secrets | `@zowe/secrets-for-zowe-sdk` → Windows Credential Manager | `keytar` is archived |
| Telegram bot | grammY | Best TS story in 2026 |
| Web dashboard | Fastify + Vite + React + lightweight-charts | Local-only, never exposed |
| CLI | Ink | React-in-terminal |
| Deploy | Windows 11 primary + Hostinger VPS backup (read-only observer first) | Split-brain via single Redis lock |

Full research in [.planning/research/](.planning/research/).

## Repo layout (target — Phase 1 scaffolds this)

```
kr8tiv-trading-bot/
├── apps/
│   └── core/                # Single Node process that boots everything
├── packages/
│   ├── config/              # @t3-oss/env-core Zod env schema
│   ├── secrets/             # SecretProvider + WindowsCredentialManagerProvider
│   ├── logger/              # pino with redaction paths
│   ├── db/                  # better-sqlite3 (WAL, synchronous=FULL, foreign_keys=ON)
│   ├── redis-client/        # ioredis factory + pingOrThrow
│   ├── mexc-spot/           # MEXCSpotClient (CCXT spot, read-only Phase 1)
│   ├── mexc-futures/        # MEXCFuturesClient (CCXT swap, read-only Phase 1)
│   ├── shared-types/        # Trade, Signal, Order, Position
│   └── shared-schemas/      # Zod runtime validation
├── scripts/
│   ├── preflight-windows.ps1
│   ├── setup-credentials.ts
│   └── verify-env.ts
├── docs/
│   ├── phase-1-readiness.md
│   └── setup-windows.md
├── .planning/               # GSD workflow (PROJECT, REQUIREMENTS, ROADMAP, phases/, research/)
└── CLAUDE.md
```

## Roadmap

Ten phases, weekend MVP = phases 1–5. Full detail: [.planning/ROADMAP.md](.planning/ROADMAP.md).

| # | Phase | Scope | v |
|---|---|---|---|
| 1 | Foundation | scaffold + secrets + MEXC read (two separate CCXT clients) | v1 |
| 2 | Execution Skeleton | MEXC spot write path with safety rails + idempotency keys | v1 |
| 3 | Telegram Approval Loop | grammY bot, 90s TTL, price-drift re-check, chat-ID lock | v1 |
| 4 | Style Fingerprint + Rule Signal + First Leak | EMA/ADX signal, revenge-trade detector (EV-validated) | v1 |
| 5 | Ledger + Reconciler + First Live Trade | Append-only SQLite, boot/wake reconciler, **Core Value validator** | v1 |
| 6 | Futures Write + Full Leak Suite | USDT-M write, 7 leak detectors, weekly Telegram digest | v2 |
| 7 | News Veto + On-chain Ingest | CryptoPanic + CoinGecko veto, Solana/Ethereum wallet parsing | v2 |
| 8 | ML Signal | XGBoost/LightGBM walk-forward CV → ONNX → Node inference | v2 |
| 9 | Web + CLI Dashboards | Local-only Fastify+React + Ink | v2 |
| 10 | Hostinger VPS Failover | Read-only observer first, then distributed lock | v2 |

## Hardware

This project runs on Matt's dev box (Windows 11, AMD Ryzen 7 7445HS, 6C/12T @ 3.2GHz, 39GB RAM, RTX 4050 6GB). The GPU is **not used** — CPU-only ML is a hard constraint. XGBoost/LightGBM on 200-ish trade samples train in seconds on CPU, so this is fine. The RTX 4050 is held in reserve for possible future local LLM inference outside this bot's scope.

VPS backup: Hostinger KVM 1 (1 vCPU, 4GB RAM, Ubuntu 24.04 LTS) — read-only in Phase 10.

## Security model

- **Every secret lives in Windows Credential Manager.** No `.env` for real keys, no token in `git config`, no plaintext anywhere on disk.
- **Targets in this project:**
  - `kr8tiv-mexc-bot/mexc-spot-access` — MEXC spot API key
  - `kr8tiv-mexc-bot/mexc-spot-secret` — MEXC spot secret
  - `kr8tiv-mexc-bot/mexc-whitelist-ip` — reference IP
  - `kr8tiv-mexc-bot/github-pat` — GitHub PAT (for CI/automation)
- **MEXC keys provisioned trading-only (no withdraw) + IP-whitelisted.** FND-11 is a manual operator checklist Matt signs before Phase 5.
- **Three independent leak defenses:**
  1. `pino` redaction paths catch keys in logs
  2. `Secret<T>` branded TS type requires explicit `unsafeReveal()` — grep-discoverable
  3. `gitleaks` pre-commit hook with MEXC / Telegram / EVM / Solana key patterns blocks the commit before it's made

## Identity

Commits are authored as **Matt-Aurora-Ventures `<lucidbloks@gmail.com>`** (GitHub: https://github.com/Matt-Aurora-Ventures). No `Co-Authored-By: Claude` lines.

## Running (target after Phase 1)

```powershell
# One-time machine setup
pnpm install
pnpm preflight              # PowerShell checks: Node 22, Memurai, Windows Credential Manager
pnpm setup-credentials      # Guides Matt through WCM secret entry (or verifies existing)

# Per-session
Start-Service Memurai       # Redis on Windows
pnpm dev                    # boots apps/core — pings both MEXC endpoints, ready
```

## Related projects in this workspace

- **[kr8tiv-training](../kr8tiv-training/)** — separate project (KIN companion LoRA fine-tunes on Gemma 4 31B, GPU-based). Not ancestor code for this bot, but shares the "Python trains → export → local runtime" pattern we use for XGBoost→ONNX→Node.
- **[kr8tiv-mission-control](../kr8tiv-mission-control/)** — another GSD workflow project; reference for full-stack patterns if web dashboard (Phase 9) needs them.

## License

Private. `kr8tiv-ai` org — not for public distribution in current form.
