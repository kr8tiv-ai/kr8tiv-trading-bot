# kr8tiv-trading-bot

> A trading copilot that argues with you before you size the trade, watches you bleed at 04:00 UTC, and refuses to let you revenge-fire a 100x sniper after three losses. BTC / ETH / SOL only. MEXC futures. $10 starts. Built for Matt, by Matt (with help).

---

## TL;DR

```powershell
pnpm install
pnpm trade:app           # opens http://127.0.0.1:3020
```

That's it. The cockpit auto-scans BTC/ETH/SOL futures every 30 seconds, hands you trade plans, makes the accountability engine yell at you in pink, and journals the receipts. Live MEXC data, no creds required for the read-only product.

When you're ready to actually fire orders, follow [`docs/futures-history-ingest.md`](docs/futures-history-ingest.md) to provision creds. Until then, every "Approve" is paper-fired into a local SQLite ledger that simulates against the live mark price every 30s. **Your bankroll is safe from this bot. The bot is not safe from your bankroll.**

---

## What this thing actually is

A **copilot, not an autopilot.** It learns Matt's last ~60 days of MEXC futures trades, builds a style fingerprint, and uses it to argue with every plan he tries to save. The pitch is not "alpha." The pitch is "20% more discipline compounds forever."

If everything else fails but this one thing works — Matt sees the leak, fixes the leak, doesn't repeat the leak — the project succeeded. PnL on $10 is a side effect.

### Hard constraints (set in stone)

- **$10 live bankroll** — sizing, risk, breaker thresholds all derive from this.
- **CPU-only ML** — no GPU, no cloud inference. XGBoost → ONNX → Node. Period.
- **Semi-auto only** — bot never fires without explicit human approval.
- **MEXC only** — spot v3 (api.mexc.com) + USDT-M futures (contract.mexc.com), via CCXT.
- **Three symbols** — BTCUSDT, ETHUSDT, SOLUSDT. The cockpit refuses anything else.
- **Local-first** — Windows 11 primary, Hostinger VPS as a follower. Single Redis lease keeps them from double-firing.

---

## The cockpit (the actual product)

Run `pnpm trade:app`, open http://127.0.0.1:3020, and the page that comes up *is* the bot. Everything else in this repo is a CLI for the parts of the bot that don't fit on a screen.

### What's on the page

```
+----------------------------------------------------------------------+
|  Leak of the day - banner if you're tilting today                    |
+----------------------------------------------------------------------+
|  Plan the trade before the trade plans you.    [sniper] [med] [core] |
|                                                  telegram - leader   |
|                                                  ml - live-fire      |
+------------------------------------+---------------------------------+
|  Trade intake                       |  Recent journal                |
|  symbol/side/horizon/mode           |  TJ#7 BTCUSDT LONG 75x  OK     |
|  leverage / margin                  |  TJ#6 ETHUSDT SHORT 50x BLOCK  |
|  [Suggest size from bankroll]       |  ...                           |
|  why / accountability note          |                                |
|  [Review only] [Review+save+TG]     |                                |
|  --- live model drafts ---          |  Past-trade analysis           |
|  BTCUSDT scalp long 75x  Use this   |  +12.34 USDT - 18 closed       |
+------------------------------------+---------------------------------+
|  Live chart with your fills         |  Hour-of-day heat map          |
|  (lightweight-charts, your TJ +     |  red squares = bleed windows   |
|   paper-fire markers painted on)    |  green squares = your edge     |
+------------------------------------+---------------------------------+
|  Paper orders (live mark sim)       |  ML signal status              |
|  open: ETHUSDT short 50x  -2.10     |  ml: off (or 3 models loaded)  |
|  closed: BTCUSDT long  +5.40        |  trained 2d ago / 4d / 1d      |
+------------------------------------+---------------------------------+
```

Yes, all in one page. Yes, it auto-refreshes. No, you don't need to install React.

---

## The ten things this cockpit does that a generic bot doesn't

| # | Feature | Status | What it does |
|---|---|---|---|
| 1 | **Paper-fire ledger** | live | Approving a plan inserts a row in `paper_orders`. The simulator ticks it against the live MEXC mark every 30s and marks it `closed_target` / `closed_stop`. Realized PnL accumulates. Set `LIVE_FUTURES_FIRING=true` (Phase 6) and the same code path becomes a real order. |
| 2 | **Funding rate + open interest in scan** | live | `assessFuturesContext` pulls funding + index basis + holdVol from MEXC and feeds bias/crowding into every plan. "Crowded longs: skip the chase" appears as a strategy driver, not a vague hunch. |
| 3 | **Leak of the day** | live | One sentence at the top of the cockpit: tilt streak, bleed window, override pattern, or symbol bias. Whichever is *most* worth changing today. Hidden when nothing's wrong (which is, statistically, never). |
| 4 | **Position sizer with bankroll** | live | `Suggest size` button reads your live MEXC USDT (or a manual override), takes your stop distance, picks the leverage that puts the stop at 50% of distance to liquidation, and sizes margin so a stop-out costs exactly 0.5% of account. Caps at sniper/medium/core mode bounds. |
| 5 | **Self-backtest** | live | Replays four strategies (breakout-trailing, adaptive-grid, ema-pullback, volume-profile) against the last 320 candles per symbol and ranks them by net PnL × profit factor. The cockpit picks a winner per regime. |
| 6 | **Hour-of-day heat map** | live | A 24-cell grid per symbol, colored red/green by avg net PnL in that UTC hour. The visual answer to "when do I bleed?" |
| 7 | **Telegram approval card** | live (semi-auto) | Optional. When `TELEGRAM_CHAT_ID` + `telegram-bot-token` are set, "Review + save + Telegram" sends an Approve/Reject card to your phone. Tap → SQLite row flips → cockpit pill goes green. |
| 8 | **Lightweight-charts panel** | live | Real candlesticks (TradingView's library, 45kb, no React needed) with your journal entries + paper fills painted as markers right on the price. Switch BTC/ETH/SOL × 1m/5m/15m/1h/4h/1d. |
| 9 | **ML signal layer** | scaffold | XGBoost classifier per symbol, exported to ONNX, loaded by `onnxruntime-node` if installed. Cockpit shows "ml: off" until you `pnpm history:ingest --days 60` then `pnpm ml:train`. The model can't generalize without your trades; honesty over magic. |
| 10 | **Leader lease (multi-instance)** | live | If you run the cockpit on Windows AND on Hostinger, only the holder of `cockpit:leader` in Redis can mutate. The other instance becomes a follower and refuses fires until the lease expires. Stops the laptop and the VPS from double-firing the same plan when the laptop wakes up. |

(Yes, that's ten. The Telegram-morning-brief idea got merged into the existing approval card; same primitives, fewer surfaces.)

---

## Quickstart

```powershell
# 1. Install
pnpm install

# 2. Run it
pnpm trade:app

# 3. Open http://127.0.0.1:3020 in your browser.
# 4. Click "Scan live BTC/ETH/SOL model" (or just wait — auto-scans every 30s).
# 5. Click "Use this plan" on any model card you like.
# 6. Edit thesis + accountability note. Hit "Review + save + Telegram".
# 7. Read the verdict. If it's pink, the bot just told you something you should listen to.
# 8. Hit "Paper-fire latest approved plan" in the Paper orders panel.
# 9. Watch it close (target or stop) at the next 30-second tick.
# 10. Try not to revenge-trade.
```

Steps 9 and 10 are non-negotiable.

---

## What gets stored where

| Place | Holds |
|---|---|
| `data/core.sqlite` | Trade journal (`trade_journal`), paper orders (`paper_orders`), imported MEXC futures fills (`trades`), Phase 2 spot order ledger (`orders` / `fills` / `realized_pnl`), executor state. WAL mode, fsync per commit, foreign keys on. |
| Windows Credential Manager | `mexc-spot-access`, `mexc-spot-secret`, `mexc-futures-access`, `mexc-futures-secret`, `telegram-bot-token`, `mexc-whitelist-ip`. **Never** in files. Read via Zowe Secrets SDK with a Win32 `CredRead` fallback for cmdkey-style entries. |
| Redis (`127.0.0.1:6379`) | Hot state — executor `armed` flag, position cache, circuit breaker rollups, `cockpit:leader` lease, signal-watch event stream. Optional; the cockpit degrades cleanly if Redis is off (just no leader lease). |
| `.env.local` (gitignored) | Non-secret config — `TELEGRAM_CHAT_ID`, `LIVE_FUTURES_FIRING`, `TRADER_APP_PORT`. Anything secret goes to WCM. |
| `models/*.onnx` | XGBoost models exported by `ml/train.py`. Gitignored (binary, regenerated on demand). |

---

## Commands worth knowing

| Command | What it does |
|---|---|
| `pnpm trade:app` | The cockpit. Run this first. Run this most. |
| `pnpm signals:scan --symbols BTCUSDT,ETHUSDT,SOLUSDT` | CLI signal scanner. Same scoring as the cockpit, prints to stdout. |
| `pnpm model:scan --notional 12` | CLI accountable-trade-plan generator. |
| `pnpm signals:watch` | Long-running diff loop; publishes regime / idea / confidence events to Redis stream `signals.market-watch`. |
| `pnpm futures:status` | Read-only MEXC futures account snapshot. Needs futures creds in WCM. |
| `pnpm history:ingest --days 60` | Pulls your last 60 days of MEXC futures fills into `trades`. Needed before style conflicts and the heat map can show real data. |
| `pnpm style:fingerprint` | Recomputes per-symbol fingerprints (avg hold, win rate, preferred UTC hours). |
| `pnpm trade:review --symbol BTCUSDT --side long ...` | One-shot accountability review on the CLI. |
| `pnpm trade:journal --symbol BTCUSDT ...` | Same, but also saves to `trade_journal`. |
| `pnpm ml:train -- --symbol BTCUSDT --candles ./data/cache/btc-15m.json` | Trains an XGBoost model in `ml/.venv/` and writes `models/btcusdt-15m.onnx`. Needs ≥30 closed trades to be useful. |
| `pnpm panic` | Cancel-flatten-freeze on the spot side. EXEC-07. |
| `pnpm arm` | Re-arm the executor after a panic / cold boot. EXEC-08. |
| `pnpm reconcile` | Sync MEXC truth into Redis + SQLite state. |
| `pnpm test` | All workspace tests. |
| `pnpm typecheck` | All workspace typechecks. |

---

## API surface (cockpit endpoints)

The cockpit is just a Node `http.createServer` — no Fastify, no Express, no React. The frontend is one HTML string with vanilla JS. All endpoints accept and return JSON. No auth (binds to `127.0.0.1` only).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | The cockpit HTML page. |
| `GET` | `/api/health` | Liveness + leader status + ML status + telegram + live-fire flag. |
| `GET` | `/api/journal` | Last 50 saved trade plans with conflicts + approval state. |
| `GET` | `/api/history-analysis` | Per-symbol totals, long/short breakdown, hour-of-day expectancy, fingerprints. Powers the right rail and the heat map. |
| `GET` | `/api/account-status` | Live MEXC futures USDT balance + open BTC/ETH/SOL positions. Needs futures creds. |
| `GET` | `/api/model-scan?notional=12` | Live BTC/ETH/SOL scan, accountable plans for each idea, with style conflicts. **Also ticks paper orders against the live mark.** |
| `GET` | `/api/backtest?limit=320` | Strategy comparison across breakout/grid/ema/volume on the last N candles. |
| `GET` | `/api/strategy-effectiveness` | Memory of past backtest comparisons (rolling). |
| `GET` | `/api/grid-plan?limit=120` | Adaptive grid plan generator. |
| `GET` | `/api/grid-candidates?limit=160` | Score the symbols by grid suitability. |
| `GET` | `/api/market-context` | Funding rate + index basis + holdVol bias per symbol. |
| `GET` | `/api/setup-board` | Unified scoreboard: regime + grid + fundamentals + style. |
| `GET` | `/api/fundamentals` | News / sentiment fundamentals (CryptoPanic + CoinGecko). |
| `GET` | `/api/leak` | One leak observation, or `null` if you're behaving today. |
| `GET` | `/api/paper-orders` | Open + recent paper-fired orders + realized PnL. |
| `GET` | `/api/ml/status` | Whether ONNX models are loaded + per-symbol training metadata. |
| `GET` | `/api/candles?symbol=BTCUSDT&interval=Min15&limit=200` | Candle series + journal/paper markers for the chart panel. |
| `GET` | `/api/settings` | Capital rules (max position, max daily loss). |
| `GET` | `/api/feedback` | Recent quick-feedback events (Took / Skipped / Broke rules). |
| `POST` | `/api/review[?save=1]` | Accountability check on a plan; `save=1` writes to journal + dispatches Telegram if configured. |
| `POST` | `/api/sizer` | Suggest (margin, leverage) for a plan against a bankroll. |
| `POST` | `/api/fire` | Insert a paper order for an approved journal row. Requires leader lease (rejects 503 if follower). Will become real-fire once `LIVE_FUTURES_FIRING=true` + Phase 6 ships. |
| `POST` | `/api/paper-orders/close` | Manually close an open paper order at a chosen exit. |
| `POST` | `/api/settings` | Update capital rules. |
| `POST` | `/api/feedback` | Log a quick feedback event on a journal row. |
| `POST` | `/api/history-ingest` | Trigger `history:ingest` from inside the cockpit. |

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS + TypeScript 5.7 strict | Node 20 EOL Apr 2026. |
| Monorepo | pnpm workspaces + Turborepo | Fastest disk, best TS story. |
| MEXC client | CCXT 4.5+ | Official `mexc-api-sdk` is abandoned — open signature bugs, 2-year gaps. Don't. |
| ML training | Python 3.12 + XGBoost (CPU-only) | Hard constraint — no GPU, no cloud inference. |
| ML inference | ONNX via `onnxruntime-node` | Zero Python in the trade path. |
| State | Redis 7.4+ (ioredis) + better-sqlite3 11+ (WAL) | Standard for money apps. |
| Secrets | `@zowe/secrets-for-zowe-sdk` → Windows Credential Manager | `keytar` was archived in 2022; do not use. |
| Telegram bot | grammY | Best TS story in 2026. |
| Cockpit chart | TradingView lightweight-charts 4.2 (CDN) | 45kb, canvas, made for this. |
| HTTP | `node:http` | Fastify is great. We don't need it. |
| Testing | vitest + biome | Both Rust-fast. |
| Process mgmt | PM2 + pm2-windows-service (planned) | Boring is good for live money. |

Full stack research lives in [`.planning/research/`](.planning/research/).

---

## Repo layout

```
apps/
  core/                       # Phase 1+2 core: boot.ts, smoke.ts, place-order.ts
packages/
  accountability/             # The engine that argues with you
  config/                     # Zod-validated env (@t3-oss/env-core)
  db/                         # better-sqlite3 with WAL + FK on
  executor/                   # Spot write path, schema.sql, paper_orders
  logger/                     # pino with redaction at 3 depths
  mexc-futures/               # CCXT wrapper + fetchCandles + fetchMarketContext
  mexc-spot/                  # CCXT wrapper for spot v3, EXEC-06 chokepoint
  redis-client/               # ioredis factory + pingOrThrow
  secrets/                    # WindowsCredentialManagerProvider with cmdkey fallback
  shared-schemas/             # Zod at every MEXC response boundary
  shared-types/               # SecretName brand types
  signal-engine/              # analyzeMarket, backtest, grid, setup-board, context
  style-engine/               # FIFO long+short reconstructor + fingerprint + conflicts
  telegram-bot/               # grammY runtime (optional)
scripts/
  trader-app.ts               # The cockpit (HTTP server + HTML)
  trader-app-telegram.ts      # Cockpit <-> grammY dispatcher
  trade-history-analysis.ts   # Past-trade analyzer used by /api/history-analysis
  position-sizer.ts           # /api/sizer math
  leak-detector.ts            # /api/leak heuristics
  leader-lease.ts             # /api/health leader status
  ml-inference.ts             # ONNX load + /api/ml/status
  scan-signals.ts             # CLI scanner reused by cockpit
  ...                         # See pnpm script list above
ml/
  train.py                    # XGBoost -> ONNX scaffold
  requirements.txt            # Python 3.12 + xgboost + skl2onnx
  README.md                   # How to train without making the bot worse
docs/
  futures-history-ingest.md   # How to provision creds + ingest + smoke-test Telegram
  phase-1-readiness.md        # Phase 1 sign-off
  phase-2-readiness.md        # Phase 2 live-trade runbook
  setup-windows.md            # Reproducibility
.planning/                    # GSD planning artifacts (gitignored: scratch + local)
data/                         # SQLite + cached candles (gitignored except .gitkeep)
models/                       # ONNX artifacts (gitignored, regenerated)
```

---

## What's deliberately not here yet

These get added the day they're useful, not before:

- **Real futures firing.** The code path exists (`/api/fire` with `LIVE_FUTURES_FIRING=true`) but throws on purpose. CCXT createOrder for MEXC USDT-M plus the leverage/positionMode plumbing lands in Phase 6 with a separate live-trade runbook.
- **Web dashboard with React.** Doesn't need to. The cockpit is one HTML page and that's the feature.
- **On-chain wallet parsing.** Solana via `@solana/kit` and Ethereum via `viem`/Alchemy is in the stack research but not wired. Phase 7+.
- **News/sentiment as a primary driver.** CryptoPanic + CoinGecko are wired as a *veto layer* via `/api/fundamentals`. They never originate a signal.
- **24/7 VPS deployment.** Hostinger is in the plan; runbook drops with the leader-lease pair-test.
- **Anything that touches your bankroll without a tap.** Hard rule. Don't ask.

---

## Money flow (the real architecture)

```
       MEXC futures REST + WS                      +-- Telegram (grammY)
              |                                    |
              v                                    v
   +--------------------+                +--------------------+
   | MEXCFuturesClient  |  fetchCandles  |  Telegram dispatch |
   |  (CCXT + Zod)      |  fetchContext  |  (optional)        |
   +--------+-----------+  fetchTrades   +---------+----------+
            |                                      |
            v                                      v
   +--------------------+    accountability  +--------------------+
   | scan-signals       +-------------------> trader-app cockpit |
   |  + analyzeMarket   |   conflicts        |  HTTP + HTML       |
   |  + style fingerprint                    |  + auto-poll       |
   |  + backtest        |                    |  + lightweight-charts
   +--------+-----------+                    +--------+-----------+
            |                                         |
            v                                         v
   +--------------------+                    +--------------------+
   | Redis              |   leader lease     | SQLite (WAL)       |
   |  signal streams    |<-----------------> |  trade_journal     |
   |  cockpit:leader    |                    |  paper_orders      |
   +--------------------+                    |  trades            |
                                              |  orders / fills    |
                                              +--------------------+
```

Every cell on the right has its own tests. The boundaries are Zod-checked. The redaction paths are explicit at three depths. We did not build this casually.

---

## Identity

All commits are authored as **Matt-Aurora-Ventures** (`lucidbloks@gmail.com`) — `https://github.com/Matt-Aurora-Ventures`. No `Co-Authored-By: Claude` lines. No "Kr8tiv AI." If you fork this and your commits show up as anyone else, you broke the convention.

---

## License

Personal project. Don't trade with it unless it's your money and your fault.
