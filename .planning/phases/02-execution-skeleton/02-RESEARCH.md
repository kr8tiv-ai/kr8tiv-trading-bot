# Phase 2: Execution Skeleton - Research

**Researched:** 2026-04-18
**Domain:** MEXC spot write API with safety rails — idempotency, server-side stops (constrained), minNotional, circuit breaker, panic switch, Redis-backed state
**Confidence:** HIGH on MEXC spot endpoint mechanics + Redis Streams + CCXT quirks • MEDIUM on the exact clientOrderId uniqueness window (MEXC docs silent) • **HIGH on the blocker finding: MEXC spot v3 REST does NOT natively support stop-loss/triggerPrice — EXEC-03 must be re-scoped**

<user_constraints>
## User Constraints (from 02-CONTEXT.md)

### Locked Decisions

**D-01. Signal source during Phase 2 (no Telegram/ML yet)**
- CLI test harness shipped as `apps/core/src/place-order.ts`. Real command: `pnpm place-order --side buy --notional <N>`.
- Harness writes a **full Redis Stream pipeline**: `signals.candidate` → `signals.filtered` → `approvals.pending` → `approvals.decided`. Phase 3 replaces the `approvals.pending→decided` link with Telegram; Phase 4 replaces `signals.candidate` with ML output. Seam integrity proven end-to-end from day 1.
- **`signal_id` is a UUID v4** generated per harness invocation. Phase 4 replaces with real signal identifiers from the ML layer. Idempotency key spec from SUMMARY.md preserved: `newClientOrderId = sha256(signal_id + approval_timestamp)`.

**D-02. Panic kill-switch (Phase 2 interim; Phase 3 adds Telegram trigger)**
- **Trigger:** `pnpm panic` CLI writes `executor:armed=false` to Redis. Phase 3 adds `/panic` Telegram command as a second trigger; CLI stays as the fallback forever.
- **Action on panic:** **cancel + flatten + freeze**. (1) `exchange.cancelAllOrders('ETHUSDT')`. (2) Market-close any open position via a flatten order. (3) Set `executor:armed=false` so no new orders process.
- **Re-arm:** `pnpm arm` CLI writes `executor:armed=true` to Redis. Explicit human action required — which is the whole point of a kill switch.
- **Persistence:** `executor:armed` is a Redis key. Survives process crash. Boot reads the key; if false, executor refuses to process new orders until `pnpm arm` runs. Satisfies EXEC-08 (position-aware state survives restart).

**D-03. Daily-loss circuit breaker**
- **PnL scope: realized only.** Only closed-position PnL counts toward the $2 daily cap. Open-trade unrealized drawdown is limited by the per-entry server-side stop (~1% of entry notional) and does not trigger the circuit.
- **Reset: UTC midnight.** `today = sum of realized_pnl where closed_at >= today-UTC-00:00:00`. Matches MEXC's reporting timezone; predictable; aligns with funding rate windows.
- **Trip action: block new orders, leave existing.** Executor refuses new orders; open positions + their server-side stops continue unmolested. Re-arm path: manual `pnpm arm` OR natural UTC reset at next midnight. No panic-flatten on trip — that's what /panic is for.

**D-04. First-live-trade at end of Phase 2**
- **Phase 2 fires ONE real MEXC order** as the EXEC success proof. Not deferred to Phase 5.
- **Sequence:** after all unit + integration tests pass, run `pnpm place-order --side buy --notional $(2 * minNotional)` — notional computed dynamically by pulling `exchangeInfo` for ETHUSDT and multiplying minNotional by 2. Attach server-side stop. Immediately run `pnpm panic` to cancel + flatten. Confirms: MEXC accepts the order, clientOrderId survives duplicate rejection on retry (idempotency gate), server-side stop visible in MEXC UI, panic actually cancels.
- **This trade is gated** — the `pnpm place-order` CLI refuses to call real MEXC unless `MEXC_LIVE=1` env is set. Default runs stay mocked. Matches Plan 01-04's gating pattern.
- **Outcome recorded in 02-SUMMARY.md:** actual fill clientOrderId, duplicate-rejection response body, stop-loss order ID visible in MEXC UI, panic-cancel confirmation.

**D-05. Boot-time stale-state policy**
- **Refuse to start if Redis ledger is non-empty at boot.** If `executor:positions:*` or `executor:orders:*` keys show non-empty, `boot()` throws `BootError(stage='pre-flight')` with message: `"stale state detected — run \`pnpm reconcile\` before starting"`.
- **`apps/core/src/reconcile.ts` is a new Phase 2 CLI** that: (1) queries MEXC truth via `fetchOpenOrders` + position query, (2) overwrites Redis state with MEXC's view, (3) writes `reconciled_at` timestamp. Phase 5 replaces this CLI with an automated boot-time reconciler and adds crash-recovery edge cases; Phase 2 ships the minimal happy-path version.
- **Why not auto-sync on every boot:** MEXC query can fail or return partial data. Explicit manual step forces Matt to confirm state is clean before resuming trading.

**D-06. Order types — market-only in Phase 2**
- **`placeMarketBuy` + `placeMarketSell` only.** No limit orders in Phase 2 (no time-in-force, no filled-partial state machine).
- **Phase 4 adds limit orders** when the ML/rule signal generator produces suggested entry prices that require non-market placement.
- `@kr8tiv/mexc-spot` exports `MEXCSpotClient.placeMarketBuy(params) → Promise<OrderFilled>` and `placeMarketSell(...)` in Phase 2. `placeLimitBuy/placeLimitSell` are explicit TODOs with a `// Phase 4 — see 02-CONTEXT D-06` comment.

### Claude's Discretion

- Exact file layout inside `@kr8tiv/executor` (separate package) vs `apps/core/src/executor/` (folder). Whichever is more consistent with the monorepo's existing package boundaries. Default to a new package `@kr8tiv/executor` since it matches the pattern of existing packages (config, logger, secrets, etc.) and keeps apps/core thin.
- Redis key namespace for executor state (`executor:armed`, `executor:positions`, `executor:orders`, `executor:breaker`). Namespace prefix is `executor:` per SUMMARY.md `features.v1` / `approvals.decided` naming convention.
- Rate-limit bucket behavior on Redis failure: fail-closed (executor refuses orders) is the safe default per the project's "semi-auto, never autonomous" ethos. Log a fatal error and require `pnpm arm` to resume once Redis is back.
- Fee rate caching strategy. SUMMARY.md Pitfall 12 says "query dynamically". Planner decides TTL (5 min is reasonable) and invalidation trigger (on every order).
- Exact test matrix — vitest includes mocked unit tests + optional MEXC_LIVE=1 integration tests (mirroring Plan 01-04 pattern).
- Fastify web endpoint for panic is explicitly OUT of scope for Phase 2 (would overlap with Phase 9 dashboard) — CLI only.

### Deferred Ideas (OUT OF SCOPE)

- **Web dashboard panic button** — a `POST /panic` Fastify endpoint would be convenient but overlaps with Phase 9 dashboard. Not Phase 2.
- **Auto re-arm after N minutes of clean ledger** — rejected in Area B. Kill-switch stays explicit-human-reset. If Matt later wants a timer, Phase 10 (observability) is a reasonable home.
- **Real-time unrealized-PnL circuit breaker** (mark-to-market) — rejected in Area C in favor of realized-only. If flash-crash protection becomes an issue in Phase 5+ live running, revisit then.
- **Graceful "downsize next order" soft-stop** — rejected in Area C. Could revisit in Phase 4 when ML signal confidence scores exist (scaled sizing by confidence delta).
- **Limit orders** — deferred to Phase 4 per D-06. When signals emit specific entry prices.
- **Rate-limit bucket recovery from Redis failure** — Claude's Discretion: fail-closed. If Matt later wants a "continue with degraded rate-tracking on Redis outage" path, it's a Phase 10 observability concern.
- **`pnpm reconcile` CLI → automated boot-time reconciler** — Phase 5 automates this; Phase 2 ships the manual version only.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EXEC-01 | Risk manager module that gates every order — leverage cap (4x ETH, spot=1x implicit), $2 daily-loss breaker, per-asset exposure cap, correlation guard. **Synchronous, pre-order.** | Pattern 3 (Risk Manager sync gate); SQLite realized_pnl schema; Redis `executor:breaker:*` keys |
| EXEC-02 | `MEXCSpotClient` write methods REQUIRE `newClientOrderId` — no order without one | Pattern 1 (CCXT createOrder param mapping); idempotency key spec (Pattern 4); duplicate-reject error behavior (open question — HIGH-confidence best-guess below) |
| EXEC-03 | **Every entry order automatically attaches a server-side stop-loss (`triggerPrice`) — no naked orders** | **⚠️ BLOCKER: MEXC spot v3 REST API does NOT support native stop-loss/triggerPrice. See Pitfall 2 below. Three escape-hatch options documented.** |
| EXEC-04 | Pre-order `minNotional` check against `exchangeInfo.quoteAmountPrecisionMarket`; reject if `2 * minNotional > available balance` | Pattern 2 (exchangeInfo fetch + cache); SQLite schema; USDT balance via `fetchBalance({type:'spot'})` |
| EXEC-05 | Fee rate queried dynamically (never hardcoded) | Pattern 8 (fee cache); `exchangeInfo.takerCommission` per symbol or VIP tier call |
| EXEC-06 | Pair whitelist = `{ETHUSDT}` only; any other pair rejected with explicit reason | Pattern 3 (constant `ALLOWED_PAIRS` in risk manager) |
| EXEC-07 | `/panic` cancels all orders, flattens positions, freezes executor | Pattern 5 (panic sequence); `cancelAllOrders` + `fetchBalance` + market-close pattern |
| EXEC-08 | Position-aware state in Redis: positions, pending approvals, rate-limit buckets survive restart | Pattern 6 (Redis key conventions); SQLite as durability backstop (`executor_state` table) |
| EXEC-09 | Executor subscribes ONLY to `approvals.decided{approved:true}` — architectural invariant | Pattern 4 (Redis Streams consumer group); type-level restriction through the stream name constant |
</phase_requirements>

## Summary

Phase 2 is a **three-layer add** on top of Plan 01-04's read-only MEXC client: (1) **write methods on `MEXCSpotClient`** using CCXT's `createOrder`/`cancelOrder`/`fetchOpenOrders` with `newClientOrderId` in `params`, (2) a **risk manager module** that runs a synchronous pre-order gate (whitelist + minNotional×2 + circuit breaker + armed check), and (3) a **Redis Streams consumer** (`executor-v1` consumer group, XREADGROUP-with-BLOCK pattern) subscribed to `approvals.decided`. Every live path writes to **three durability layers in strict order**: (a) Redis hot state (`executor:positions:*`, `executor:orders:*`, `executor:breaker:*`), (b) SQLite `orders`/`fills`/`realized_pnl`/`executor_state` tables, (c) MEXC as the ultimate truth via `fetchOpenOrders` reconciliation.

**Critical blocker discovered:** MEXC spot v3 REST API (`POST /api/v3/order`) supports ONLY `LIMIT | LIMIT_MAKER | MARKET | IOC | FOK` — there is NO `STOP_LOSS`, `STOP_LOSS_LIMIT`, `TAKE_PROFIT` or `triggerPrice` parameter. This is confirmed in three independent sources (official MEXC docs, mexcdevelop/apidocs, CCXT's spot config `'triggerPrice': false`). OCO/TP-SL exists on MEXC's UI but is not exposed through the public spot API. **EXEC-03's "server-side stop attached to every entry" is not achievable through the MEXC spot REST API as currently specified.** Three escape-hatch options are documented below (Pitfall 2 / Open Question 1) for planner + user resolution.

The rest of the phase is mechanically straightforward: ccxt 4.5 handles market buy/sell via `createOrder(symbol='ETH/USDT', type='market', side='buy'/'sell', amount=qty)` with `params.newClientOrderId` as the idempotency key. ioredis 5.4's XREADGROUP with BLOCK is a single call. SQLite WAL is already open. The SecretProvider already holds MEXC credentials. The architectural invariants (ccxt in exactly 2 files, ioredis only in redis-client/factory, executor subscribes only to `approvals.decided`) are all preserved by this research's recommended layout.

**Primary recommendation:** Build Phase 2 in five atomic plans — (1) Add write methods to `@kr8tiv/mexc-spot`, (2) Create `@kr8tiv/executor` package with risk manager + stream consumer + ledger writer, (3) Add CLIs `place-order` / `panic` / `arm` / `reconcile` to `@kr8tiv/scripts`, (4) Extend `apps/core/boot.ts` Step 10 (stale-state check + executor handle), (5) End-of-phase live-trade proof `pnpm place-order --notional $(2*minNotional) MEXC_LIVE=1` followed by `pnpm panic`. **Resolve EXEC-03 with Matt before planning** — the three options have materially different test/implementation costs.

## Project Constraints (from CLAUDE.md)

The following directives from `CLAUDE.md` are authoritative and MUST be enforced by every plan:

| Directive | Source line | Enforcement |
|-----------|-------------|-------------|
| **Capital = $10 live** | "`$10 live starting bankroll — shapes all position sizing, strategy selection, and risk limits`" | minNotional check REJECTS if `2*minNotional > balance`; position sizing uses ≤ `balance/4` default |
| **Semi-auto only** | "`semi-auto only in v1 — bot must never place an order without explicit Telegram approval`" | Executor subscribes only to `approvals.decided` (EXEC-09); Phase 2 test-harness CLI synthesizes the approval through the full stream pipeline to preserve the invariant |
| **Node.js + TypeScript core, Redis for state** | "`Tech stack: Node.js + TypeScript for the bot core, Python allowed for ML training pipeline`" | All Phase 2 code in TS strict; Redis is the authoritative hot state; no Python |
| **MEXC-only exchange** | "`Exchange: MEXC only for execution. Spot + USDT-M perpetual futures`" | Phase 2 touches SPOT only; ETHUSDT whitelist; no cross-exchange code |
| **Windows Credential Manager for secrets** | "`Windows Credential Manager for all sensitive keys`" | SecretProvider already wired in Plan 01-02; Phase 2 reads through `secrets.get()` only, never direct env |
| **CCXT 4.5.48+** | Stack table row | Already pinned at `^4.5` in mexc-spot package |
| **Commit identity: Matt-Aurora-Ventures <lucidbloks@gmail.com>** | "`All git commits authored as Matt-Aurora-Ventures`" | **Every commit in Phase 2 uses this identity. Never Claude. Never a Co-Authored-By line.** |
| **ccxt in exactly 2 files** | Stack "Two separate MEXC client classes" + Plan 01-04 summary | Phase 2 ADDS write methods to `packages/mexc-spot/src/client.ts`, does NOT create a third import point |
| **ioredis in exactly 1 file** | Architectural invariant from Plan 01-03 | Executor imports `Redis` from `@kr8tiv/redis-client`, never `ioredis` directly |
| **better-sqlite3 in exactly 1 file** | Architectural invariant from Plan 01-03 | Executor imports via `@kr8tiv/db` only |
| **Bot never calls withdraw APIs** | Phase 1 readiness doc §1 signed 2026-04-18 | No `withdraw` method ever added to `MEXCSpotClient`; grep `source \| grep -i withdraw` returns zero hits as a CI check |
| **Git commit bypass pattern** | STATE.md known blocker | All commits `git -c core.hooksPath=/dev/null commit --no-verify -m '...'` per Plan 01-02 decision |

If ANY Phase 2 plan contradicts one of these directives, the plan MUST be rejected.

## Standard Stack

### Core (already installed — Phase 2 extends, does not add)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **ccxt** | ^4.5.48 (installed `^4.5` → latest 4.5.x at install time) | Unified MEXC spot API client (already extended via `MEXCSpotClient`) | Phase 2 calls `exchange.createOrder(...)` / `cancelOrder(...)` / `cancelAllOrders(...)` / `fetchOpenOrders(...)` / `fetchBalance(...)` through the existing `readonly exchange: Exchange` handle. No new dep. |
| **ioredis** | ^5.4 (at `packages/redis-client`) | Redis Streams producer + consumer for `approvals.decided` | Native XADD/XREADGROUP support; 100% TS with official declarations; Streams are first-class (from package README). Only imported in `packages/redis-client/src/factory.ts` — invariant preserved. |
| **better-sqlite3** | ^12.0 (at `packages/db`) | Synchronous SQLite with WAL+synchronous=FULL for `orders` + `fills` + `realized_pnl` + `executor_state` tables | Synchronous API = no race on ledger writes; ~2000 qps with indexes. Imported only in `packages/db/src/open.ts`. |
| **zod** | ^3.23 (at `packages/shared-schemas`) | Validate MEXC order/cancel/fill responses before they reach downstream code | Pattern from Plan 01-04 — "Zod at the response boundary." Phase 2 adds `MexcOrderResponseSchema`, `MexcCancelResponseSchema`, `MexcFillSchema`, `MexcExchangeInfoSchema`. |
| **pino** | ^9.5 (at `packages/logger`) | Structured logs with redaction for API keys, signatures, etc. | Already wired; Phase 2 uses `log.info({ clientOrderId, signalId }, "order accepted")` — redaction paths cover `apiKey|secret|mexc.*` depth 1–3. |

### Supporting (new — Phase 2 adds if planner chooses)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **uuid** | ^11 (latest stable) | UUID v4 generation for `signal_id` per harness invocation (D-01) | Test harness only — `crypto.randomUUID()` from node:crypto is an equally-valid zero-dep alternative. Recommendation: **use `crypto.randomUUID()`** from the Node 22 built-in — no new dep, same RFC-4122 output. |
| **commander** or **arg** | ^12 / ^5 | CLI argument parsing for `pnpm place-order --side buy --notional N` | Matches `@kr8tiv/scripts` pattern. If `@kr8tiv/scripts` already has a preferred flag parser, reuse; otherwise **recommendation: `arg`** (smaller, zero-deps, 5 minutes to wire). For just `--side` + `--notional`, even a hand-rolled `process.argv.slice(2)` loop is fine. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| **CCXT `createOrder`** | Native `fetch` + `node:crypto` HMAC against `POST /api/v3/order` | CCXT handles signing, unified error types, symbol normalization. Going native forces reimplementing all of that and breaks the "ccxt in exactly 2 files" invariant. Only use if CCXT has a bug blocking a specific endpoint — it doesn't, this endpoint is well-supported. **Keep CCXT.** |
| **BullMQ for approvals queue** | Direct Redis Streams only | BullMQ adds TTL, retry, observability. Phase 3 (Telegram + 90s TTL) benefits more from BullMQ than Phase 2 does. **Phase 2 uses raw Streams; BullMQ enters in Phase 3.** This keeps Phase 2 scope honest. |
| **Redlock / ioredis-lock** | Simple single-key SET NX for executor singleton | Distributed lock is a Phase 10 (VPS failover) concern. Phase 2 has ONE process — no lock needed. **Skip.** |
| **node-cron / bull repeatable jobs** for UTC midnight circuit-breaker reset | On-read comparison: `if (row.closed_at >= startOfTodayUTC())` | No scheduler state needed. **Skip scheduler; use on-read compute.** |

**Installation (Phase 2 only — incremental over Plan 01-*):**
```bash
# No new external deps required if planner uses node:crypto.randomUUID + hand-rolled argv parsing.
# If planner chooses a flag parser (Claude's Discretion):
pnpm --filter @kr8tiv/scripts add arg
```

**Version verification (checked 2026-04-18 via npm view):**
- `ccxt` — 4.5.48 is installed as floor; current latest `^4.5` resolves daily. Already locked in `packages/mexc-spot/package.json`.
- `ioredis` — 5.4.x at Phase 1; Streams are stable in 5.x.
- `better-sqlite3` — 12.0 at Phase 1; Node 24 prebuilts confirmed.
- `uuid` (if chosen) — 11.x latest; `crypto.randomUUID()` is preferred (zero-dep).

## Architecture Patterns

### Recommended Project Structure

```
packages/
├── executor/                         # NEW — @kr8tiv/executor (Claude's Discretion: separate pkg)
│   ├── src/
│   │   ├── index.ts                  # Public exports: createExecutor, type Executor
│   │   ├── executor.ts               # Stream consumer lifecycle + handler wiring
│   │   ├── risk-manager.ts           # Synchronous pre-order gate (EXEC-01, EXEC-04, EXEC-06)
│   │   ├── panic.ts                  # Cancel-flatten-freeze sequence (EXEC-07)
│   │   ├── breaker.ts                # Daily realized-PnL circuit (EXEC-01, D-03)
│   │   ├── idempotency.ts            # sha256(signal_id + approval_ts) → newClientOrderId
│   │   ├── ledger.ts                 # SQLite writes: orders, fills, realized_pnl, executor_state
│   │   ├── state.ts                  # Redis state read/write for executor:* keys
│   │   └── types.ts                  # ApprovalDecided event schema, OrderIntent, OrderResult
│   ├── package.json                  # deps: @kr8tiv/mexc-spot, redis-client, db, logger, secrets, shared-schemas
│   └── vitest.config.ts
├── mexc-spot/                        # EXTEND — add write methods to existing client.ts
│   └── src/client.ts                 # + placeMarketBuy, placeMarketSell, cancelOrder,
│                                       cancelAllOrders, fetchOpenOrders,
│                                       fetchExchangeInfo (for minNotional)
└── shared-schemas/                   # EXTEND — add order/cancel/fill/exchangeInfo Zod schemas
    └── src/mexc.ts                   # + MexcOrderResponseSchema, MexcCancelResponseSchema,
                                        MexcFillSchema, MexcExchangeInfoSchema,
                                        MexcSymbolFilterSchema

apps/core/src/
├── boot.ts                           # EXTEND — Step 10 adds stale-state check + executor start
├── place-order.ts                    # NEW CLI — synthesizes full stream pipeline, invokes executor
└── reconcile.ts                      # NEW CLI — MEXC truth → overwrite Redis state

scripts/                              # Existing @kr8tiv/scripts workspace
├── panic.ts                          # NEW CLI — SET executor:armed=false + trigger panic sequence
├── arm.ts                            # NEW CLI — SET executor:armed=true
└── (existing setup-credentials.ts etc.)
```

### Pattern 1: MEXC Spot Write Methods via CCXT

**What:** Add five write methods to `MEXCSpotClient` that delegate to the existing `readonly exchange: Exchange` handle. All responses parsed through Zod schemas. Idempotency key is a REQUIRED argument on placement methods — no default, no null.

**When to use:** Every write path. No direct `this.exchange.createOrder(...)` elsewhere in the codebase.

**Why this works:** CCXT 4.5 maps MEXC spot's `POST /api/v3/order` through `createOrder(symbol, type, side, amount, price?, params?)`. MEXC's `newClientOrderId` passes through `params.newClientOrderId` (VERIFIED: this is the exact field name in MEXC's v3 request body; CCXT forwards param keys matching exchange field names unchanged). The symbol must be in CCXT's unified format `'ETH/USDT'` (with slash) — CCXT internally converts to MEXC's `ETHUSDT` via `market.id`. Market orders use `amount` as base-asset quantity by default; to place a market BUY by quote-asset cost (spending $X USDT), pass `params.quoteOrderQty = cost` OR set `options.createMarketBuyOrderRequiresPrice = false` and pass cost as `amount` (see ccxt issues #23784, #25660, #3460 — Phase 2 uses the explicit `params.quoteOrderQty` form because it's less error-prone and matches MEXC's actual field name).

**Example:**
```typescript
// packages/mexc-spot/src/client.ts — Phase 2 additions

interface PlaceMarketOrderParams {
  symbol: string;            // 'ETHUSDT' — will be converted to 'ETH/USDT' internally
  clientOrderId: string;     // sha256 hex — REQUIRED, no default
  // Exactly ONE of quantity (base asset, e.g. ETH) or quoteOrderQty (quote asset, e.g. USDT)
  quantity?: string;         // e.g. '0.001' ETH
  quoteOrderQty?: string;    // e.g. '5' USDT
}

async placeMarketBuy(p: PlaceMarketOrderParams): Promise<OrderResult> {
  // Convert 'ETHUSDT' -> 'ETH/USDT' for CCXT's unified symbol format
  const ccxtSymbol = this.toCcxtSymbol(p.symbol);  // 'ETH/USDT'

  // Build CCXT params: newClientOrderId + optional quoteOrderQty
  const params: Record<string, unknown> = { newClientOrderId: p.clientOrderId };
  if (p.quoteOrderQty) params.quoteOrderQty = p.quoteOrderQty;

  // When using quoteOrderQty, amount is still required by ccxt's API but MEXC
  // uses quoteOrderQty instead. Passing 0 as amount is the safe pattern; MEXC
  // takes quoteOrderQty precedence. Alternatively set amount = quantity for
  // the non-quoteOrderQty case.
  const amount = p.quantity ? Number(p.quantity) : 0;

  const raw = await this.exchange.createOrder(
    ccxtSymbol, 'market', 'buy', amount, undefined, params,
  );
  return MexcOrderResponseSchema.parse(raw);
}

async placeMarketSell(p: PlaceMarketOrderParams): Promise<OrderResult> {
  const ccxtSymbol = this.toCcxtSymbol(p.symbol);
  const params: Record<string, unknown> = { newClientOrderId: p.clientOrderId };
  if (p.quantity) {
    const raw = await this.exchange.createOrder(
      ccxtSymbol, 'market', 'sell', Number(p.quantity), undefined, params,
    );
    return MexcOrderResponseSchema.parse(raw);
  }
  throw new Error('placeMarketSell requires quantity (base-asset amount)');
}

async cancelOrder(symbol: string, clientOrderId: string): Promise<CancelResult> {
  // MEXC allows canceling by orderId OR origClientOrderId; use origClientOrderId
  // since we generated it and may not have captured orderId on the optimistic path.
  const ccxtSymbol = this.toCcxtSymbol(symbol);
  const raw = await this.exchange.cancelOrder(
    undefined,  // ccxt orderId — we don't have it
    ccxtSymbol,
    { origClientOrderId: clientOrderId },
  );
  return MexcCancelResponseSchema.parse(raw);
}

async cancelAllOrders(symbol: string): Promise<CancelResult[]> {
  // MEXC: DELETE /api/v3/openOrders?symbol=XXX cancels all open orders for that symbol.
  // ccxt unified: cancelAllOrders(symbol) — ccxt's MEXC driver maps to the openOrders endpoint.
  const ccxtSymbol = this.toCcxtSymbol(symbol);
  const raw = await this.exchange.cancelAllOrders(ccxtSymbol);
  return z.array(MexcCancelResponseSchema).parse(raw);
}

async fetchOpenOrders(symbol: string): Promise<OrderResult[]> {
  const ccxtSymbol = this.toCcxtSymbol(symbol);
  const raw = await this.exchange.fetchOpenOrders(ccxtSymbol);
  return z.array(MexcOrderResponseSchema).parse(raw);
}

async fetchExchangeInfo(symbol?: string): Promise<ExchangeInfo> {
  // CCXT's markets cache holds equivalent data but misses some MEXC-specific fields
  // (quoteAmountPrecisionMarket — the ONLY source of minNotional for market orders).
  // Fallback to direct call when possible, else parse from loaded markets.
  await this.exchange.loadMarkets(true);  // force refresh
  if (symbol) {
    const market = this.exchange.market(this.toCcxtSymbol(symbol));
    return MexcExchangeInfoSchema.parse(market.info);  // raw MEXC response inside
  }
  return MexcExchangeInfoSchema.parse(this.exchange.markets);
}

private toCcxtSymbol(mexcSymbol: string): string {
  // 'ETHUSDT' -> 'ETH/USDT' — use the loaded markets to do this correctly,
  // but the shortcut for ETHUSDT-only v1 is safe enough.
  if (mexcSymbol === 'ETHUSDT') return 'ETH/USDT';
  throw new Error(`Pair not whitelisted: ${mexcSymbol}`);  // satisfies EXEC-06
}
```

**Sources:**
- CCXT 4.5 `createOrder` method and params passthrough: `ts/src/mexc.ts` lines ~345-385 feature flags, ~1065-1195 error exceptions.
- MEXC `POST /api/v3/order` parameters: https://www.mexc.com/api-docs/spot-v3/spot-account-trade (verified 2026-04-18).
- ccxt issue #23784 and #3460 for `createMarketBuyOrderRequiresPrice` / `quoteOrderQty` interaction.

### Pattern 2: exchangeInfo Fetch + minNotional Check

**What:** Pull MEXC's per-symbol precision and notional constraints from `GET /api/v3/exchangeInfo` (CCXT wraps this as `loadMarkets(true)` + `market.info`). Cache for 1 hour (exchange doesn't change these often; a startup refresh + hourly refresh is sufficient). Reject if `2 * minNotional > availableUsdtBalance`.

**When to use:** Once at boot (populates cache), and optionally per order for `stale<60min` check. Before EVERY order placement for the minNotional gate.

**Why this works:** MEXC's `exchangeInfo` returns per-symbol:
- `baseSizePrecision` — minimum base-asset quantity (e.g. `"0.00001"` ETH)
- `quoteAmountPrecision` — minimum quote-asset notional for LIMIT orders (e.g. `"0.5"` USDT)
- `quoteAmountPrecisionMarket` — minimum quote-asset notional for MARKET orders (the field that matters for Phase 2 since D-06 = market-only) (e.g. `"5"` USDT)
- `maxQuoteAmount` / `maxQuoteAmountMarket` — upper bound
- `takerCommission` / `makerCommission` — per-VIP fee rate (used by EXEC-05)

**Example:**
```typescript
// packages/executor/src/risk-manager.ts

interface PreOrderCheck {
  pair: string;                  // 'ETHUSDT'
  side: 'buy' | 'sell';
  notionalUsdt: number;          // planned quote cost
}

async function ensureOrderPossible(
  spot: MEXCSpotClient,
  check: PreOrderCheck,
  balanceCache: BalanceCache,
  breaker: CircuitBreaker,
  armedState: ArmedState,
): Promise<void> {
  // 0. Panic switch - fail closed if not armed
  if (!(await armedState.isArmed())) {
    throw new RiskError('executor not armed — run `pnpm arm`', 'NOT_ARMED');
  }

  // 1. Pair whitelist (EXEC-06)
  const ALLOWED = new Set(['ETHUSDT']);
  if (!ALLOWED.has(check.pair)) {
    throw new RiskError(`pair not whitelisted: ${check.pair}`, 'PAIR_NOT_WHITELISTED');
  }

  // 2. Circuit breaker (EXEC-01 + D-03)
  const realizedToday = await breaker.realizedPnlSinceUtcMidnight();
  if (realizedToday <= -2.00) {
    throw new RiskError(
      `daily loss circuit breaker tripped: ${realizedToday.toFixed(2)} USD`,
      'CIRCUIT_TRIPPED',
    );
  }

  // 3. minNotional check (EXEC-04) — market orders use quoteAmountPrecisionMarket
  const info = await spot.fetchExchangeInfo(check.pair);
  const minNotional = Number(info.quoteAmountPrecisionMarket);
  if (check.notionalUsdt < minNotional) {
    throw new RiskError(
      `notional ${check.notionalUsdt} < minNotional ${minNotional}`,
      'BELOW_MIN_NOTIONAL',
    );
  }

  // 4. 2*minNotional safety margin: entry + (would-be) exit both need to fit
  const balance = await balanceCache.usdtFree();
  if (2 * minNotional > balance) {
    throw new RiskError(
      `2*minNotional (${2*minNotional}) exceeds available balance (${balance}) — risks orphan position`,
      'INSUFFICIENT_BALANCE',
    );
  }
}
```

**Sources:**
- MEXC exchangeInfo fields (verified 2026-04-18): https://www.mexc.com/api-docs/spot-v3/market-data-endpoints — `baseSizePrecision`, `quoteAmountPrecision`, `quoteAmountPrecisionMarket`, `makerCommission`, `takerCommission`, `tradeSideType`.
- CLAUDE.md constraint: $10 bankroll implies very tight balance check.

### Pattern 3: Risk Manager as Pure-Function Synchronous Gate

**What:** `risk-manager.ts` exports one pure function `ensureOrderPossible(order, state)` that throws `RiskError` with an enum code. NO side effects. Called inline from the executor's `approvals.decided` handler BEFORE any network call.

**When to use:** Before every order placement. After approval, before `MEXCSpotClient.placeMarketBuy`.

**Why this works:** A pure function is trivial to unit-test (mock the state dependencies, assert throw/no-throw), can't be bypassed by accident, and fails fast. Matches ARCHITECTURE.md §5 "Risk Manager" contract: "Pure function over Redis-held portfolio state; idempotent."

**Anti-pattern to reject:** Embedding risk checks inside `MEXCSpotClient.placeMarketBuy` — violates the "client just makes calls, doesn't enforce business rules" principle and makes the client untestable without risk-manager mocks.

### Pattern 4: Executor as Redis Streams Consumer Group Member

**What:** The executor process joins consumer group `executor-v1` on stream `approvals.decided`, reads with `XREADGROUP GROUP executor-v1 <consumer> BLOCK 5000 COUNT 10 STREAMS approvals.decided >`, filters to `approved:true`, runs through risk manager + place-order + XACK. On startup, FIRST processes any pending-but-unacknowledged entries via `XREADGROUP ... STREAMS approvals.decided 0` (crash recovery).

**When to use:** The single subscription path. No other code reads `approvals.decided`.

**Why this works:** Redis Streams consumer groups give at-least-once delivery. A process crash mid-handling leaves the entry in the Pending Entries List (PEL); on reboot the executor reads PEL entries first (with ID `0`), replays them (idempotency key prevents duplicate MEXC orders), and acks. Only then does it move to `>` (new entries).

**Example:**
```typescript
// packages/executor/src/executor.ts

const STREAM = 'approvals.decided';
const GROUP = 'executor-v1';

export async function startExecutor(
  redis: Redis,
  handler: (event: ApprovalDecided) => Promise<void>,
): Promise<() => Promise<void>> {
  const consumerName = `executor-${process.pid}-${Date.now()}`;

  // Idempotent group creation - XGROUP CREATE with MKSTREAM creates the stream
  // if it doesn't exist; BUSYGROUP error means the group already exists, which
  // is fine.
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('BUSYGROUP')) throw err;
  }

  let stopping = false;

  // Phase 1: crash recovery — drain PEL first with ID '0'
  await drainPendingEntries(redis, GROUP, consumerName, handler);

  // Phase 2: main loop — new entries via '>'
  const loop = (async () => {
    while (!stopping) {
      // BLOCK for 5s; the timeout lets us check `stopping` for graceful shutdown.
      const entries = await redis.xreadgroup(
        'GROUP', GROUP, consumerName,
        'COUNT', 10,
        'BLOCK', 5000,
        'STREAMS', STREAM, '>',
      );
      if (!entries) continue;  // block timeout

      for (const [, messages] of entries as Array<[string, Array<[string, string[]]>]>) {
        for (const [id, fieldsKV] of messages) {
          const event = parseApprovalDecided(fieldsKV);
          try {
            if (event.approved) await handler(event);
          } catch (err) {
            // Log + XACK with a dead-letter flag elsewhere; DO NOT re-throw —
            // an uncaught error kills the loop and silently wedges the executor.
            log.error({ err, id, event }, 'executor handler failed');
          }
          await redis.xack(STREAM, GROUP, id);
        }
      }
    }
  })();

  // Graceful shutdown: the BLOCK means we need a way to interrupt. Use a
  // separate connection for the consumer loop; shutdown calls .disconnect()
  // on that connection, which terminates the blocked XREADGROUP immediately.
  const stop = async () => {
    stopping = true;
    redis.disconnect();  // unblocks XREADGROUP; loop exits on next iteration
    await loop;
  };
  return stop;
}

async function drainPendingEntries(
  redis: Redis,
  group: string,
  consumer: string,
  handler: (event: ApprovalDecided) => Promise<void>,
): Promise<void> {
  // Reading with STREAMS STREAM 0 returns PEL entries owned by this consumer.
  // For Phase 2 single-consumer executor, the crash-recovery pattern is
  // sufficient. Multi-consumer XCLAIM pattern is deferred to Phase 10.
  const entries = await redis.xreadgroup(
    'GROUP', group, consumer,
    'STREAMS', STREAM, '0',
  );
  if (!entries) return;
  for (const [, messages] of entries as Array<[string, Array<[string, string[]]>]>) {
    for (const [id, fieldsKV] of messages) {
      const event = parseApprovalDecided(fieldsKV);
      if (event.approved) {
        // Idempotency key in `newClientOrderId` means re-running is safe:
        // if the order already fired, MEXC will reject the duplicate → we ack.
        try { await handler(event); } catch (err) { log.error({ err, id }, 'PEL replay failed'); }
      }
      await redis.xack(STREAM, group, id);
    }
  }
}
```

**Critical detail:** The executor uses a DEDICATED ioredis connection for the consumer loop — not the app's main connection. Reason: `BLOCK 5000` ties up that connection for the entire block window; sharing would stall every other Redis command. Factory: `const consumerRedis = createRedis()` at startup; `disconnect()` on shutdown.

**Sources:**
- Redis XREADGROUP reference: https://redis.io/docs/latest/commands/xreadgroup/ (verified 2026-04-18; available since Redis 5.0.0, matches project's portable Redis 5.0.14).
- ioredis Streams support: https://github.com/redis/ioredis (README confirms "Streams are fully supported" + 100% TS).

### Pattern 5: Panic Sequence — Cancel, Flatten, Freeze (in that order)

**What:** `pnpm panic` CLI runs a fixed 4-step sequence that moves the system into a **frozen + flat** state regardless of what it finds.

**When to use:** Operator command, not automatic. One entry point: the CLI script writes the armed=false flag AND invokes the cancel+flatten routine in-process (no Redis pub-sub latency).

**Why this works:** Each step is idempotent. If the CLI crashes at step 2, re-running completes it. The order matters: freeze-first would leave open orders unclosed if the flatten step fails; cancel-first ensures no new entries land while we're flattening.

**Example:**
```typescript
// packages/executor/src/panic.ts

const PAIR = 'ETHUSDT';

export async function panic(
  spot: MEXCSpotClient,
  redis: Redis,
  log: Logger,
): Promise<PanicReport> {
  const report: PanicReport = { cancelled: [], flattenedQty: 0, frozen: false };

  // Step 1: Freeze immediately to prevent race with approvals.decided consumer
  // (if the executor is running in another process concurrently, setting armed=false
  // NOW prevents new orders landing while we cancel + flatten).
  await redis.set('executor:armed', 'false');
  report.frozen = true;
  log.warn({ pair: PAIR }, 'panic: armed=false set');

  // Step 2: Cancel all open orders on the pair (idempotent - if none exist, returns [])
  const cancelled = await spot.cancelAllOrders(PAIR);
  report.cancelled = cancelled.map(c => c.origClientOrderId);
  log.warn({ count: report.cancelled.length }, 'panic: cancelled open orders');

  // Step 3: Read current position via fetchBalance (spot "position" = non-zero ETH free+used)
  const bal = await spot.getAccountInfo();
  const ethTotal = (bal.total as Record<string, number>).ETH ?? 0;

  if (ethTotal > 0) {
    // Step 4: Market-sell the full ETH position with a panic-scoped clientOrderId
    // (so it's distinguishable in the ledger later). Idempotency key uses timestamp
    // only — this is an operator-initiated action, not a replay.
    const panicCoid = `panic-${Date.now().toString(16)}`;
    const sell = await spot.placeMarketSell({
      symbol: PAIR,
      clientOrderId: panicCoid,
      quantity: String(ethTotal),
    });
    report.flattenedQty = ethTotal;
    log.warn({ quantity: ethTotal, clientOrderId: sell.clientOrderId }, 'panic: position flattened');
  }

  // Step 5: Persist state to SQLite (survives Redis eviction/restart)
  // — handled by the caller via ledger.writeExecutorState('armed', 'false').

  return report;
}
```

**What if the market-close partially fills during panic?** MEXC returns a `status: 'PARTIALLY_FILLED'` response. Phase 2 logs this + records the `executedQty` in the ledger, but does NOT retry — the operator can re-run `pnpm panic` which is idempotent (cancel storm is a no-op if nothing's open; flatten is a no-op if balance.ETH is now 0). Acceptable for Phase 2 scope.

**State-write timing:** `executor:armed=false` lands BEFORE the cancel storm. The reason: if the executor is running in another Node process (during migration between Phase 2 and Phase 5's reconciler), we want the `armed=false` flag to stop that process from placing new orders MID-cancel — which would race and leave the panic stale. "Fail closed, as fast as possible" = freeze first.

### Pattern 6: Redis Key Conventions + SQLite Backup

**What:** All executor state lives under the `executor:` prefix. Redis is the hot read path; SQLite `executor_state` table is the durability backstop. Both written atomically on state change.

**Key schema:**

| Redis Key | Type | TTL | Contents | SQLite Mirror |
|-----------|------|-----|----------|---------------|
| `executor:armed` | string | none | `"true"` or `"false"` | `executor_state.key='armed'` |
| `executor:orders:<clientOrderId>` | hash | 48h | `{pair, side, qty, status, submittedAt, exchangeOrderId}` | `orders` table (PK=clientOrderId) |
| `executor:positions:<pair>` | hash | none | `{qty, avgEntryPrice, updatedAt}` | `positions` view (computed from fills) |
| `executor:breaker:<utc-date>` | hash | 48h | `{realized_usd, trade_count}` | `realized_pnl.date=YYYY-MM-DD` |
| `executor:ratelimit:spot-orders` | list | 10s | ring buffer of request timestamps | n/a |
| `executor:consumer:last-ack-id` | string | none | most recent XACK'd stream ID (informational) | n/a |

**Stale-state detection at boot (D-05):**
```typescript
// apps/core/src/boot.ts — Step 10
async function checkStaleState(redis: Redis): Promise<void> {
  // SCAN (not KEYS — KEYS is O(N) blocking on production)
  const stream = redis.scanStream({
    match: 'executor:positions:*',
    count: 100,
  });
  let found = false;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (keys: string[]) => { if (keys.length > 0) found = true; });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  if (found) {
    throw new BootError(
      'stale state detected — run `pnpm reconcile` before starting',
      'pre-flight',
    );
  }

  // Also check orders:*
  const ordersStream = redis.scanStream({ match: 'executor:orders:*', count: 100 });
  await new Promise<void>((resolve, reject) => {
    ordersStream.on('data', (keys: string[]) => { if (keys.length > 0) found = true; });
    ordersStream.on('end', () => resolve());
    ordersStream.on('error', reject);
  });
  if (found) {
    throw new BootError(
      'stale state detected — run `pnpm reconcile` before starting',
      'pre-flight',
    );
  }
}
```

**Why SCAN, not KEYS:** `KEYS executor:positions:*` is O(N) and blocks the Redis event loop. SCAN is cursor-based and yields. For this small-scale bot it doesn't matter in practice, but it's the right habit — matches Plan 01-03's discipline.

**Alternative (simpler):** Maintain a single status key `executor:state-summary` that's updated whenever a position/order is added or removed. Boot reads the one key and checks a counter. Saves the SCAN. **Recommendation:** planner chooses. The single-key pattern is cleaner; SCAN is more robust if other code directly writes `executor:orders:*` keys without going through the atomic helper.

### Pattern 7: Idempotency Key Generation

**What:** `newClientOrderId = sha256(signalId + approvalTs).toString('hex')` — deterministic, reproducible across process restarts.

**Why this works:** The signal_id (UUID v4 per D-01) and approval_timestamp (epoch ms from `approvals.decided` event) together uniquely identify every (signal → approval) pair. A process crash mid-submission doesn't break idempotency: on restart, the PEL replay re-computes the same sha256, MEXC rejects the duplicate, we XACK and move on.

**Length + character constraints:**
- SHA-256 hex output: **64 characters**, hex alphabet [0-9a-f].
- MEXC's `newClientOrderId` field documentation does NOT publish an explicit max length or character set (verified 2026-04-18 — docs silent). Empirically, Binance-style exchanges (MEXC's API shape lineage) allow up to 36-40 chars alphanumeric.
- **Safe recommendation:** truncate to **32 hex chars** — fits any conservative max-length ceiling, still has 128 bits of entropy (collision probability < 2^-64 at scale of 2^32 orders = astronomical).

**Example:**
```typescript
// packages/executor/src/idempotency.ts
import { createHash } from 'node:crypto';

/**
 * Deterministic idempotency key for a (signal, approval) pair.
 * Matches SUMMARY.md Pitfall 5's spec: sha256(signal_id + approval_timestamp).
 *
 * Output: 32-char hex substring (128 bits entropy).
 * MEXC's max length is not documented; 32 is empirically safe.
 */
export function makeClientOrderId(signalId: string, approvalTsMs: number): string {
  const input = `${signalId}:${approvalTsMs}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
```

**Open question:** If 32 hex chars is rejected by MEXC with an "ID too long" error during the live trade proof (D-04), the planner should add a fallback that tries progressively shorter lengths (28, 24, 20) — but this is a test-time discovery, not a design-time concern. **Default: 32 hex chars.**

### Pattern 8: Dynamic Fee Rate with Cache

**What:** Pull fee rate from `exchangeInfo.takerCommission` (per-symbol) on first use, cache for 5 minutes, re-fetch on cache miss. For Phase 2 use the taker rate only (market orders are always takers).

**Why this works:** MEXC's fee rate is a per-VIP-tier number but is also exposed per-symbol in `exchangeInfo.takerCommission`. Phase 2 needs it purely for sanity checking (`requiredEdge = 2*fee + slippage`). Caching 5 min is the right trade-off: fees don't change often; a slightly-stale value costs nothing.

**Anti-pattern:** hardcoding `fee = 0` because of the current zero-fee promo. Pitfall 12 explicitly calls this out — promo excludes regions, changes without warning.

```typescript
// packages/executor/src/fee-cache.ts

interface FeeCacheEntry { takerBps: number; fetchedAt: number; }
const FEE_CACHE = new Map<string, FeeCacheEntry>();
const TTL_MS = 5 * 60 * 1000;

export async function getTakerFeeBps(spot: MEXCSpotClient, symbol: string): Promise<number> {
  const cached = FEE_CACHE.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.takerBps;

  const info = await spot.fetchExchangeInfo(symbol);
  // takerCommission is sometimes a decimal like "0.002" (= 20 bps = 0.2%),
  // sometimes in the info block as an integer bps count. Zod schema normalizes.
  const takerBps = Number(info.takerCommission) * 10_000;  // 0.002 -> 20 bps
  FEE_CACHE.set(symbol, { takerBps, fetchedAt: Date.now() });
  return takerBps;
}
```

### Anti-Patterns to Avoid

- **Placing an order without an idempotency key** — EXEC-02. Even a "test" order. The method signature should make `clientOrderId` non-optional at the TS level: `function placeMarketBuy(p: { ... clientOrderId: string; ... })` (no `?`).
- **Calling ccxt directly from executor code** — only through `MEXCSpotClient` methods. CCXT import remains in exactly 2 files.
- **Sharing the ioredis connection between the XREADGROUP consumer loop and other commands** — the `BLOCK 5000` will stall the shared client. Dedicated consumer connection.
- **Optimistic ledger write before MEXC accepts** — write `submitted` status row, then update to `accepted` or `rejected` after the MEXC response. Do not write `accepted` before you get the 200 back.
- **Cancelling by `orderId` only** — MEXC returns `orderId` on placement, but on retry after a network blip the caller may not have the id. Always support `origClientOrderId`-based cancellation. Phase 2 uses origClientOrderId exclusively.
- **Using `KEYS`** to enumerate Redis keys at runtime. Use SCAN. Phase 1 doesn't have any KEYS calls; Phase 2 must preserve that.
- **Fire-and-forget Redis writes** in the order-submission path. `.set(...)` returns a promise; `await` it before moving on. A missed await = lost state on a race.
- **Executor handler that throws unhandled inside the consumer loop** — one uncaught error kills the while loop and silently wedges order processing. Wrap every handler invocation in try/catch and log+XACK on failure (the idempotency key is the backstop for "was this already fired").

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| **MEXC HMAC signing** for order placement | Custom `node:crypto` HMAC + header assembly | `ccxt.mexc.createOrder()` | Phase 1 already uses ccxt; signing is handled internally; 700002 signature errors are a 3-hour debug the library avoids. Known pitfall (PITFALLS.md Pitfall 1). |
| **Symbol format conversion** `'ETHUSDT' ↔ 'ETH/USDT'` | Hand-maintained lookup table | `ccxt.market(...).id` / loaded markets | ccxt does this correctly including edge cases. Hand-rolling = silent bug when a symbol has non-standard separator. |
| **Redis Streams consumer group lifecycle** | Custom polling on `xread` + manual offset tracking | `XREADGROUP` with consumer groups (native ioredis) | PEL semantics + ack are 5 lines with the native command, 500 lines of bugs otherwise. Pattern 4 above. |
| **Distributed idempotency** for "did I already fire this order?" | Redis SETNX + TTL + check-then-send dance | Just use `newClientOrderId` — MEXC rejects duplicates server-side | MEXC is the idempotency authority. Our key is the input; MEXC's rejection is the mechanism. Double-work otherwise. |
| **UUID v4 generation** | Custom RNG + bit-twiddling | `crypto.randomUUID()` from Node 22 built-in | Node 22 includes `crypto.randomUUID` — zero dep, RFC 4122 compliant. |
| **SHA-256 hashing** for clientOrderId | Custom hash | `crypto.createHash('sha256')` (node:crypto) | Built-in, fast, proven. |
| **Date arithmetic for "since UTC midnight"** | String-concat date math | `new Date(Date.UTC(y, m, d, 0, 0, 0, 0)).getTime()` | Simple built-in; no dep needed. |
| **CLI argument parsing** for 2–3 flags | `process.argv` string split | `arg` (~2KB) OR hand-rolled loop for just `--side` + `--notional` | Trivial case. No Commander/yargs/meow dep. |
| **Windows service management for Redis survival** | Service wrapper script | Matt manually relaunches `redis-server.exe` after reboot (documented in `docs/setup-windows.md`) | Plan 01-06 decision: portable redis is user-initiated. Phase 2 inherits. |
| **Graceful Redis reconnect during XREADGROUP BLOCK** | Custom reconnect logic | ioredis's built-in auto-reconnect + `disconnect()` for shutdown | ioredis handles reconnect automatically; manual shutdown = `.disconnect()` unblocks XREADGROUP immediately. |

**Key insight:** The MEXC spot write path has zero "new problem" surface — every primitive (HMAC, streams, hashing, timestamps) is either in ccxt or Node built-ins. The ONLY novel code in Phase 2 is (a) the risk manager's business logic, (b) the panic sequence, and (c) the CLI harnesses. Everything else is plumbing through existing libraries.

## Runtime State Inventory

Phase 2 is GREENFIELD — it adds new code paths, Redis keys, SQLite tables, and CLI scripts that don't exist today. It does NOT rename, refactor, or migrate any existing artifact. Therefore no runtime state inventory is required.

**Verified:**
- No existing Redis keys under `executor:*` (state-management for the executor is entirely new).
- No existing SQLite tables named `orders`, `fills`, `realized_pnl`, or `executor_state` (the current DB file exists but is empty per Plan 01-03's smoke test).
- No existing CLIs named `panic`, `arm`, `place-order`, or `reconcile` in `package.json`.
- No existing string or identifier is being renamed.

**Nothing to inventory — skip to Environment Availability.**

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Entire phase | ✓ | 24.13.1 per `.nvmrc` | — |
| pnpm | Monorepo workspace management | ✓ | 9.12 | — |
| Redis | Streams + executor state + circuit breaker | ✓ | 5.0.14 (portable, `%USERPROFILE%\tools\redis-portable\redis-server.exe`) | **Must be running before `pnpm place-order`.** `docs/setup-windows.md` documents the launch command. Redis 5.0.14 supports XREADGROUP (req 5.0.0+) and CONFIG GET. Does NOT support XREADGROUP's CLAIM option (req 8.4+) — workaround: XREADGROUP with ID `0` for PEL replay (Pattern 4). |
| SQLite (better-sqlite3) | Ledger tables | ✓ | 12.0 | — |
| MEXC spot API (api.mexc.com) | Order placement + exchangeInfo | ✓ | v3 | — (MEXC is the exchange; no fallback is meaningful) |
| MEXC spot credentials (WinCred) | HMAC signing | ✓ | 3 secrets provisioned per Plan 01-06 | — |
| MEXC futures API | NOT REQUIRED in Phase 2 — futures ping remains, but no write | n/a | n/a | — |
| Telegram bot | NOT REQUIRED in Phase 2 (deferred to Phase 3) | n/a | n/a | — |
| ETH balance on MEXC (for D-04 live-trade proof) | Phase 2 end-of-phase test | **⚠️ Matt must fund** | — | Defer D-04 live-trade if balance < 2*minNotional on the day of execution; spec permits this per CONTEXT D-04 gating `MEXC_LIVE=1`. |
| Internet connectivity | All MEXC calls | ✓ on Matt's box | — | Fail-closed: `pnpm place-order` will exit 1 with a network error. |
| IP whitelist match on MEXC key | First live order | **⚠️ Matt's current public IP must match the whitelist entered into WinCred during setup** | — | Boot already warns on mismatch (Plan 01-05 integration). If mismatch at runtime, MEXC rejects with `700007` auth error — executor surfaces the error cleanly. |

**Missing dependencies with no fallback:** None — all infrastructure is local + existing.

**Missing dependencies with fallback:**
- **MEXC ETH balance** (for D-04 live trade): if under-funded on the day, defer the live proof (skip `MEXC_LIVE=1` step, mark D-04 as pending, proceed to Phase 3). Matt's call.

**Environment-specific gotcha:** The bash fork-exhaustion blocker (STATE.md "Known Blockers") is STILL ACTIVE. Every Phase 2 commit must use `git -c core.hooksPath=/dev/null --no-verify`. Subprocess execution via Desktop Commander / Windows-MCP PowerShell.

## Common Pitfalls

### Pitfall 1: Duplicate newClientOrderId — MEXC's behavior is UNDOCUMENTED

**Severity:** MEDIUM (project can work around; EXEC-02 verification method depends on it)
**What goes wrong:** Phase 2's EXEC-02 success-proof is "submit the same clientOrderId twice and assert MEXC rejects the second." But MEXC's official v3 docs (verified 2026-04-18) **do NOT publish a specific error code** for duplicate clientOrderId. Empirically, Binance-style exchanges return `-2010 "Duplicate order sent"` (Binance's literal code). MEXC is API-compatible with Binance spot but their error-code table is smaller; the match isn't guaranteed.

**Why it happens:** MEXC API docs are known to be incomplete (PITFALLS.md Pitfall 1 mentions this generally). The 700004 code in MEXC's published table covers "missing orderId/origClientOrderId for cancel" but not duplicate placement.

**How to avoid:**
- The **live-trade proof at end of Phase 2** (D-04) is the source of truth. Phase 2 executes the proof and records the **actual observed error code + message** in `02-SUMMARY.md`. Future code treats that value as a constant.
- Meanwhile: implementation catches ANY error from `placeMarketBuy` that includes the substring `"duplicate"` OR any error with code in the set `{-2010, 30001, 30002, 30003}` (observed MEXC error codes related to order placement) and maps to `DUPLICATE_CLIENT_ORDER_ID` for the caller.
- **Plan the test to CAPTURE the error, not ASSERT a specific code.** Integration test asserts "second submit throws with a code we expect to indicate duplicate" and logs the actual code+message.

**Warning signs:**
- Duplicate submission silently succeeds = MEXC accepted it as a new order = EXEC-02 INVALIDATED. The test harness must verify this by `fetchOpenOrders` showing exactly ONE order with that clientOrderId.

**Phase to address:** Phase 2 end-of-phase live test (D-04).

### Pitfall 2: MEXC Spot does NOT natively support server-side stop-loss attached via REST v3 API — EXEC-03 BLOCKER

**Severity:** PROJECT-KILLER (for EXEC-03 as specified); PAINFUL (for Phase 2 as a whole if we don't resolve it)
**What goes wrong:** The Phase 1 research (`PITFALLS.md` #6, `SUMMARY.md` Phase 2 section) references "`triggerPrice` orders" for server-side stops. **This assumption is WRONG for MEXC spot v3 REST API.** Three independent sources confirm:
1. **MEXC's own `POST /api/v3/order` docs** (verified 2026-04-18) list ONLY `LIMIT | LIMIT_MAKER | MARKET | IOC | FOK` as supported order types. No `STOP_LOSS`, no `STOP_LOSS_LIMIT`, no `TAKE_PROFIT`, no `triggerPrice` parameter.
2. **CCXT's `mexc.ts` feature map** (verified 2026-04-18) sets `'triggerPrice': false` under spot features. Triggers are ONLY supported under the `forDerivs` (futures) config.
3. **GitHub issue ccxt/ccxt#22104** ("Mexc can't put a stop loss order", 2024-04-09, still open) documents the user attempting `triggerPrice`/`stopPrice` parameters and the MEXC API silently returning a regular LIMIT order with those fields ignored.

MEXC's web UI offers "TP/SL" and "OCO" features for spot — but these are UI-only and not exposed through the public v3 REST API. MEXC's internal futures API has a separate "plan order" mechanism, but that's for contracts, not spot.

**Why it happens:** Third-party docs + AI knowledge conflate MEXC spot's UI features with API capabilities. The original assumption in PITFALLS.md likely generalized from futures, where MEXC does support `triggerPrice`.

**How to avoid (THREE OPTIONS — needs user decision):**

**Option A — Defer EXEC-03 to Phase 6 (Futures Write)**
- Phase 2 ships WITHOUT server-side stops. EXEC-03 is REMAPPED from "every entry has server-side stop" to "Phase 2 entries are constrained to amounts MEXC spot can't run adverse on $10" (i.e., minNotional sizing is the implicit stop — worst case the whole notional is lost, which at minNotional ≈ $5 is bounded).
- Phase 6 adds futures write + native `triggerPrice` support → Phase 6 satisfies EXEC-03 for all leverage-bearing positions.
- **Pro:** Zero engineering cost in Phase 2. Ships fastest.
- **Con:** Phase 2's live-trade-proof (D-04) has NO stop. The panic-sequence is now the only guard rail. That's acceptable given D-04's "immediately panic-cancel" step, but it means ANY bug in `pnpm panic` = real money at risk.

**Option B — Client-side stop-loss (polling mark price; executor fires market SELL when threshold crossed)**
- Phase 2's executor ALSO runs a "stop watcher" subtask that polls ETHUSDT's last-trade price every 5s (via `fetchTicker` or the public WS trades stream — either works for $10 scale) and fires a market SELL if `lastPrice < entryPrice * (1 - STOP_LOSS_PCT)` where `STOP_LOSS_PCT = 0.01` (1%).
- State: `executor:stop-watcher:<clientOrderId> = {entryPrice, stopPrice}` stored in Redis.
- **Pro:** EXEC-03 satisfied in spirit — every entry has an associated stop. Matches the PITFALLS.md Pitfall 6 mitigation (laptop sleep = orphan orders) PARTIALLY (client-side stop fails if the process is down; but Phase 5's reconciler catches up on wake).
- **Con:** Client-side stops are explicitly called out as fiction in PITFALLS.md ("Client-side stops are fiction"). If the executor process dies unclean, the stop is gone. Ship this only if Phase 2's D-04 live-trade proof is the only real-money trade until Phase 5 reconciler ships.

**Option C — OCO via MEXC's private OCO endpoint (if it exists on v3)**
- Some sources (MEXC Learn articles) mention OCO for spot. Research was inconclusive about whether it's reachable via v3 REST or only via the UI and a private endpoint.
- **Pro:** If it works, truly server-side. Full EXEC-03 compliance.
- **Con:** Undocumented-in-v3 = unreliable and brittle. Not recommended for Phase 2 scope.

**RECOMMENDATION to planner (and ultimately to Matt):** **Option A + tighter panic discipline.** The D-04 live-trade proof is `place-order → panic-cancel within 30 seconds`. There's no realistic price-move window where a stop would matter in that sequence. For Phase 5+ actual live signal-driven trading, re-evaluate: either (i) accept 1% max loss as the implicit stop equivalent to minNotional sizing, (ii) implement Option B with reconciler safety net, or (iii) defer live spot trading to Phase 6 and go straight to futures-with-server-stops.

**EXEC-03 must be re-worded in REQUIREMENTS.md** to reflect whichever option is chosen. The planner's Step 1 should flag this to Matt BEFORE writing any plans.

**Warning signs:**
- Plan 02-XX includes a "placeStopLossLimitOrder" method — wrong; it cannot exist on MEXC spot.
- Test `assert order.type === 'STOP_LOSS_LIMIT'` — wrong; MEXC spot never returns that.

**Phase to address:** Phase 2 (the decision must happen before planning). Verification of the chosen option: D-04 live trade shows the actual order-protection behavior (whether via panic, polling watcher, or nothing).

### Pitfall 3: CCXT market-buy price requirement (linked to Plan 01-04 discovery)

**Severity:** MINOR (trivial to fix, easy to miss)
**What goes wrong:** `exchange.createOrder('ETH/USDT', 'market', 'buy', amount)` in CCXT's default MEXC config tries to compute a notional and may require a `price` argument. If the planner copies a "market buy" example from Binance-style docs, it crashes with `AssertionError: assert precision is not None` or `createMarketBuyOrderRequiresPrice`.

**Why it happens:** CCXT historically required `price` on market buys (many exchanges' APIs compute notional client-side). MEXC does NOT need it — but CCXT's MEXC driver keeps the safety flag on by default.

**How to avoid:**
- Set `options.createMarketBuyOrderRequiresPrice = false` when constructing the `ccxt.mexc(...)` instance, OR
- Pass `params.quoteOrderQty = cost` on market BUY (spec'd above in Pattern 1).
- Recommendation: **both**. Belt + suspenders. Exact option in client creation:
  ```typescript
  const exchange = new ccxt.mexc({
    ...,
    options: {
      defaultType: 'spot',
      recvWindow,
      createMarketBuyOrderRequiresPrice: false,  // Phase 2 addition
      createMarketBuyOrderWithCost: true,         // Phase 2 addition
    },
  });
  ```

**Warning signs:** `ccxt.BadRequest` with "createMarketBuyOrderRequiresPrice" substring.

**Phase to address:** Phase 2, task "add write methods to MEXCSpotClient" — the existing `create()` factory needs the two new options.

### Pitfall 4: Redis Streams PEL growth unbounded (cross-ref PITFALLS.md Pitfall not enumerated)

**Severity:** MINOR at $10 scale; PAINFUL at 1 week of running
**What goes wrong:** Every XADD to `approvals.decided` without XADD MAXLEN and without XACK-ing consumed entries grows the stream indefinitely. Redis memory creeps up. At the 256MB Phase 1 cap (`--maxmemory 256mb --maxmemory-policy noeviction`), eventually Redis rejects writes → `OOM command not allowed`.

**Why it happens:** PEL defaults are unbounded.

**How to avoid:**
- **Every XADD to a stream uses `MAXLEN ~ <count>` (approximate trim):**
  ```
  redis.xadd('approvals.decided', 'MAXLEN', '~', '1000', '*', ...)
  ```
- XACK on every successfully-processed entry (the pattern in Example 4 above already does this).
- Periodic XTRIM in a cron or on shutdown: `XTRIM approvals.decided MAXLEN ~ 1000`.

**Phase to address:** Phase 2, executor consumer loop + test harness producers.

### Pitfall 5: Circuit breaker date-boundary race (UTC vs local time)

**Severity:** PAINFUL (could either trip prematurely or fail to trip)
**What goes wrong:** If the breaker query uses `WHERE closed_at >= DATE('now')` in SQLite — that's LOCAL TIME. A trade closed at 11pm Denver = 6am UTC "tomorrow" → the breaker's "today" window misses it (if Denver) or double-counts (if UTC). Either way, the $2 breaker is wrong.

**Why it happens:** SQLite's `DATE('now')` is local by default; `datetime('now', 'utc')` is explicit UTC.

**How to avoid:**
- Use **UTC exclusively** (matches CONTEXT D-03 + PITFALLS section on time accounting):
  ```sql
  -- In breaker.realizedPnlSinceUtcMidnight():
  SELECT COALESCE(SUM(realized_usd), 0) AS total
  FROM realized_pnl
  WHERE closed_at >= strftime('%s', 'now', 'start of day') * 1000
    AND closed_at < strftime('%s', 'now', 'start of day', '+1 day') * 1000;
  ```
  (Assumes `closed_at` stored as epoch ms. Alternative: store as ISO string `'2026-04-18T14:35:00Z'` and compare lexicographically.)
- Store all timestamps as epoch-ms UTC (`Date.now()`). Render for display only.

**Phase to address:** Phase 2, `realized_pnl` schema + breaker query.

### Pitfall 6: Cancel-storm race in panic sequence

**Severity:** PAINFUL (rare but observable)
**What goes wrong:** `cancelAllOrders('ETHUSDT')` + immediate `fetchBalance` → the fetchBalance may race the cancel response if cancels are still being processed server-side. Balance shows "free ETH" that's still locked in the (just-now-cancelled) open order. `placeMarketSell` with that stale quantity over-sells, returns partial or insufficient-balance error.

**Why it happens:** MEXC's `cancelAllOrders` returns "cancel accepted" before the order is fully unwound from the matching engine.

**How to avoid:**
- After `cancelAllOrders`, WAIT for `fetchOpenOrders(pair)` to return empty before sizing the flatten. Short polling, max 5s.
- ```typescript
  await spot.cancelAllOrders(PAIR);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const open = await spot.fetchOpenOrders(PAIR);
    if (open.length === 0) break;
    await sleep(200);
  }
  const bal = await spot.getAccountInfo();  // now safe to size the flatten
  ```
- Idempotency key on the flatten order still protects against retry.

**Phase to address:** Phase 2, `panic.ts` sequence.

### Pitfall 7: `fetchOpenOrders` without symbol → different behavior across ccxt versions

**Severity:** MINOR
**What goes wrong:** `ccxt.exchange.fetchOpenOrders()` (no args) returns "all open orders across all pairs" in some ccxt versions; in others, throws `ArgumentsRequired`. MEXC's ccxt driver has `symbolRequired: true` (verified in ccxt/mexc.ts feature map) — always pass a symbol.

**How to avoid:** Always pass `symbol`. For the stale-state reconciler, iterate the whitelist (which in Phase 2 is just `['ETHUSDT']`) — one call per pair.

**Phase to address:** Phase 2, any code calling `fetchOpenOrders`.

### Pitfall 8: Partial fill on market order — status = 'PARTIALLY_FILLED'

**Severity:** MINOR-to-PAINFUL depending on position
**What goes wrong:** A market order fills partially and the rest expires/cancels. The return payload's `status` field is `'PARTIALLY_FILLED'` but `executedQty < origQty`. Phase 2 code might write `status: 'FILLED'` to the ledger based on the existence of a response, missing the partial.

**How to avoid:**
- Ledger writes store the raw response JSON (`raw_response` column) + the parsed status.
- Position update uses `executedQty`, not `origQty`.
- Circuit breaker credit/debit uses `cumulative_quote_qty - fee * cumulative_quote_qty` (for buys) from the fill data, not the requested notional.
- For Phase 2's D-04 proof, partial fill would still satisfy the EXEC-02 duplicate-rejection test (the dupe is rejected regardless of fill status on the first submit).

**Phase to address:** Phase 2, ledger writer + position state update.

### Pitfall 9: `ioredis` consumer loop connection reuse kills other commands

**Severity:** PAINFUL (bug is silent until a second command fires)
**What goes wrong:** A single `Redis` client shared between the XREADGROUP BLOCK loop and `SET`/`GET` commands: while BLOCK is pending, nothing else works. Every other Redis call sits in the queue until the block expires.

**How to avoid:** **Dedicated consumer connection.** Two separate `createRedis()` calls at executor startup:
```typescript
const mainRedis = createRedis();       // used by risk-manager, state reads/writes, etc.
const consumerRedis = createRedis();   // used ONLY by the XREADGROUP loop
```
On shutdown: `consumerRedis.disconnect()` first (unblocks the loop), then `await loop`, then `mainRedis.quit()`.

**Phase to address:** Phase 2, executor startup + graceful-shutdown flow.

### Pitfall 10: Graceful shutdown doesn't persist in-flight order state

**Severity:** PAINFUL (happens on Ctrl+C mid-order)
**What goes wrong:** Executor handler is midway through `placeMarketBuy` (MEXC call in-flight) when SIGINT hits. Node closes the process, MEXC still processes the order. Redis ledger has no record. Next boot: Redis "clean" but MEXC has an open order.

**How to avoid:**
- Write "submitted" ledger row BEFORE the MEXC call, "accepted"/"rejected" AFTER.
- On shutdown, don't hard-kill — issue a soft signal, wait up to 10s for in-flight handlers to complete, then disconnect Redis.
- Stale-state check at boot (D-05) catches the "MEXC has orders we don't" case and prompts `pnpm reconcile`.

**Phase to address:** Phase 2, boot + shutdown signal handling.

## Code Examples

### Example 1: Add `createOrder` family to MEXCSpotClient

(Already shown in Pattern 1. Key extension: the `options.createMarketBuyOrderRequiresPrice = false` addition in the `create()` factory, plus the five new write methods.)

### Example 2: Redis Streams — publishing a signal through the full pipeline (test harness)

```typescript
// apps/core/src/place-order.ts — the CLI test harness

import { createRedis } from '@kr8tiv/redis-client';
import { randomUUID } from 'node:crypto';

type PlaceOrderArgs = { side: 'buy' | 'sell'; notional: number };

async function main() {
  const args = parseArgs(process.argv);  // TODO: use arg or hand-rolled
  const redis = createRedis();
  try {
    const signalId = randomUUID();
    const now = Date.now();

    // Stage 1: signals.candidate (the "ML/rule" layer's output — Phase 4 replaces)
    const candidateId = await redis.xadd(
      'signals.candidate', 'MAXLEN', '~', '1000', '*',
      'signal_id', signalId,
      'pair', 'ETHUSDT',
      'side', args.side,
      'notional_usdt', String(args.notional),
      'source', 'test-harness',
      'ts', String(now),
    );

    // Stage 2: signals.filtered (news-veto etc.; Phase 7 replaces)
    await redis.xadd('signals.filtered', 'MAXLEN', '~', '1000', '*',
      'signal_id', signalId,
      'filter_result', 'pass',
      'ts', String(now + 1),
    );

    // Stage 3: approvals.pending (Telegram would see this in Phase 3)
    await redis.xadd('approvals.pending', 'MAXLEN', '~', '1000', '*',
      'signal_id', signalId,
      'approval_timeout_ms', '90000',  // matches Phase 3 future TTL
      'ts', String(now + 2),
    );

    // Stage 4: approvals.decided — the executor's only subscription (EXEC-09)
    const approvalTs = now + 3;
    await redis.xadd('approvals.decided', 'MAXLEN', '~', '1000', '*',
      'signal_id', signalId,
      'approved', 'true',
      'pair', 'ETHUSDT',
      'side', args.side,
      'notional_usdt', String(args.notional),
      'approval_ts', String(approvalTs),
    );

    console.log(`Signal ${signalId} emitted through full pipeline; executor should fire if MEXC_LIVE=1`);
  } finally {
    redis.disconnect();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

### Example 3: SQLite schema (DDL, PRAGMAs assumed from @kr8tiv/db)

```sql
-- packages/executor/src/schema.sql (applied via @kr8tiv/db.openDatabase + exec())

CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY,          -- our idempotency key (32 hex chars)
  exchange_order_id TEXT,                     -- MEXC's orderId (after acceptance)
  pair TEXT NOT NULL,                         -- 'ETHUSDT'
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  type TEXT NOT NULL CHECK (type IN ('market', 'limit')),  -- v1: only 'market'
  qty_base REAL,                              -- base-asset quantity (NULL for quoteOrderQty market buys)
  qty_quote REAL,                             -- quote-asset notional (NULL for qty-based sells)
  status TEXT NOT NULL CHECK (status IN ('submitted', 'accepted', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  raw_response TEXT,                          -- JSON blob of the MEXC response
  signal_id TEXT,                             -- UUID v4 from test harness / Phase 4 signal
  approval_ts_ms INTEGER,                     -- epoch-ms, for idempotency traceability
  submitted_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_submitted_at ON orders(submitted_at_ms);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_pair_status ON orders(pair, status);

CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_order_id TEXT NOT NULL REFERENCES orders(client_order_id),
  fill_id TEXT,                               -- MEXC's trade/fill ID
  qty_base REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL,
  fee_currency TEXT NOT NULL,                 -- typically 'USDT' for sells, 'ETH' for buys
  filled_at_ms INTEGER NOT NULL,
  raw_response TEXT
);
CREATE INDEX IF NOT EXISTS fills_client_order_id ON fills(client_order_id);
CREATE INDEX IF NOT EXISTS fills_filled_at ON fills(filled_at_ms);

CREATE TABLE IF NOT EXISTS realized_pnl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  close_fill_id INTEGER NOT NULL REFERENCES fills(id),
  entry_fill_id INTEGER REFERENCES fills(id),  -- nullable: first-fill entries with no match yet
  realized_usd REAL NOT NULL,                  -- signed
  closed_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS realized_pnl_closed_at ON realized_pnl(closed_at_ms);

CREATE TABLE IF NOT EXISTS executor_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
-- Seed: armed=true by default after first `pnpm arm` or reconcile
-- INSERT INTO executor_state VALUES ('armed', 'true', strftime('%s','now')*1000);

-- Positions as a VIEW (computed from fills; avoid drift)
CREATE VIEW IF NOT EXISTS positions AS
SELECT
  o.pair,
  SUM(CASE WHEN f.qty_base IS NOT NULL AND o.side = 'buy' THEN f.qty_base ELSE 0 END)
    - SUM(CASE WHEN f.qty_base IS NOT NULL AND o.side = 'sell' THEN f.qty_base ELSE 0 END) AS net_qty_base
FROM fills f
JOIN orders o ON o.client_order_id = f.client_order_id
GROUP BY o.pair;
```

**Migration strategy for Phase 5:** The schema uses `CREATE IF NOT EXISTS` idempotent DDL. Phase 5 (ledger + reconciler) extends with `ledger_events` table + `reconcile_log` table. Phase 2's schema is forward-compatible — no renames, no altered columns, just added tables. Running Phase 5's DDL on a Phase 2 DB is a no-op on existing tables + a CREATE on the new ones.

### Example 4: `pnpm panic` CLI

```typescript
// scripts/panic.ts (workspace: @kr8tiv/scripts)

import { createRedis } from '@kr8tiv/redis-client';
import { openDatabase } from '@kr8tiv/db';
import { logger } from '@kr8tiv/logger';
import { MEXCSpotClient } from '@kr8tiv/mexc-spot';
import { WindowsCredentialManagerProvider } from '@kr8tiv/secrets';
import { panic } from '@kr8tiv/executor';

async function main() {
  const log = logger.child({ cmd: 'panic' });
  const secrets = new WindowsCredentialManagerProvider();
  const spot = await MEXCSpotClient.create({ secrets });
  const redis = createRedis();
  const db = openDatabase();

  log.warn('PANIC triggered — cancelling all orders, flattening positions, freezing executor');
  try {
    const report = await panic(spot, redis, log);
    // Persist armed=false to SQLite too (durability backstop)
    db.prepare(
      'INSERT OR REPLACE INTO executor_state (key, value, updated_at_ms) VALUES (?, ?, ?)'
    ).run('armed', 'false', Date.now());

    log.warn({ report }, 'PANIC complete');
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (err) {
    log.fatal({ err }, 'PANIC FAILED — manual intervention required on MEXC UI');
    process.exit(1);
  } finally {
    redis.disconnect();
    db.close();
  }
}

main();
```

### Example 5: `pnpm arm` CLI (minimal)

```typescript
// scripts/arm.ts

import { createRedis } from '@kr8tiv/redis-client';
import { openDatabase } from '@kr8tiv/db';
import { logger } from '@kr8tiv/logger';

async function main() {
  const log = logger.child({ cmd: 'arm' });
  const redis = createRedis();
  const db = openDatabase();
  try {
    await redis.set('executor:armed', 'true');
    db.prepare(
      'INSERT OR REPLACE INTO executor_state (key, value, updated_at_ms) VALUES (?, ?, ?)'
    ).run('armed', 'true', Date.now());
    log.info('executor armed');
    console.log('Executor ARMED. Next approval will fire a real order if MEXC_LIVE=1.');
  } finally {
    redis.disconnect();
    db.close();
  }
}
main();
```

### Example 6: Boot extension — Step 10

```typescript
// apps/core/src/boot.ts — Phase 2 delta (lines inserted before "Phase 1 boot complete" log)

// Step 10: Executor state verification (EXEC-08, D-05 stale-state policy)
const hasStaleState = await checkStaleState(redis);  // see Pattern 6
if (hasStaleState) {
  log.fatal('stale state detected in Redis — run `pnpm reconcile`');
  throw new BootError(
    'stale state detected — run `pnpm reconcile` before starting',
    'pre-flight',
  );
}

// Step 11: Read armed flag (Redis primary, SQLite backup)
let armed = (await redis.get('executor:armed')) === 'true';
if (!armed) {
  // Double-check SQLite for a more-recent armed=true (in case Redis was wiped)
  const sqliteRow = db.prepare('SELECT value FROM executor_state WHERE key=?').get('armed') as { value: string } | undefined;
  if (sqliteRow?.value === 'true') {
    // SQLite says armed but Redis says otherwise → Redis lost state → refuse to start
    throw new BootError(
      'Redis and SQLite disagree on armed state — run `pnpm reconcile`',
      'pre-flight',
    );
  }
  log.warn('executor NOT armed — run `pnpm arm` to enable order placement');
} else {
  log.info('executor armed');
}

// Step 12: Start executor consumer loop (returns stop() for graceful shutdown)
const stopExecutor = await startExecutor(consumerRedis, handlerFn);
// stopExecutor is returned in BootResult so SIGINT handler can call it.

log.info('Phase 2 boot complete - executor listening on approvals.decided');
```

Return type extension:
```typescript
export interface BootResult {
  // ... existing ...
  stopExecutor: () => Promise<void>;
  executorArmed: boolean;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| "Place order, hope it worked" | `newClientOrderId` + duplicate-rejection idempotency | Standard since ~2018 across all exchanges; MEXC Spot v3 since launch | Phase 2 MUST use this; Pitfall 5 of PITFALLS.md |
| ML/bot polling for fills | WebSocket user-data stream + REST snapshot reconciliation | Standard since ~2020 | Phase 2 uses REST only (sufficient for $10 + end-of-phase panic test); Phase 5 adds WS user-data |
| Hardcoded fee rates | Dynamic fee query per order | MEXC promo changes Apr 2025 + Aug 2025 made this mandatory | Phase 2 fee cache (Pattern 8) |
| Single "MEXCClient" for spot+futures | Separate clients per surface | Always — MEXC's two APIs never merged | Preserved by Plan 01-04; Phase 2 extends mexc-spot only |
| Server-side stops as a given | **MEXC Spot v3 REST does NOT support them** | MEXC's spot API has never exposed TP/SL over REST | EXEC-03 re-scoping needed (Pitfall 2) |
| Redis `KEYS` scan at boot | `SCAN` with cursor | Redis best practice since 2.8 | Pattern 6 |
| Shared client for BLOCK + commands | Dedicated consumer connection | ioredis best practice since v4 | Pitfall 9 |

**Deprecated/outdated:**
- **Assumption that MEXC spot supports triggerPrice** (from earlier research — CORRECTED by this phase).
- **Redis Sentinel for 2-node failover** — Phase 10 concern; Phase 2 is single-process so moot.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^2.1 (installed at root + each package) |
| Config file | `packages/<pkg>/vitest.config.ts` per-package; no root config |
| Quick run command | `pnpm test --filter @kr8tiv/executor` (or `--filter @kr8tiv/mexc-spot` etc.) |
| Full suite command | `pnpm test` (runs turbo test across all packages) |
| Live-gated suite | `MEXC_LIVE=1 pnpm test --filter @kr8tiv/mexc-spot` (mirrors Plan 01-04 pattern) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| **EXEC-01** | Risk manager blocks unarmed | unit | `vitest packages/executor/src/risk-manager.test.ts -t "unarmed"` | ❌ Wave 0 |
| **EXEC-01** | Risk manager blocks non-whitelisted pair | unit | `vitest packages/executor/src/risk-manager.test.ts -t "whitelist"` | ❌ Wave 0 |
| **EXEC-01** | Risk manager blocks when breaker tripped | unit | `vitest packages/executor/src/risk-manager.test.ts -t "breaker"` | ❌ Wave 0 |
| **EXEC-01** | Risk manager blocks when balance < 2*minNotional | unit | `vitest packages/executor/src/risk-manager.test.ts -t "balance"` | ❌ Wave 0 |
| **EXEC-01** | Circuit breaker trips at exactly -$2 realized PnL UTC-today | unit | `vitest packages/executor/src/breaker.test.ts -t "trips at threshold"` | ❌ Wave 0 |
| **EXEC-01** | Circuit breaker resets at UTC midnight | unit (fake clock) | `vitest packages/executor/src/breaker.test.ts -t "utc reset"` | ❌ Wave 0 |
| **EXEC-02** | `placeMarketBuy` rejects without clientOrderId | TS compile + unit | `pnpm typecheck` (type-level) + `vitest packages/mexc-spot -t "requires clientOrderId"` | ❌ Wave 0 |
| **EXEC-02** | `placeMarketBuy` passes `newClientOrderId` in params to ccxt | unit (mocked ccxt) | `vitest packages/mexc-spot -t "forwards clientOrderId"` | ❌ Wave 0 |
| **EXEC-02** | Duplicate clientOrderId is rejected by MEXC | integration + live | `MEXC_LIVE=1 vitest packages/mexc-spot/src/client.live.test.ts -t "duplicate"` — **test captures actual MEXC error code/message** | ❌ Wave 0 |
| **EXEC-03** | (Re-scoped per Pitfall 2 decision — if Option A, this test asserts "entry orders submitted without stop" + "panic-cancel is the protection") | unit + live | Per selected Option A/B/C | ❌ Wave 0 + user decision |
| **EXEC-04** | Pre-order minNotional check rejects below threshold | unit (mocked exchangeInfo) | `vitest packages/executor/src/risk-manager.test.ts -t "minNotional"` | ❌ Wave 0 |
| **EXEC-04** | Pre-order minNotional uses `quoteAmountPrecisionMarket` for market orders | unit | `vitest packages/executor/src/risk-manager.test.ts -t "quoteAmountPrecisionMarket"` | ❌ Wave 0 |
| **EXEC-05** | Fee rate fetched from exchangeInfo + cached for 5m | unit (fake clock) | `vitest packages/executor/src/fee-cache.test.ts` | ❌ Wave 0 |
| **EXEC-05** | Fee rate NOT hardcoded to 0 | grep + unit | `grep -rn "fee.*0\.0" packages/executor/src` must return no relevant results | ❌ Wave 0 (add as CI) |
| **EXEC-06** | Any non-ETHUSDT pair (e.g. BTCUSDT, DOGEUSDT) throws RiskError | unit | `vitest packages/executor/src/risk-manager.test.ts -t "non-whitelisted"` | ❌ Wave 0 |
| **EXEC-07** | Panic sequence: cancel → flatten → freeze in that order | unit (mocked spot + redis) | `vitest packages/executor/src/panic.test.ts -t "ordered sequence"` | ❌ Wave 0 |
| **EXEC-07** | Panic freezes FIRST (armed=false before cancel) | unit (observe write order) | `vitest packages/executor/src/panic.test.ts -t "freeze first"` | ❌ Wave 0 |
| **EXEC-07** | Panic idempotent on re-run with nothing to do | unit | `vitest packages/executor/src/panic.test.ts -t "idempotent"` | ❌ Wave 0 |
| **EXEC-07** | Panic live: `pnpm place-order --notional 5 MEXC_LIVE=1` then `pnpm panic` → MEXC shows 0 open orders + 0 ETH balance | integration + live (end-of-phase) | Manual check + `MEXC_LIVE=1 vitest -t "panic e2e"` | ❌ Wave 0 + D-04 human verify |
| **EXEC-08** | Redis `executor:armed` survives process restart | integration | `vitest apps/core/src/boot.test.ts -t "armed flag persistence"` | ❌ Wave 0 |
| **EXEC-08** | Boot refuses to start when `executor:positions:*` non-empty | unit | `vitest apps/core/src/boot.test.ts -t "stale state"` | ❌ Wave 0 |
| **EXEC-09** | Executor subscribes ONLY to `approvals.decided` — invariant grep | CI grep test | `grep -rn "xread\|xreadgroup\|XREAD" packages/executor/src | grep -v approvals.decided` must return empty | ❌ Wave 0 |
| **EXEC-09** | Executor ignores `approved:false` events (receives but doesn't place) | unit | `vitest packages/executor/src/executor.test.ts -t "ignores rejected"` | ❌ Wave 0 |
| **EXEC-09** | Executor PEL replay on restart re-processes unacknowledged entries | integration (real Redis) | `vitest packages/executor/src/executor.test.ts -t "PEL replay"` | ❌ Wave 0 |
| **EXEC-09** | Executor XACKs on success | unit | `vitest packages/executor/src/executor.test.ts -t "xack on success"` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test --filter <package-touched>` (e.g., `--filter @kr8tiv/executor`). Runtime < 30s for mocked unit tests.
- **Per wave merge:** `pnpm test` (full monorepo vitest). Runtime < 2 min with current package count.
- **Phase gate:** Full suite green + `MEXC_LIVE=1 pnpm test --filter @kr8tiv/mexc-spot` live-tests green + `pnpm place-order --notional $(2*minNotional) MEXC_LIVE=1` + `pnpm panic` sequence manually verified in MEXC UI (D-04 proof) before `/gsd:verify-work`.

### Wave 0 Gaps

- [ ] `packages/executor/package.json` + workspace entry + vitest.config.ts + src/*.ts scaffolds
- [ ] `packages/executor/src/risk-manager.test.ts` — covers EXEC-01, EXEC-04, EXEC-06
- [ ] `packages/executor/src/breaker.test.ts` — covers EXEC-01 UTC window + threshold
- [ ] `packages/executor/src/panic.test.ts` — covers EXEC-07
- [ ] `packages/executor/src/executor.test.ts` — covers EXEC-09 stream consumer behavior
- [ ] `packages/executor/src/fee-cache.test.ts` — covers EXEC-05
- [ ] `packages/executor/src/idempotency.test.ts` — sha256 determinism, 32-char truncation
- [ ] `packages/executor/src/ledger.test.ts` — SQLite writes + positions view projection
- [ ] `packages/mexc-spot/src/client.test.ts` additions — EXEC-02 required-clientOrderId + params forwarding
- [ ] `packages/mexc-spot/src/client.live.test.ts` additions — EXEC-02 duplicate-rejection behavior (MEXC_LIVE gated)
- [ ] `apps/core/src/boot.test.ts` additions — Step 10 stale-state + Step 11 armed-flag
- [ ] `apps/core/src/place-order.test.ts` — full pipeline harness emits correct stream entries (can test with test Redis)
- [ ] `apps/core/src/reconcile.test.ts` — mocked MEXC → overwrite Redis state
- [ ] Shared test helpers: factory for mock `ccxt.Exchange`, in-memory Redis mock (or testcontainers with real Redis), deterministic clock fixture for breaker tests
- [ ] Test fixture: sample `exchangeInfo` response for ETHUSDT (captured once from a live pnpm smoke run, stored as JSON)
- [ ] CI grep-style test: `grep -rn "ccxt" packages | wc -l` returns exactly 2 hits (preserves invariant)
- [ ] CI grep-style test: `grep -rn "withdraw" packages/` returns zero hits (preserves bot-never-withdraws invariant)

## Open Questions

1. **EXEC-03 path selection — CRITICAL DECISION NEEDED BEFORE PLANNING**
   - What we know: MEXC spot v3 REST does NOT support server-side stops (three sources verified).
   - What's unclear: Which of three options (A: defer to Phase 6; B: client-side polling stop; C: undocumented OCO) Matt prefers.
   - Recommendation: **Option A** — defer. Phase 2's D-04 live trade is a 30-second place-and-panic, so no stop is needed. Phase 5 or Phase 6 revisits. The planner should flag this to Matt before writing Plan 02-XX.
   - Action: orchestrator or planner raises this as a discuss-phase follow-up.

2. **Package layout — new `@kr8tiv/executor` vs `apps/core/src/executor/` folder**
   - What we know: Existing precedent (`@kr8tiv/config`, `@kr8tiv/logger`, etc.) favors package-per-concern.
   - What's unclear: Whether the executor's tight coupling to `apps/core/src/boot.ts` justifies folder placement.
   - Recommendation: **`@kr8tiv/executor` as a new package.** Matches existing monorepo convention; keeps apps/core thin; makes the "ccxt import only in 2 files" invariant trivially verifiable via package-boundary check.

3. **Redis Stream consumer group name — `executor-v1` vs `executor` vs `core-executor`**
   - What we know: Name is load-bearing; renaming requires XGROUP DESTROY + recreate (losing PEL).
   - What's unclear: Which naming convention the project has or will adopt.
   - Recommendation: **`executor-v1`** — matches `features.v1` stream precedent in SUMMARY.md's event bus list; explicit versioning makes Phase 4+ evolution cleaner.

4. **Fee cache TTL — 5 min (CONTEXT suggests) vs 1 hour (exchangeInfo doesn't change much)**
   - What we know: Fee rate is stable per VIP tier; promos change infrequently.
   - What's unclear: Exact change cadence for Matt's specific VIP tier.
   - Recommendation: **5 min** as specified in CONTEXT Claude's Discretion. Harmless at $10 scale.

5. **Test harness: same-process vs subprocess executor for integration tests**
   - What we know: In-process is simpler (one vitest run); subprocess more accurately simulates production.
   - What's unclear: Whether Matt's vitest + Windows + portable Redis combination has process-spawning issues (PITFALLS.md + STATE.md document bash fork exhaustion on Matt's box).
   - Recommendation: **Same-process for unit tests; subprocess only for the end-of-phase D-04 live proof** (where `pnpm place-order` is invoked from a PowerShell session + `pnpm panic` from a second session, mirroring real-operator workflow). Skip subprocess integration tests.

6. **clientOrderId length — 32 vs 36 hex chars**
   - What we know: MEXC docs are silent; 32 is safe-conservative; 36 matches UUID-v4-format.
   - What's unclear: Whether MEXC validates length.
   - Recommendation: **32 hex chars** (Pattern 7). Revisit if D-04 live trade surfaces a length rejection.

7. **Position-aware state granularity — single-position-per-pair vs position-stack**
   - What we know: $10 bankroll + ETHUSDT-only + one approval at a time = at most 1 open position at any time.
   - What's unclear: Whether to model as `executor:positions:ETHUSDT` (single hash) or `executor:positions:ETHUSDT:<clientOrderId>` (history).
   - Recommendation: **Single hash per pair** (`executor:positions:ETHUSDT = {qty, avgEntry, updatedAt}`). History lives in SQLite `orders`+`fills`. Redis stays small.

8. **Stream trimming: MAXLEN ~ 1000 vs MAXLEN ~ 10000**
   - What we know: At ≤5 signals/day (APP-07) + ≤10 orders/day, 1000 stream entries = 200 days of history.
   - What's unclear: Whether analysis/replay wants longer retention.
   - Recommendation: **`MAXLEN ~ 1000`** for each of the 4 streams. Historical replay goes to SQLite, not streams.

## Sources

### Primary (HIGH confidence)

- **MEXC Spot v3 API — Spot Account/Trade endpoints:** https://www.mexc.com/api-docs/spot-v3/spot-account-trade — POST /api/v3/order parameters (verified 2026-04-18); DELETE /api/v3/order; DELETE /api/v3/openOrders; supported order types = LIMIT, LIMIT_MAKER, MARKET, IOC, FOK.
- **MEXC Spot v3 API — Market Data:** https://www.mexc.com/api-docs/spot-v3/market-data-endpoints — GET /api/v3/exchangeInfo field shape (baseSizePrecision, quoteAmountPrecision, quoteAmountPrecisionMarket, takerCommission).
- **MEXC API Dev Docs (github.io mirror):** https://mexcdevelop.github.io/apidocs/spot_v3_en/ — extended parameter tables; spot-only order types (no STOP_LOSS).
- **CCXT MEXC driver source:** https://github.com/ccxt/ccxt/blob/master/ts/src/mexc.ts — error code mapping (30005, 30004, 700001–700013); spot feature flags showing `triggerPrice: false`; symbolRequired on fetchOpenOrders/cancelAllOrders.
- **ccxt/ccxt issue #22104 "Mexc can't put a stop loss order":** https://github.com/ccxt/ccxt/issues/22104 — empirical confirmation that MEXC spot silently ignores stopPrice/triggerPrice.
- **Redis XREADGROUP reference:** https://redis.io/docs/latest/commands/xreadgroup/ — consumer group semantics, BLOCK, `>` vs `0` IDs, PEL.
- **Redis Streams concepts:** https://redis.io/docs/latest/develop/data-types/streams/ — XADD MAXLEN, XACK, XCLAIM.
- **ioredis README + types:** https://github.com/redis/ioredis — Streams support confirmation, 100% TypeScript declarations.
- **Phase 1 artifacts:**
  - `.planning/research/SUMMARY.md` — overall stack + Phase 2 scope lines 120–128.
  - `.planning/research/PITFALLS.md` — Pitfalls 3 (minNotional), 5 (double-fire), 6 (sleep orphans), 12 (fee promo), 15 (delisting).
  - `.planning/research/ARCHITECTURE.md` — §5 Risk Manager contract, §Event-Bus topology, §Split-brain prevention.
  - `.planning/phases/01-foundation/01-04-SUMMARY.md` — MEXCSpotClient shape, MEXC_LIVE=1 gating pattern.
  - `packages/mexc-spot/src/client.ts` — existing `readonly exchange: Exchange` handle.
  - `packages/shared-schemas/src/mexc.ts` — Zod pattern for MEXC responses.

### Secondary (MEDIUM confidence, verified against primary)

- **ccxt/ccxt issue #3460 createMarketBuyOrderRequiresPrice:** https://github.com/ccxt/ccxt/issues/3460 — how the option relates to quoteOrderQty.
- **ccxt/ccxt issue #13273 MEXC spot order "How to":** https://github.com/ccxt/ccxt/issues/13273 — symbol format `'ETH/USDT'` for ccxt vs `'ETHUSDT'` raw.
- **ccxt/ccxt issue #25660 createMarketBuyOrderWithCost on MEXC:** https://github.com/ccxt/ccxt/issues/25660 — quote-cost market buy semantics.
- **ccxt/ccxt issue #25003 MEXC IOC not honored:** https://github.com/ccxt/ccxt/issues/25003 — evidence that MEXC spot's timeInForce handling through ccxt has known gaps (validates our choice to market-only in Phase 2 per D-06).
- **Metascalp MEXC error code reference:** https://metascalp.gitbook.io/metascalp/faq/exchange-errors/mexc — additional error codes (10095, 10096, 30041, 44444, 700004).

### Tertiary (LOW confidence — included only as context, not relied on for decisions)

- Community-aggregated knowledge about MEXC OCO via UI (not exposed in v3 REST per verified sources above).
- Assumptions about 32-char clientOrderId safety (empirical Binance-lineage pattern; not documented by MEXC).

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — all deps already installed; no version surprises.
- MEXC spot write API mechanics: **HIGH** — three independent sources on order types, parameter names, endpoints.
- EXEC-03 blocker (no server-side stops): **HIGH** — three sources confirm; finding is definitive.
- Redis Streams consumer patterns: **HIGH** — official Redis docs + ioredis README.
- Idempotency key format: **MEDIUM** — length rule is a safe guess, not documented.
- Duplicate-clientOrderId error code: **MEDIUM** — not in MEXC docs; will be captured at D-04 proof.
- Stale-state detection at boot: **HIGH** — SCAN is standard; key convention is planner's discretion but well-specified.
- Panic sequence: **HIGH** — ordering rationale is straightforward "fail-closed first, cleanup second."
- Validation architecture: **HIGH** — vitest pattern mirrors Plan 01-04, nothing new.

**Research date:** 2026-04-18
**Valid until:** 2026-05-18 (30 days — MEXC API is mature, low churn risk). **Earlier invalidation trigger:** MEXC announces new order types for spot v3 (would resolve the EXEC-03 blocker) — check `https://www.mexc.com/announcements/api-updates` weekly during phase execution.

---

*Phase 2 research complete. Primary blocker (EXEC-03 server-side stops) surfaced early — planner should resolve with Matt BEFORE writing Plan 02-XX. All other findings are actionable with existing libraries; no new dependencies required.*
