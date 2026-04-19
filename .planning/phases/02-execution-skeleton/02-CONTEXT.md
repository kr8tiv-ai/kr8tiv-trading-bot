# Phase 2: Execution Skeleton - Context

**Gathered:** 2026-04-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 makes the core process **capable of placing a real $-sized MEXC spot order on ETHUSDT** with every safety rail enforced — idempotency, server-side stops, minNotional check, $2 daily-loss circuit breaker, panic kill-switch, Redis-backed position state — **without any Telegram approval layer (Phase 3) or ML/rule signal source (Phase 4) yet in place**.

Phase 2 ships:
- `@kr8tiv/mexc-spot` write methods (`placeMarketBuy`, `placeMarketSell`, `cancelOrder`, `cancelAllOrders`, `fetchOpenOrders`)
- `@kr8tiv/executor` or `apps/core/src/executor/` module subscribing to `approvals.decided{approved:true}` Redis stream
- `@kr8tiv/risk-manager` enforcing the 5 safety rails before any order leaves the process
- CLI test harness `pnpm place-order` writing synthesized signal+approval through the full Redis Stream pipeline
- CLI `pnpm panic` + `pnpm arm` for kill-switch control
- CLI `pnpm reconcile` for boot-time stale-state recovery (stub; Phase 5 replaces with automated reconciler)
- **One live $(2 * minNotional)** ETHUSDT buy → attach server-side stop → immediate panic-cancel at the END of Phase 2 as the EXEC-02 idempotency proof

Phase 2 does NOT ship:
- Telegram bot (Phase 3)
- ML / rule-based signal generator (Phase 4)
- Ledger queries or reconciler automation (Phase 5)
- Futures write path (Phase 6)
- News veto (Phase 7)

</domain>

<decisions>
## Implementation Decisions

### D-01. Signal source during Phase 2 (no Telegram/ML yet)
- **CLI test harness shipped as `apps/core/src/place-order.ts`**. Real command: `pnpm place-order --side buy --notional <N>`.
- Harness writes a **full Redis Stream pipeline**: `signals.candidate` → `signals.filtered` → `approvals.pending` → `approvals.decided`. Phase 3 replaces the `approvals.pending→decided` link with Telegram; Phase 4 replaces `signals.candidate` with ML output. Seam integrity proven end-to-end from day 1.
- **`signal_id` is a UUID v4** generated per harness invocation. Phase 4 replaces with real signal identifiers from the ML layer. Idempotency key spec from SUMMARY.md preserved: `newClientOrderId = sha256(signal_id + approval_timestamp)`.

### D-02. Panic kill-switch (Phase 2 interim; Phase 3 adds Telegram trigger)
- **Trigger:** `pnpm panic` CLI writes `executor:armed=false` to Redis. Phase 3 adds `/panic` Telegram command as a second trigger; CLI stays as the fallback forever.
- **Action on panic:** **cancel + flatten + freeze**. (1) `exchange.cancelAllOrders('ETHUSDT')`. (2) Market-close any open position via a flatten order. (3) Set `executor:armed=false` so no new orders process.
- **Re-arm:** `pnpm arm` CLI writes `executor:armed=true` to Redis. Explicit human action required — which is the whole point of a kill switch.
- **Persistence:** `executor:armed` is a Redis key. Survives process crash. Boot reads the key; if false, executor refuses to process new orders until `pnpm arm` runs. Satisfies EXEC-08 (position-aware state survives restart).

### D-03. Daily-loss circuit breaker
- **PnL scope: realized only.** Only closed-position PnL counts toward the $2 daily cap. Open-trade unrealized drawdown is limited by the per-entry server-side stop (~1% of entry notional) and does not trigger the circuit.
- **Reset: UTC midnight.** `today = sum of realized_pnl where closed_at >= today-UTC-00:00:00`. Matches MEXC's reporting timezone; predictable; aligns with funding rate windows.
- **Trip action: block new orders, leave existing.** Executor refuses new orders; open positions + their server-side stops continue unmolested. Re-arm path: manual `pnpm arm` OR natural UTC reset at next midnight. No panic-flatten on trip — that's what /panic is for.

### D-04. First-live-trade at end of Phase 2
- **Phase 2 fires ONE real MEXC order** as the EXEC success proof. Not deferred to Phase 5.
- **Sequence:** after all unit + integration tests pass, run `pnpm place-order --side buy --notional $(2 * minNotional)` — notional computed dynamically by pulling `exchangeInfo` for ETHUSDT and multiplying minNotional by 2. Attach server-side stop. Immediately run `pnpm panic` to cancel + flatten. Confirms: MEXC accepts the order, clientOrderId survives duplicate rejection on retry (idempotency gate), server-side stop visible in MEXC UI, panic actually cancels.
- **This trade is gated** — the `pnpm place-order` CLI refuses to call real MEXC unless `MEXC_LIVE=1` env is set. Default runs stay mocked. Matches Plan 01-04's gating pattern.
- **Outcome recorded in 02-SUMMARY.md:** actual fill clientOrderId, duplicate-rejection response body, stop-loss order ID visible in MEXC UI, panic-cancel confirmation.

### D-05. Boot-time stale-state policy
- **Refuse to start if Redis ledger is non-empty at boot.** If `redis.exists('executor:positions:*')` or `executor:orders:*` shows non-empty, `boot()` throws `BootError(stage='pre-flight')` with message: `"stale state detected — run \`pnpm reconcile\` before starting"`.
- **`apps/core/src/reconcile.ts` is a new Phase 2 CLI** that: (1) queries MEXC truth via `fetchOpenOrders` + position query, (2) overwrites Redis state with MEXC's view, (3) writes `reconciled_at` timestamp. Phase 5 replaces this CLI with an automated boot-time reconciler and adds crash-recovery edge cases; Phase 2 ships the minimal happy-path version.
- **Why not auto-sync on every boot:** MEXC query can fail or return partial data. Explicit manual step forces Matt to confirm state is clean before resuming trading.

### D-05b. EXEC-03 server-side stops — DEFERRED to Phase 6 (AMENDED 2026-04-18 post-research)
- **Research finding:** MEXC Spot v3 REST API does not support server-side stop-loss orders (`POST /api/v3/order` only accepts `LIMIT | LIMIT_MAKER | MARKET | IOC | FOK`). Confirmed via 3 independent sources; CCXT silently drops `triggerPrice` param for MEXC spot (see ccxt issue #22104).
- **Matt's decision (2026-04-18):** Option A — defer server-side stops to Phase 6 (futures, where MEXC does support trigger orders). Phase 2 spot path ships WITHOUT any stop attached.
- **Phase 2 safety substitute:** CLI-driven panic-cancel from D-02. End-of-phase live trade (D-04) proves the pattern: `pnpm place-order` buy → attach NO stop → immediate `pnpm panic` cancels within ~30 seconds. Real-money exposure window is bounded by panic-cancel latency, not by an exchange-side stop.
- **Implications for planner:**
  - `MEXCSpotClient.placeMarketBuy(...)` signature does NOT take a `stopPrice` param.
  - Risk manager does NOT enforce "every entry has a stop" for spot orders in Phase 2 (EXEC-03 check skipped for spot).
  - `02-SUMMARY.md` acceptance criteria MUST explicitly note "spot orders placed naked per EXEC-03 amendment 2026-04-18" so future readers don't assume it was an oversight.
  - Phase 6 planning re-enables the "every entry has a stop" rule for USDT-M futures where MEXC supports it.
- **REQUIREMENTS.md status:** EXEC-03 amended to `[~]` with full rationale, committed alongside this CONTEXT edit.

### D-06. Order types — market-only in Phase 2
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### MEXC API mechanics
- `.planning/research/STACK.md` §6 — MEXC spot minimum order sizing (0.5 USDT notional minimum; exact per-pair minNotional from `/api/v3/exchangeInfo` at startup)
- `.planning/research/SUMMARY.md` lines 103–106 — Pitfalls 2, 4, 5 (double-fire idempotency, laptop sleep = orphan orders, minimum notional sizing)
- `.planning/research/ARCHITECTURE.md` §3 — Risk Manager component contract + pre-trade gate invariants
- `.planning/research/PITFALLS.md` (full file) — all trading safety pitfalls the executor must defend against

### Architectural contracts (Phase 1 artifacts that Phase 2 extends)
- `.planning/phases/01-foundation/01-04-SUMMARY.md` — existing `MEXCSpotClient.create()` shape and read-only method surface; Phase 2 ADDS write methods to this same class without breaking the read-only invariants
- `.planning/phases/01-foundation/01-05-SUMMARY.md` — `BootResult` interface returned by `boot()`; Phase 2 extends with `executor: Executor` handle
- `packages/mexc-spot/src/client.ts` — current class; Phase 2 adds write methods here (ccxt is imported only in this file — invariant preserved)
- `packages/secrets/src/provider.ts` — SecretProvider already wired; executor reads MEXC creds through it (never directly)
- `packages/shared-schemas/src/mexc.ts` — existing Zod schemas; Phase 2 adds `MexcOrderResponseSchema`, `MexcCancelResponseSchema`, `MexcFillSchema`

### Requirements
- `.planning/REQUIREMENTS.md` EXEC-01 through EXEC-09 — 9 acceptance criteria; every one maps to code artifacts in this phase
- `.planning/ROADMAP.md` "Phase 2: Execution Skeleton" — goal + 6 success criteria must be verifiable after phase completes

### Phase 1 sign-off context
- `docs/phase-1-readiness.md` (signed 2026-04-18 by Matt-Aurora-Ventures) §1 — the MEXC key is FULL-PERMISSION (withdraw ON) per explicit user decision. Phase 2 executor must NOT call withdraw APIs (architectural invariant; confirmed by no `withdraw` strings in source).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@kr8tiv/mexc-spot` class `MEXCSpotClient` with `static create({ secrets })` factory already reads credentials via SecretProvider. Phase 2 extends it with write methods — NO changes to the creation/auth pattern. The `readonly exchange: Exchange` handle lets the new write methods delegate to `exchange.createOrder(...)` directly.
- `@kr8tiv/redis-client` `createRedis()` + `pingOrThrow()` from Plan 01-03. Phase 2's Redis Stream consumer consumes the same Redis client; stream ops via ioredis `xread` / `xadd`.
- `@kr8tiv/db` `openDatabase()` opens SQLite with WAL. Phase 2 writes order/fill rows to an `orders` table (schema TBD by planner).
- `@kr8tiv/logger` redaction paths already cover `apiKey`, `secret`, `mexc.*`, `req.headers["x-mexc-apikey"]`, `req.headers["x-mexc-signature"]` at depth 1–3. Executor logging flows through `createLogger()` unchanged.
- `@kr8tiv/shared-schemas/mexc` Zod schemas (Plan 01-04) for ping + balance. Phase 2 ADDS order-related schemas to the same file.
- `apps/core/src/boot.ts` line 142–143 has the `Promise.allSettled([spot.ping(), futures.ping()])` seam. Phase 2 inserts a **Step 10: verify executor state (stale-state check)** between line 150 and the current "Phase 1 boot complete" log.
- `apps/core/src/smoke.ts` exit-code contract (0/1/2). Phase 2 might add exit-code 3 for "stale state — run `pnpm reconcile`" (planner's call; could also piggyback on `stage='pre-flight'` exit 1).

### Established Patterns
- **Ccxt imported in exactly 2 files** (packages/mexc-spot/client.ts + packages/mexc-futures/client.ts). Phase 2 PRESERVES this — executor calls `MEXCSpotClient.placeMarketBuy(...)`, never `ccxt.mexc.createOrder(...)`.
- **Zod at the response boundary** — every MEXC response parses through a schema before reaching downstream code. Phase 2 adds schemas for order-placement responses; the executor consumes pre-parsed `OrderFilled` / `OrderCancelled` values.
- **`MEXC_LIVE=1` env gate for live tests** — from Plan 01-04. Phase 2 uses the same pattern for its live-trade test at end-of-phase.
- **Commits use `git -c core.hooksPath=/dev/null --no-verify`** pattern from Plan 01-02 (bash fork exhaustion on Matt's Win box — still active). Plan-phase author: same pattern.
- **CLI scripts live in `scripts/` (workspace package `@kr8tiv/scripts`, `type: module`)** per Plan 01-02. Phase 2's new CLIs (`pnpm place-order`, `pnpm panic`, `pnpm arm`, `pnpm reconcile`) follow the same layout: file in `scripts/*.ts`, script entry in root `package.json`.
- **Redis runs locally via portable binary** at `%USERPROFILE%\tools\redis-portable\redis-server.exe --port 6379 --maxmemory 256mb --maxmemory-policy noeviction`. Must be running before `pnpm smoke` / `pnpm place-order`. Setup docs at `docs/setup-windows.md`.

### Integration Points
- **`apps/core/boot.ts` Step 10** — new executor state verification (stale-state refuse-to-start check).
- **Redis Streams consumed:** `approvals.decided` (XREAD BLOCK on a consumer group). Redis Streams produced (by the harness, not executor): `signals.candidate`, `signals.filtered`, `approvals.pending`, `approvals.decided`.
- **Secrets consumed via SecretProvider:** `mexc-spot-access`, `mexc-spot-secret`. `mexc-whitelist-ip` read for the boot-time IP match warn (Plan 01-05 already does this). No new secret names added in Phase 2.
- **SQLite tables added:** `orders` (clientOrderId, exchangeOrderId, side, qty, price, status, timestamps), `fills` (orderId FK, qty, price, fee, timestamp), `realized_pnl` (per-day rollup for circuit breaker). Planner finalizes schema.

</code_context>

<specifics>
## Specific Ideas

- **The "one live trade" closeout at end of Phase 2** is the EXEC-02 success-criterion proof — re-submit the same clientOrderId, assert MEXC returns a duplicate-rejection error. Without this, EXEC-02 is unverifiable.
- **Matt explicitly prefers "fail closed" over "fail open"** across the board — a subtext running through all 6 answers. When in doubt, refuse to act and require human intervention. Planner should bake this into error-handling defaults throughout the executor module.
- **Full pipeline test harness (not shortcut)** — Matt wants the Redis Streams seam proven end-to-end in Phase 2. Phase 4 (signals) and Phase 3 (Telegram) will REPLACE stages of the pipeline, not rewrite them. The `xread`/`xadd` contracts must be stable from Phase 2 forward.
- **Default to UTC in all time accounting.** Circuit breaker reset, idempotency key timestamps, ledger `closed_at`. Matt's local time is America/Denver; using local time would drift from MEXC's accounting and create dual-truth confusion.

</specifics>

<deferred>
## Deferred Ideas

- **Web dashboard panic button** — a `POST /panic` Fastify endpoint would be convenient but overlaps with Phase 9 dashboard. Not Phase 2.
- **Auto re-arm after N minutes of clean ledger** — rejected in Area B. Kill-switch stays explicit-human-reset. If Matt later wants a timer, Phase 10 (observability) is a reasonable home.
- **Real-time unrealized-PnL circuit breaker** (mark-to-market) — rejected in Area C in favor of realized-only. If flash-crash protection becomes an issue in Phase 5+ live running, revisit then.
- **Graceful "downsize next order" soft-stop** — rejected in Area C. Could revisit in Phase 4 when ML signal confidence scores exist (scaled sizing by confidence delta).
- **Limit orders** — deferred to Phase 4 per D-06. When signals emit specific entry prices.
- **Rate-limit bucket recovery from Redis failure** — Claude's Discretion: fail-closed. If Matt later wants a "continue with degraded rate-tracking on Redis outage" path, it's a Phase 10 observability concern.
- **`pnpm reconcile` CLI → automated boot-time reconciler** — Phase 5 automates this; Phase 2 ships the manual version only.

</deferred>

---

*Phase: 02-execution-skeleton*
*Context gathered: 2026-04-18*
