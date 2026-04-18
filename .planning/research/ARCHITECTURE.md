# Architecture Research

**Domain:** Personal semi-auto trading copilot (CEX + on-chain + local ML) on MEXC
**Researched:** 2026-04-17
**Confidence:** HIGH (core topology, Node patterns) / MEDIUM (Python↔Node interop specifics, split-brain exact mechanics)

## Standard Architecture

### System Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           USER SURFACES (thin)                             │
│                                                                            │
│   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐            │
│   │ Telegram Bot   │   │ Web Dashboard  │   │ CLI Dashboard  │            │
│   │  (telegraf)    │   │  (Fastify +    │   │   (blessed /   │            │
│   │  approve/deny  │   │   React or     │   │    Ink)        │            │
│   │  /status /panic│   │   htmx)        │   │                │            │
│   └───────┬────────┘   └───────┬────────┘   └───────┬────────┘            │
│           │ RPC calls only — no business logic here                        │
└───────────┼────────────────────┼────────────────────┼─────────────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                        CORE SERVICE (Node process)                         │
│                                                                            │
│   ┌─────────────────────────────────────────────────────────────────┐     │
│   │               API / RPC Layer (Fastify + WebSocket)              │     │
│   └─────────────────────────────────────────────────────────────────┘     │
│                                                                            │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐   │
│   │  Ingester    │→│  Analyzer    │→│  Signal Gen   │→│  News/Funda │   │
│   │ (history +   │  │ (behavioral  │  │ (ONNX        │  │  Filter     │   │
│   │  live feed)  │  │  leak detect)│  │  inference)  │  │             │   │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘   │
│          │                 │                 │                 │           │
│          ▼                 ▼                 ▼                 ▼           │
│   ┌─────────────────────────────────────────────────────────────────┐     │
│   │                    EVENT BUS (Redis Streams)                     │     │
│   │   trades.raw · features.v1 · signals.candidate · signals.filtered│     │
│   │   approvals.pending · approvals.decided · orders.executed · pnl  │     │
│   └─────────────────────────────────────────────────────────────────┘     │
│                                                                            │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐   │
│   │ Risk Manager │  │  Approval    │  │  MEXC Spot   │  │ MEXC Futures│   │
│   │ (pre-trade   │  │  Orchestrator│  │  Executor    │  │   Executor  │   │
│   │  circuit     │  │ (Telegram    │  │ api.mexc.com │  │contract.    │   │
│   │  breakers)   │  │  round-trip) │  │              │  │ mexc.com    │   │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘   │
│          │                 │                 │                 │           │
│          └─────────────────┴────────┬────────┴─────────────────┘           │
│                                     ▼                                      │
│                         ┌───────────────────────┐                          │
│                         │  Ledger (append-only) │                          │
│                         │  + Reconciler         │                          │
│                         └───────────────────────┘                          │
└───────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                             PERSISTENCE                                    │
│                                                                            │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐   │
│   │    Redis     │  │   SQLite     │  │  Flat files  │  │  Windows    │   │
│   │ (hot state + │  │   (WAL mode) │  │  /data/models│  │   Credential│   │
│   │  streams +   │  │ trades,fills │  │  /data/raw   │  │   Manager   │   │
│   │  locks)      │  │ ledger,audits│  │  /data/news  │  │   (secrets) │   │
│   └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                        PYTHON ML TRAINING (offline)                        │
│                                                                            │
│   pandas → feature engineering → XGBoost/LightGBM → onnxmltools           │
│   → export .onnx → drop in /data/models/v{N}.onnx → Node reloads          │
│                                                                            │
│   Runs on-demand (nightly cron or manual): python train.py                │
│   NEVER in critical path. Trainer is a separate process, separate repo    │
│   package (apps/trainer-py).                                              │
└───────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **Ingester** | Pull MEXC spot/futures history, live trade WS, on-chain swaps (Solana + ETH). Normalize to unified `Trade` schema. Emit to `trades.raw`. | Fastify cron + ws; node-binance-api-style MEXC wrapper; web3.js/solana-web3.js for chain reads |
| **Analyzer** | Compute behavioral fingerprint (hold time, pair prefs, time-of-day bias) + leak detection (late exits, revenge, FOMO, stop widening). Emit weekly leak report. | Pure TS compute over SQLite trades table; outputs to `analysis.fingerprint` + `analysis.leaks` streams |
| **Feature Builder** | Turn raw trades + market state + news into feature vectors for the model. EMA/RSI/ATR/ADX, funding, orderbook imbalance, sentiment scores, user-style features. | TS library; emits to `features.v1` |
| **Signal Generator** | Load ONNX model (`onnxruntime-node`), score feature vectors, emit `{asset, side, entry, stop, target, confidence, rationale, conflicts_with_style?}`. Regime detection (ADX trend/range) gates which model runs. | `onnxruntime-node` wrapping XGBoost/LightGBM exports |
| **News/Fundamentals Filter** | CryptoPanic + CoinGecko + X/KOL feed + on-chain whale flow. Veto or confirm signals. Never emits primary signals. | HTTP clients with ETag caching; scored output joins signals stream |
| **Risk Manager** | Pre-trade gate: per-asset caps, correlation drawdown kill, daily loss circuit breaker, leverage ceiling enforcement (5x BTC, 4x ETH, 3x SOL). Blocks or downsizes. | Pure function over Redis-held portfolio state; idempotent |
| **Approval Orchestrator** | Draft → Telegram inline button ping → await user → timeout handling → push decided signal to executor. Stateful per-signal with TTL. | BullMQ job with deferred completion; round-trip via Telegraf webhook/polling |
| **MEXC Spot Executor** | Place/cancel/status on `api.mexc.com`. Own HMAC signing. Own rate-limit bucket. | Custom TS client (MEXC SDKs exist but are thin); axios + hmac |
| **MEXC Futures Executor** | Place/cancel/status/leverage on `contract.mexc.com`. **Separate auth scheme** from spot. Separate rate-limit bucket. | Independent TS client; distinct HMAC flow |
| **Ledger** | Append-only record of every signal, approval, order attempt, fill, PnL delta. Source of truth for PnL. | SQLite WAL + `synchronous=FULL`; never UPDATE, only INSERT |
| **Reconciler** | On boot / on wake: diff local ledger vs exchange order history, detect missed fills, replay/cancel stale approvals, re-anchor position state. | Runs before any new order accepted; blocks executor until clean |
| **Event Bus** | Durable pub/sub between components. Redis Streams with consumer groups for at-least-once delivery. | ioredis + Redis Streams; one stream per event type |
| **Telegram Bot** | UI for approval + `/status` + `/panic`. Zero business logic — calls core RPC. | Telegraf |
| **Web Dashboard** | localhost:3000 deep-dive UI: positions, PnL chart, signal history, leak report. Read-mostly + approve button. | Fastify serving API + SPA (React or htmx); WS for live updates |
| **CLI Dashboard** | Terminal live view for ops — same backend, different renderer. | `ink` or `blessed` hitting core RPC |

## Recommended Project Structure

**Monorepo decision: pnpm workspaces + Turborepo** (not Nx, not polyrepo).

Rationale: solo dev, weekend-delivery target, no 10+ packages, no polyglot beyond one Python app. Turborepo is the "does one thing well" choice with smaller cognitive surface than Nx. Nx wins on large teams / heavy code-gen / enforced module boundaries — none of which apply here. Polyrepo is the wrong call: components share types (Trade, Signal, Order) that must stay in lockstep; polyrepo = constant version-pin hell.

```
kr8tiv-mexc-bot/
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── package.json                    # root devDeps only
│
├── apps/
│   ├── core/                       # THE trading service (one Node process)
│   │   ├── src/
│   │   │   ├── index.ts            # bootstrap: loads config, inits bus, starts supervisor
│   │   │   ├── config.ts           # env + Windows Credential Manager load
│   │   │   ├── supervisor.ts       # wires all services, handles graceful shutdown
│   │   │   ├── api/                # Fastify HTTP + WS for the three UIs
│   │   │   │   ├── server.ts
│   │   │   │   ├── routes/
│   │   │   │   └── ws.ts
│   │   │   ├── ingesters/          # mexc-history, mexc-live, solana, ethereum
│   │   │   ├── analyzer/           # fingerprint + leak detection
│   │   │   ├── features/           # feature engineering for ML input
│   │   │   ├── signals/            # ONNX inference runner + regime detection
│   │   │   ├── news/               # cryptopanic, coingecko, x, onchain-flow
│   │   │   ├── risk/               # pre-trade gate, circuit breakers
│   │   │   ├── approval/           # telegram round-trip orchestrator
│   │   │   ├── executors/
│   │   │   │   ├── mexc-spot/      # api.mexc.com client + order state
│   │   │   │   └── mexc-futures/   # contract.mexc.com client + order state
│   │   │   ├── ledger/             # append-only SQLite writer
│   │   │   ├── reconciler/         # boot/wake state repair
│   │   │   ├── bus/                # Redis Streams wrapper (typed events)
│   │   │   └── lifecycle/          # sleep/wake detection, heartbeat, leader lock
│   │   └── package.json
│   │
│   ├── telegram/                   # standalone Telegram bot process
│   │   ├── src/index.ts            # telegraf bot; calls core over HTTP/WS
│   │   └── package.json
│   │
│   ├── web/                        # Vite + React SPA OR server-rendered via core
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── cli/                        # terminal dashboard
│   │   ├── src/index.ts            # ink/blessed app
│   │   └── package.json
│   │
│   └── trainer-py/                 # THE ONLY Python code
│       ├── pyproject.toml
│       ├── train.py                # load SQLite trades → features → XGBoost/LGBM → ONNX export
│       ├── features.py             # MUST mirror packages/features semantics exactly
│       └── README.md               # "how to retrain"
│
├── packages/
│   ├── shared-types/               # Trade, Signal, Order, Fill, Approval, Event DTOs
│   ├── shared-schemas/             # Zod schemas matching shared-types (runtime validation)
│   ├── bus-events/                 # strongly-typed event names + payloads (both sides share)
│   ├── mexc-client/                # thin wrappers, spot + futures, signing helpers
│   ├── credential-manager/         # wincred wrapper (falls back to .env on VPS/Linux)
│   └── test-fixtures/              # sample trades, sample signals, replayable streams
│
├── data/                           # git-ignored runtime state
│   ├── core.sqlite                 # WAL mode, synchronous=FULL
│   ├── core.sqlite-wal
│   ├── models/                     # v1.onnx, v2.onnx, model-card.json
│   ├── raw/                        # dumps of news/onchain pulls (audit)
│   └── logs/
│
├── scripts/
│   ├── bootstrap-db.ts             # create schema
│   ├── seed-history.ts             # pull 60d from MEXC + chains into SQLite
│   └── export-onnx.sh              # wrapper that calls trainer-py
│
└── .planning/                      # gsd docs
```

### Structure Rationale

- **`apps/core` is one Node process, not microservices.** At $10 bankroll and one user, cross-process chatter is pure overhead. Internal components are *logical* services wired through a Redis Streams bus inside a single process. Migration to multiple processes later is cheap because of the bus abstraction.
- **`apps/telegram`, `apps/web`, `apps/cli` are thin clients.** They call `apps/core` over HTTP/WS. No business logic duplicated. Kill any of the three without affecting trading.
- **`apps/trainer-py` is offline-only.** Never reached at trade time. Communicates via filesystem (ONNX file) + SQLite read. No HTTP coupling.
- **`packages/shared-types` is the most important package.** Every service imports `Trade`, `Signal`, `Order` from here. A breaking type change is immediately visible across all three UIs + executor.
- **`packages/bus-events` encodes the event contracts.** One source of truth for "what goes on `signals.candidate`."
- **`packages/mexc-client`** isolated so the two API bases (spot vs futures) are first-class citizens, not siblings buried in executor code.
- **`data/` lives outside `src/`** so it's trivially backed up, synced to VPS, excluded from builds.

## Architectural Patterns

### Pattern 1: Event Bus as Internal Spine (Redis Streams)

**What:** All inter-component traffic inside `apps/core` flows through Redis Streams with consumer groups. Components don't call each other directly.

**When to use:** Always, for any flow involving >2 components or any async boundary. Skip it for pure functions (risk gate is just a function call).

**Trade-offs:**
- Pros: At-least-once delivery survives crash/sleep; full replay for debugging; trivial to split into separate processes later; natural seam for the reconciler.
- Cons: Every event needs a schema; adds Redis as hard dependency (acceptable — it's already required for state).

**Example:**
```typescript
// packages/bus-events/src/index.ts
export const EVENTS = {
  TRADES_RAW:          'trades.raw',
  FEATURES_V1:         'features.v1',
  SIGNALS_CANDIDATE:   'signals.candidate',
  SIGNALS_FILTERED:    'signals.filtered',
  APPROVALS_PENDING:   'approvals.pending',
  APPROVALS_DECIDED:   'approvals.decided',
  ORDERS_EXECUTED:     'orders.executed',
  PNL_DELTA:           'pnl.delta',
} as const;

// apps/core/src/bus/publisher.ts
await bus.publish(EVENTS.SIGNALS_CANDIDATE, {
  id: ulid(),
  asset: 'BTCUSDT',
  side: 'long',
  entry: 63250.5,
  stop: 62800,
  target: 64100,
  confidence: 0.71,
  rationale: 'EMA20>EMA50 + funding flip + no news veto',
  conflictsWithStyle: false,
  modelVersion: 'v3',
  emittedAt: Date.now(),
});
```

### Pattern 2: Append-Only Ledger as Source of Truth

**What:** Every state change (signal emitted, approval requested, approval received, order submitted, fill received, PnL changed) is a row in `ledger` — never UPDATEd, only INSERTed. Current state is derived via materialized views or in-memory projections.

**When to use:** For anything with money or audit implications. Non-auditable state (e.g., "last UI refresh time") can stay in Redis.

**Trade-offs:**
- Pros: Perfect audit trail for post-mortem on bad trades; crash recovery is "replay from last checkpoint"; matches MEXC's own order-history semantics so reconciliation is natural.
- Cons: Requires projections to answer "what's my current position?"; disk grows.

**Example:**
```sql
CREATE TABLE ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- SIGNAL | APPROVAL | ORDER_SUBMIT | FILL | PNL | RECONCILE
  id TEXT NOT NULL,                 -- ULID; groups related rows
  venue TEXT,                       -- mexc-spot | mexc-futures | null
  payload_json TEXT NOT NULL,
  prev_seq INTEGER                  -- link for chains (signal→approval→order→fill)
);
CREATE INDEX idx_ledger_id ON ledger(id);
CREATE INDEX idx_ledger_kind_ts ON ledger(kind, ts_ms);
-- PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
```

### Pattern 3: Python-Trained, Node-Inferred via ONNX Handoff

**What:** Python does everything training-related (pandas/numpy/XGBoost/LightGBM). Export to ONNX via `onnxmltools`. Node loads `.onnx` via `onnxruntime-node` at runtime. **Zero Python in the trade path.**

**When to use:** Any ML model. Trainer can iterate freely on Python; runtime stays pure Node.

**Trade-offs:**
- Pros: No Python process management at runtime; no IPC between languages; model swap = file drop + reload; CPU-only is fine (ONNX Runtime's CPU path is fast for tree models).
- Cons: Feature engineering must be duplicated (once in Python for training, once in TS for inference). Mitigation: shared feature contract + golden-value regression tests.
- Gotcha: Historical benchmarks note ONNX batch inference can be slower than native XGBoost for bulk backtests. Fine for per-signal inference (single row); matters if you add batch backtesting later.

**Example:**
```python
# apps/trainer-py/train.py
import xgboost as xgb
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType

model = xgb.train(params, dtrain, num_boost_round=200)
onnx_model = convert_xgboost(
    model,
    initial_types=[('input', FloatTensorType([None, n_features]))]
)
with open('../../data/models/v3.onnx', 'wb') as f:
    f.write(onnx_model.SerializeToString())
```

```typescript
// apps/core/src/signals/inference.ts
import * as ort from 'onnxruntime-node';
const session = await ort.InferenceSession.create('./data/models/v3.onnx');
const input = new ort.Tensor('float32', features, [1, n]);
const { label, probabilities } = await session.run({ input });
```

### Pattern 4: Approval Orchestrator as Deferred Job

**What:** When a signal passes the risk gate, enqueue a BullMQ "approval" job with a user-visible TTL (e.g., 5 min). Telegram message is sent; inline buttons mutate the job; timeout auto-rejects. Executor subscribes only to *decided* approvals, never to raw signals.

**When to use:** Whenever a human is in the loop with a deadline.

**Trade-offs:**
- Pros: TTL semantics come free; retry/dead-letter queue free; survives restart; a Telegram webhook landing during sleep is just a queued update.
- Cons: Another moving piece. Can be replaced with a custom Redis key with `EXPIRE` + pub/sub — but BullMQ's observability is worth the weight.

### Pattern 5: Leaderless-Plus-Lock for Primary+VPS (NOT Redis Sentinel)

**What:** Not "active-active with quorum." Not "Sentinel-managed master." Instead: one shared Redis (on VPS) holds a distributed lock `core.leader`. Both Windows core and VPS core run, but only the lock-holder executes orders. Non-holder is warm standby that reads streams for analysis but refuses to call any executor.

**When to use:** Two-node deployment with no third arbiter. Sentinel's quorum model needs 3+ nodes to be safe; with 2 nodes you either get split-brain risk (quorum=1) or no failover (quorum=2).

**Trade-offs:**
- Pros: No split-brain because the lock is a single-writer resource; if shared Redis is down, *neither* instance trades (safe default — better to miss trades than double-fire); failover = VPS acquires lock when Windows heartbeat stops.
- Cons: Requires the shared Redis to be reliable (single point of failure — but a shared dependency is unavoidable with two nodes); small failover gap (~30-60s lock TTL).
- Gotcha: The lock MUST be renewed frequently (every 10s with a 30s TTL); if Windows goes to sleep the lock must expire so VPS can grab it. Laptop sleep = intentional "soft failover" event.

See **Deployment Topology** below for the full dance.

## Data Flow

### Full Pipeline (happy path)

```
[MEXC live WS]     [Solana/ETH chain]     [CryptoPanic/CoinGecko/X]
      │                    │                         │
      ▼                    ▼                         ▼
┌───────────────────────────────────────────────────────────────┐
│  Ingester                                                      │
│  normalize → Trade{ts,pair,side,qty,price,fee,venue,pnl}       │
└──────────┬────────────────────────────────────────────────────┘
           │ publish trades.raw
           ▼
       [Redis Streams]
           │
           ├──→ Analyzer (writes analysis.fingerprint + analysis.leaks)
           │     └──→ stored in SQLite; weekly leak report rendered
           │
           └──→ Feature Builder
                 │ publish features.v1 (1 row per candle close, per asset)
                 ▼
              Signal Generator (ONNX inference)
                 │ regime gate (ADX) picks trend-model or range-model
                 │ publish signals.candidate
                 ▼
              News/Fundamentals Filter
                 │ join sentiment + whale flow + upcoming events
                 │ publish signals.filtered  (or drop if vetoed)
                 ▼
              Risk Manager (synchronous function, not a subscriber)
                 │ check caps, daily loss, leverage ceiling, correlation
                 │ mutate size (0 = kill) → publish approvals.pending
                 ▼
              Approval Orchestrator
                 │ Telegram send with inline buttons
                 │ await tap OR timeout
                 │ publish approvals.decided{approved|rejected|timeout}
                 ▼
              Executor (spot or futures — router picks)
                 │ place order on MEXC
                 │ publish orders.executed (with exchange order-id)
                 ▼
              Fill Listener (WS on private channel)
                 │ match fills to ledger row
                 │ publish pnl.delta
                 ▼
              Ledger writer → SQLite INSERT → UI live-updates via WS
```

### State Management

```
┌─────────────────────────────────────────────────────────────┐
│                    SOURCE-OF-TRUTH MAP                       │
├─────────────────────────────────────────────────────────────┤
│  SQLite (durable)        │ Redis (hot)      │ Flat files    │
├──────────────────────────┼──────────────────┼───────────────┤
│ • All historical trades  │ • Live positions │ • ONNX models │
│ • Ledger (signals, fills,│   (projection)   │ • Raw news    │
│   approvals, orders)     │ • Feature cache  │   snapshots   │
│ • Behavioral fingerprint │ • Event streams  │ • Chain dumps │
│ • Leak report archive    │ • BullMQ queues  │ • Logs        │
│ • Model version metadata │ • Distrib. lock  │               │
│                          │ • Rate-limit     │               │
│                          │   buckets        │               │
└──────────────────────────┴──────────────────┴───────────────┘
```

**Rule:** if losing it would require reconciling with the exchange → SQLite. If losing it just triggers a re-compute → Redis or flat file. **The exchange is the ultimate source of truth for positions and fills**; our ledger exists to detect mismatch and replay.

### Key Data Flows

1. **Boot-time reconciliation:** On start, Reconciler pulls last 48h of MEXC order history (spot + futures) and on-chain swaps. Diffs against ledger. Any orders in exchange not in ledger → INSERT + emit `reconcile.detected.fill`. Any pending approvals older than their TTL → INSERT timeout. Executor stays locked until diff is zero.
2. **Wake-time reconciliation:** Same as boot, but triggered by Windows power-broadcast `PBT_APMRESUMEAUTOMATIC` / `RESUME_SUSPEND`. While asleep, clock gap is detected (>60s delta on a 5s tick). All approvals with expired TTL auto-reject. All pending orders re-queried via exchange API.
3. **Model refresh:** Python trainer writes `v{N+1}.onnx` → updates `/data/models/latest.json` → Node supervisor hot-reloads the inference session. No restart needed.
4. **Three-UI live updates:** Core broadcasts `pnl.delta` + `orders.executed` + `approvals.pending` on a WebSocket fan-out. Telegram pushes via bot API. Web subscribes via WS. CLI subscribes via WS. **All three render from the same event stream.**

## Build Order (with dependencies)

Strict order — each step unblocks the next. Designed to get to a *live-approved-via-Telegram trade* as fast as possible (the weekend target).

```
M0  Scaffold: pnpm + Turborepo + shared-types + shared-schemas + SQLite init
     │  deliverable: `pnpm dev` boots empty core; `npm t` green
     ▼
M1  Persistence foundation: SQLite WAL schema + Redis bus + bus-events pkg
     │  deliverable: test publishes/subscribes round-trip a Trade event
     ▼
M2  MEXC Spot client + History Ingester (read-only)
     │  deliverable: `pnpm seed-history` fills SQLite with 60d of Matt's spot trades
     ▼
M3  MEXC Futures client + History Ingester (read-only)
     │  deliverable: same but for USDT-M futures — different auth, different base
     ▼
M4  On-chain ingesters: Solana (Helius or free RPC) + Ethereum (Etherscan/Alchemy free tier)
     │  deliverable: swaps from both wallets normalized into the trades table
     ▼
M5  Analyzer: fingerprint + leak detection → first weekly leak report in console
     │  deliverable: a human-readable report from real data. **MVP of core value ships here.**
     ▼
M6  Windows Credential Manager integration + config loader
     │  deliverable: zero secrets in env files; wincred holds everything
     ▼
M7  Python trainer: train first XGBoost/LightGBM → export ONNX → Node loads it
     │  deliverable: a signal emitted on each candle close, into a stream (no execution yet)
     ▼
M8  News/Fundamentals filter: CryptoPanic + CoinGecko + 1 on-chain flow source
     │  deliverable: filtered signals stream
     ▼
M9  Risk Manager: pre-trade gates + leverage caps + daily loss circuit breaker
     │  deliverable: approvals.pending stream carries only risk-passing signals
     ▼
M10 Approval Orchestrator + Telegram bot (approve/reject/timeout)
     │  deliverable: a signal appears on your phone; tapping approve emits approvals.decided
     ▼
M11 MEXC Spot Executor (write path)
     │  deliverable: **first $10 live spot approved-via-Telegram trade on MEXC. First validator.**
     ▼
M12 Ledger writer + Fill listener + PnL projection
     │  deliverable: complete signal→fill→PnL loop visible in SQLite
     ▼
M13 Web dashboard (localhost:3000)
     │  deliverable: positions, PnL, signal history, leak report in browser
     ▼
M14 CLI dashboard
     │  deliverable: `pnpm dashboard` live terminal view
     ▼
M15 MEXC Futures Executor (write path) — post-validation, after spot is proven
     │  deliverable: futures trades possible (leverage caps enforced)
     ▼
M16 Reconciler: boot-time + wake-time state repair
     │  deliverable: kill bot mid-fill; restart; state matches exchange. No ghost orders.
     ▼
M17 Lifecycle: sleep/wake detection + heartbeat + distributed lock
     │  deliverable: close laptop; bot safely stops trading; VPS picks up if configured
     ▼
M18 Hostinger VPS deploy + shared-Redis setup + failover test
     │  deliverable: laptop asleep → VPS acquires lock → trades continue → laptop wakes → smooth handback
     ▼
M19 Panic kill-switch + observability polish
     │  deliverable: `/panic` on Telegram cancels all open orders and freezes executor
```

**Build-order dependencies (things that often get reversed and cause rewrites):**
- History ingester BEFORE analyzer (analyzer needs real data to tune against).
- Analyzer BEFORE signal generator (fingerprint informs feature engineering).
- Risk Manager BEFORE executor (never wire execution without the safety layer).
- Approval Orchestrator BEFORE executor write path (never skip the human on the way to live).
- Ledger BEFORE reconciler (reconciler needs the ledger to diff against).
- Reconciler BEFORE deployment topology (VPS failover without reconciliation = double-fire risk).

## Deployment Topology — Primary + Backup without Split-Brain

```
┌────────────────────────────────────────────────────────────────────┐
│                   Matt's Windows 11 laptop (PRIMARY)               │
│                                                                    │
│  ┌───────────────────────────────────────────────────────────┐     │
│  │  core (Node)  →  holds lock `core.leader` when active     │     │
│  │  wincred (secrets source of truth for this instance)      │     │
│  │  local Redis (feature cache only, NOT the shared state)   │     │
│  │  SQLite (local copy, synced to VPS via litestream/rsync)  │     │
│  └──────────────────────────────┬────────────────────────────┘     │
└─────────────────────────────────┼──────────────────────────────────┘
                                  │
                                  │  WireGuard / SSH tunnel
                                  │
┌─────────────────────────────────┼──────────────────────────────────┐
│                    Hostinger VPS (SECONDARY + BROKER)              │
│                                  ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │  Redis (the real one — SHARED STATE)                    │       │
│  │   • core.leader lock (key with TTL)                     │       │
│  │   • event streams (trades.raw, signals.*, etc.)         │       │
│  │   • BullMQ queues (approval jobs)                       │       │
│  └─────────────────────────────────────────────────────────┘       │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │  core (Node) — STANDBY                                   │       │
│  │   • always running, subscribed to all streams            │       │
│  │   • writes analysis, but WILL NOT call executors         │       │
│  │     unless it holds `core.leader`                        │       │
│  │   • own SQLite replica (read from, or litestream-synced) │       │
│  │   • uses its OWN env-file secrets (wincred not portable) │       │
│  └─────────────────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────────────────┘
```

### Split-Brain Prevention

**The design:** A single Redis key `core.leader` with value = instance-id and TTL = 30s. Only the lock-holder executes orders. Both instances try to acquire on boot; if neither holds it, both race via `SET core.leader <id> NX EX 30`. Holder refreshes every 10s. If Windows sleeps, its renew fails, key expires, VPS's next `SET NX` wins.

**Why not Redis Sentinel?** Sentinel requires quorum from ≥3 nodes to safely avoid split-brain. We have 2 nodes. Any 2-node quorum config is either `quorum=1` (split-brain possible on partition) or `quorum=2` (no failover possible if one dies). The single-Redis + lock pattern sidesteps this because the *broker itself* is single-writer for the lock — partition of the primary from Redis = primary silently loses lock, standby acquires, no double-write.

**Why this is safe:**
1. The only thing that matters is "who places orders." Orders are single-writer operations.
2. Only one instance holds the lock at a time (Redis `SET NX` is atomic).
3. If shared Redis is unreachable, *no instance can renew the lock*, so after TTL both stop trading. Fail-closed. Missing trades is acceptable; double-firing is not.
4. Non-holder still consumes streams for analysis, models, dashboards — zero wasted work.

**Gotcha:** Network partition where Windows can reach MEXC but not Redis = Windows drops lock, stops trading. VPS reaches Redis + MEXC, takes over. When Windows rejoins Redis, it sees it no longer holds lock; stays standby. Correct behavior.

**Failure modes table:**

| Scenario | What happens | Outcome |
|----------|--------------|---------|
| Windows wakes from sleep | Lock expired ~30s after sleep started; VPS holds it now | Windows boots into standby; must wait to reclaim |
| VPS crashes | Shared Redis down = nobody can renew | Windows holds lock for <30s then stops; no trades until VPS returns |
| Network between Windows and VPS drops | Windows can't refresh; VPS takes lock | Soft failover. Clean. |
| Both up, both try to trade | Impossible — only one has the lock | N/A |
| Model file out of sync | Only lock-holder matters for trade; loser's stale model is read-only | Safe |
| Windows holds lock but MEXC API auth fails | Orders rejected by MEXC, not by us; Windows keeps lock | Human investigates; no damage |

### Reclaim / manual failback

`/status` shows current leader. `/takeover` (Telegram admin) forces the other instance to release. Preferred workflow: let VPS run overnight, reclaim in the morning by running `pnpm takeover` on laptop.

## Laptop-Sleep Resilience

**Detection:** Windows fires `PBT_APMRESUMEAUTOMATIC` / `PBT_APMSUSPEND` via `WM_POWERBROADCAST`. Node can't subscribe directly but can detect it two ways:
1. `wake-event` / `sleeptime` npm package wraps the native handler.
2. Soft detection: a 5s heartbeat interval; if `Date.now() - lastTick > 60_000`, we were asleep.

Use both; soft detection is the safety net.

**On sleep (PBT_APMSUSPEND):**
1. Stop accepting new signals (flag in memory).
2. Cancel any *non-submitted* pending approvals (Telegram TTL auto-rejects them anyway).
3. Release `core.leader` lock immediately (don't wait for TTL).
4. Flush Redis writes, close SQLite cleanly (WAL checkpoint).
5. Emit `lifecycle.suspend` event.

**On wake (PBT_APMRESUMEAUTOMATIC OR soft detection):**
1. **Do not execute anything until reconciliation completes.**
2. Reconciler pulls last 2h of MEXC spot+futures order history.
3. Diff vs ledger. INSERT fills we missed. Close approvals that timed out. Emit `reconcile.complete`.
4. Try to reacquire `core.leader` via `SET NX`. If VPS holds it, stay in standby.
5. Only if lock acquired AND reconcile is clean: resume executor.

**The key invariant:** the bot never places a new order based on a pre-sleep signal. All signals have a `validUntil` (typically the next candle close). Any signal whose `validUntil < now()` is discarded on wake, even if approved.

## MEXC-Specific Architecture Considerations

- **Two base URLs, two clients:** `api.mexc.com` (spot) and `contract.mexc.com` (futures) are different products with different auth schemes (HMAC details differ), different rate limit scopes, and different WebSocket endpoints. Model them as **two separate clients in `packages/mexc-client`**, not as a monolithic `MexcClient` with `spot()` / `futures()` namespaces — the latter leads to accidental cross-contamination.
- **Independent rate-limit buckets:** Each client gets its own token-bucket limiter. Don't share. MEXC publishes separate limits (spot order rate was reduced in 2025; futures has its own table). A shared budget means a spot storm throttles futures orders.
- **Separate HMAC signing modules:** Spot uses one query-string signing approach; futures uses another. Keep them isolated, unit-tested with known-good fixtures from MEXC docs. Signing bugs are silent at dev time and fatal at runtime.
- **Separate WebSocket subscriptions:** Private channels for spot and futures have separate auth handshakes. Each should be a separate `WebSocketClient` instance with independent reconnection.
- **Order-id namespacing:** Prefix local client-order-ids with `spot-` / `fut-` to avoid ambiguity in the ledger.
- **Futures-API access tier:** Historical note: MEXC has at times restricted futures API to higher tiers. Verify Matt's account tier has write access to `contract.mexc.com` BEFORE reaching M15; otherwise that milestone is blocked and spot must be sufficient for v1. Worth an explicit spike at M2.
- **Zero-fee promos matter at $10:** Executor should tag each order with the fee tier MEXC returns in the fill; analyzer uses this to model real edge (not textbook edge).

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 user, $10 bankroll (today) | Single Node process. SQLite. Redis on VPS. Turborepo. As designed. |
| 1 user, $10k bankroll | Same. Latency isn't the bottleneck; position sizing model is. |
| 1 user, many markets (~50 pairs) | Split `apps/core` into `apps/ingest`, `apps/signals`, `apps/exec` — the bus already exists; just spawn consumer groups in separate processes. |
| Multi-user (ever?) | Stop. This is explicitly personal. Multi-user invalidates the "style preservation" core value. If you actually go here, it's a new product: per-user ledgers, per-user models, per-user credential vault — basically a platform. |

### Scaling Priorities

1. **First bottleneck: feature engineering CPU on dense candle streams.** Mitigation: subsample, cache per-candle features in Redis with TTL = candle duration.
2. **Second bottleneck: MEXC rate limits on futures account queries during reconciliation.** Mitigation: keep a sliding 2h window of private-trade WS events as primary source; REST history only as fallback.
3. **Third bottleneck (unlikely at $10): execution latency.** At single-position-at-a-time scale, this is irrelevant.

## Anti-Patterns

### Anti-Pattern 1: Python sidecar for inference at runtime

**What people do:** Spawn a Python process (FastAPI + XGBoost) alongside the Node core, call it over HTTP for every signal.
**Why it's wrong:** Two runtimes to monitor, two dependency trees, two crash modes, two secret stores, IPC latency, extra surface for bugs. For CPU tree-model inference the latency difference doesn't buy anything.
**Do this instead:** Export to ONNX. Load in `onnxruntime-node`. One process. Model refresh = file drop. Python only runs during training runs.

### Anti-Pattern 2: Executor subscribes to raw signals

**What people do:** Wire the executor to the `signals.candidate` or `signals.filtered` stream directly.
**Why it's wrong:** Bypasses risk gate and approval. One forgotten `if` collapses the whole safety story. Worse, refactors can silently reintroduce it.
**Do this instead:** Executor subscribes ONLY to `approvals.decided{approved:true}`. Make this a type-level invariant if possible (executor's subscribe function is typed to only accept the decided stream).

### Anti-Pattern 3: Unified MEXC client for spot + futures

**What people do:** One class with `client.spot.placeOrder()` and `client.futures.placeOrder()`, sharing auth/signing/rate-limit internals.
**Why it's wrong:** The two APIs drift. A spot signing tweak breaks futures. A futures rate-limit burst throttles spot. Debugging is harder because stacks interleave.
**Do this instead:** Two packages or two classes that share NOTHING except the `Order` type. Each has its own signing module, its own rate-limit bucket, its own WS client.

### Anti-Pattern 4: Multiple instances racing for orders with Redis Sentinel

**What people do:** Deploy 2 instances behind Sentinel with quorum=1 for fast failover.
**Why it's wrong:** With 2 nodes and quorum=1, a network partition lets *both* instances think they're master and trade. At $10 you can lose the bankroll in one double-fire.
**Do this instead:** Single-Redis + distributed lock pattern. Accept 30s of downtime on failover in exchange for never double-firing.

### Anti-Pattern 5: SQLite with default journal mode for the ledger

**What people do:** `new Database('ledger.db')` and move on.
**Why it's wrong:** Default journal mode doesn't survive hard crashes as cleanly as WAL. `synchronous=NORMAL` can lose the last transaction on power loss. Money data demands more.
**Do this instead:** `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;` on every connection open. Use `better-sqlite3` (synchronous API, fastest for this workload).

### Anti-Pattern 6: Business logic in Telegram handlers / web routes / CLI commands

**What people do:** Compute PnL in the `/status` Telegram handler. Parse fills in a route handler. Call MEXC directly from the CLI.
**Why it's wrong:** Three copies of the same logic drift. A bug fix in one doesn't reach the others.
**Do this instead:** All three UIs call the same core RPC. Core exposes `getPositions()`, `getPnL()`, `listRecentSignals()`, `decideApproval(id, yes|no)`. UIs render; they don't compute.

### Anti-Pattern 7: Feature engineering in two places without a golden-value test

**What people do:** Write feature code in Python (training) and TypeScript (inference). Assume they match.
**Why it's wrong:** Silent drift. A fixed bug in one side can flip the sign of a predictor. Live inference uses different features than the model was trained on.
**Do this instead:** Commit a fixture of `(raw_input, expected_feature_vector)` pairs. Python and TypeScript test suites both assert against the same fixtures. CI fails if either drifts.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| MEXC Spot REST | HMAC-signed requests; per-endpoint rate limits | Use native fetch/axios; do NOT trust unofficial SDKs as source of truth for signing — re-derive from docs |
| MEXC Spot WS | Listen-key-based private channel; public channels unauth | Listen-key expires — refresh every ~30m |
| MEXC Futures REST | `contract.mexc.com`; DIFFERENT signing | Verify account has futures API tier before depending on this |
| MEXC Futures WS | Private channel with separate auth handshake | Don't share connection with spot WS |
| CryptoPanic | REST with API key; rate-limited | Cache aggressively; poll every 2-5m |
| CoinGecko | REST public + pro tiers | Free tier limits bite at ~30 req/min; use ETag |
| Etherscan / Alchemy | REST with API key | Free tier is fine for 2 wallets polled every few minutes |
| Solana RPC (Helius free) | JSON-RPC | Solflare/Phantom addresses need parsed instruction decoding for swaps — see Jupiter/Raydium program IDs |
| Telegram Bot API | telegraf; webhooks or long-polling | On laptop, long-polling; on VPS, webhook |
| Windows Credential Manager | `wincred` npm pkg (spawns `vaultcmd` / native API) | Linux VPS falls back to `.env` (encrypted at rest via filesystem perms) |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Ingesters ↔ Analyzer | Redis Streams `trades.raw` | Consumer group so replay on crash is safe |
| Feature Builder ↔ Signal Generator | Redis Streams `features.v1` | Payload includes feature-vector version + model-version hint |
| Signal Generator ↔ News Filter | Redis Streams `signals.candidate` | Filter either forwards to `signals.filtered` or drops with reason |
| Risk Manager ↔ Executor | Direct call (risk is a pure function) → publish `approvals.pending` | Risk is synchronous; don't bus-ify pure functions |
| Approval Orchestrator ↔ Telegram bot | HTTP (core exposes `/api/approval/:id/decide`) | Telegram bot is a thin proxy for inline-button taps |
| Executor ↔ Ledger | Direct SQLite writes | Ledger is in-process; one-process-at-a-time invariant holds |
| Ledger ↔ UIs | WS broadcast of ledger events | All three UIs consume the same stream |
| Python trainer ↔ Node core | Filesystem (ONNX file + SQLite read) | Zero live coupling |
| Primary core ↔ Secondary core | Shared Redis (streams + lock key) | No direct TCP between instances |

## Sources

- [Monorepo in 2026: Turborepo vs Nx vs Bazel](https://daily.dev/blog/monorepo-turborepo-vs-nx-vs-bazel-modern-development-teams)
- [Monorepo Tools 2026: Turborepo vs Nx vs Lerna vs pnpm Workspaces](https://viadreams.cc/en/blog/monorepo-tools-2026/)
- [Event-Driven Architecture Using Redis Streams (Harness)](https://www.harness.io/blog/event-driven-architecture-redis-streams)
- [node-redis-streams with consumer group recovery](https://github.com/danthegoodman1/node-redis-streams)
- [ONNX Runtime — traditional ML (Microsoft)](https://onnxruntime.ai/docs/tutorials/traditional-ml.html)
- [Converting XGBoost models to ONNX (sklearn-onnx)](http://onnx.ai/sklearn-onnx/auto_examples/plot_pipeline_xgboost.html)
- [Converting LightGBM Models to ONNX](https://io.traffine.com/en/articles/lightgbm-model-conversion-and-iInference-with-onnx)
- [BullMQ docs — architecture and job states](https://docs.bullmq.io/guide/architecture)
- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [SQLite WAL — Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [Redis Sentinel failover & split-brain (Netdata)](https://www.netdata.cloud/academy/redis-cluster-split/)
- [Failover, Split Brain, and Leader Election Mechanics (System Overflow)](https://www.systemoverflow.com/learn/replication-consistency/leader-follower-replication/failover-split-brain-and-leader-election-mechanics)
- [Fastify vs Express for Node.js backends 2026](https://www.pkgpulse.com/blog/express-vs-fastify-2026)
- [Telegraf Telegram Bot Framework](https://telegraf.js.org/)
- [wake-event npm package](https://www.npmjs.com/package/wake-event)
- [sleeptime Node.js sleep/wake detection](https://github.com/timrach/sleeptime)
- [MEXC API docs — General Info / Spot v3](https://www.mexc.com/api-docs/spot-v3/general-info)
- [MEXC API docs — Futures Market Endpoints](https://www.mexc.com/api-docs/futures/market-endpoints)
- [MEXC API Futures Trading announcement (Mar 2026)](https://www.mexc.com/announcements/article/introducing-api-futures-trading-on-mar-31-2026-17827791534551)
- [Concurrency, State & Fault Tolerance in Stock Trading Bots (Medium, Jan 2026)](https://medium.com/@halljames9963/concurrency-state-management-and-fault-tolerance-in-stock-trading-bots-da774736c58c)
- [Event Sourcing with Examples in Node.js (RisingStack)](https://blog.risingstack.com/event-sourcing-with-examples-node-js-at-scale/)

---
*Architecture research for: personal semi-auto trading copilot (MEXC + on-chain + local ML)*
*Researched: 2026-04-17*
