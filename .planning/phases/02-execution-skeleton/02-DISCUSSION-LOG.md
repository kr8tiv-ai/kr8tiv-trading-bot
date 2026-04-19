# Phase 2: Execution Skeleton - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 02-CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-18
**Phase:** 02-execution-skeleton
**Areas discussed:** Signal source, Panic trigger + re-arm, Circuit breaker PnL accounting, First-live-trade placement, Stale-state policy, Order types

---

## A — Signal Source (no Telegram/ML yet)

### A1: What triggers the executor during Phase 2?

| Option | Description | Selected |
|--------|-------------|----------|
| CLI test harness (shipped) | `apps/core/src/place-order.ts` as real command (`pnpm place-order --side buy --notional 1`); writes synthesized signal+approval to Redis streams; preserves architectural invariant | ✓ |
| Vitest-only fixture | Integration test inside `packages/executor/` fires one real order; no shipped CLI | |
| HTTP dev endpoint on core | Fastify POST /dev/approve-order on localhost | |

### A2: How faithful should the harness be to final architecture?

| Option | Description | Selected |
|--------|-------------|----------|
| Full pipeline | Writes to `signals.candidate → signals.filtered → approvals.pending → approvals.decided` in sequence; Phase 3/4 replace stages cleanly | ✓ |
| Shortcut to approvals.decided | Writes only to final stream | |
| Direct function call | Bypass Redis entirely in Phase 2 tests | |

### A3: `signal_id` for idempotency key `sha256(signal_id + approval_timestamp)`?

| Option | Description | Selected |
|--------|-------------|----------|
| UUID v4 per test run | Fresh UUID per harness invocation; idempotency holds; zero coupling to future signal generator | ✓ |
| Hash of CLI args | Same args = deterministic duplicate rejection | |
| Literal 'phase-2-harness' | Constant string; every harness call collides on purpose | |

---

## B — Panic Trigger + Re-arm (interim before Phase 3 Telegram)

### B1: How does Matt trigger panic in Phase 2?

| Option | Description | Selected |
|--------|-------------|----------|
| CLI (`pnpm panic`) | `apps/core/src/panic.ts`; writes `executor:armed=false` to Redis; mirrors place-order CLI pattern | ✓ |
| SIGUSR1 to the process | `kill -USR1 <pid>`; operationally awkward on Windows | |
| Sentinel file (touch .panic) | File watcher polls for `.panic`; works even if Redis is down | |
| HTTP endpoint | POST http://127.0.0.1:3000/panic; introduces Fastify to Phase 2 (scope creep) | |

### B2: What does panic do?

| Option | Description | Selected |
|--------|-------------|----------|
| Cancel + flatten + freeze | Cancel orders + market-close positions + block new; industry default | ✓ |
| Cancel + freeze only | No auto-flatten; leave position; Matt manually closes in MEXC UI | |
| Freeze only | Block new orders; leave existing orders + position | |

### B3: Re-arm after panic?

| Option | Description | Selected |
|--------|-------------|----------|
| CLI (`pnpm arm`) | Explicit human action to re-arm; fits "kill switch must be deliberate" | ✓ |
| Auto re-arm after N min clean | Timer; removes manual step but defeats kill-switch intent | |
| Restart process = re-arm | `executor:armed=true` reset on boot; simplest but unsafe | |

### B4: Does panic state survive process crash?

| Option | Description | Selected |
|--------|-------------|----------|
| Redis-backed, survives | `executor:armed` key in Redis; next boot reads and respects | ✓ |
| Sentinel file fallback | Dual source of truth on disk + Redis | |
| In-memory only (fail-open) | Crash loses flag; risky if panic was tripped by a bug | |

---

## C — Circuit Breaker PnL Accounting

### C1: What counts toward $2 daily loss?

| Option | Description | Selected |
|--------|-------------|----------|
| Realized only | Closed-position PnL only; simpler; matches retail-exchange daily PnL reports; unrealized drawdown limited by per-entry server-side stop | ✓ |
| Realized + unrealized | Mark-to-market on open positions; catches flash crashes but noisy; requires continuous mark-price ticks | |
| Realized + fees only | Hybrid: closed PnL + fees paid today; uncommon pattern | |

### C2: When does "today" reset?

| Option | Description | Selected |
|--------|-------------|----------|
| UTC midnight | Matches MEXC's reporting; aligns with funding rate windows; predictable | ✓ |
| Local midnight (MT) | Intuitive for Matt but drifts from MEXC accounting | |
| Rolling 24h window | Smoothest; slightly more complex implementation | |

### C3: Action on trip?

| Option | Description | Selected |
|--------|-------------|----------|
| Block new orders, leave existing | Refuse new; open positions + server-side stops continue; natural UTC reset or manual `pnpm arm` | ✓ |
| Block new + flatten (like panic) | Force-close; risk of flattening at bad local price | |
| Block new + downsize next order | Graceful soft-stop; risk of death-by-paper-cuts | |

---

## D — First-Live-Trade Placement

### D1: Does Phase 2 fire a real order?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, one real trade at end of Phase 2 | Manual `pnpm place-order --side buy --notional <2xminNotional>` → attach server-side stop → immediate `pnpm panic` to cancel. Confirms: MEXC accepts the order, clientOrderId duplicate-rejects on retry, stop visible in MEXC UI, panic cancels properly. | ✓ |
| No, defer first real trade to Phase 5 | Ship write code + tests against mocked CCXT only; safer but EXEC-01..09 unverifiable until Phase 5 | |
| Yes, but behind MEXC_LIVE=1 env gate | Same as option 1 but gated; default runs stay against mocks | (Selected option 1 already carries this gate per SUMMARY.md precedent) |

### D2: What notional for the live trade?

| Option | Description | Selected |
|--------|-------------|----------|
| Exactly 2x minNotional | Pulls minNotional from `exchangeInfo` dynamically; tests the minNotional gate at boundary | ✓ |
| Fixed $1 notional | Hardcoded; may be rejected if below minNotional (itself a useful negative test) | |
| Smallest legal amount | 1.01 * minNotional; tests nothing at boundary | |
| Skip — chose Option 2 | N/A | |

---

## E — Boot-time Stale-State Policy (before Phase 5 reconciler)

### E1: What happens at boot if Redis ledger shows non-empty state?

| Option | Description | Selected |
|--------|-------------|----------|
| Refuse to start | BootError(pre-flight) with message "stale state — run `pnpm reconcile`"; new `apps/core/src/reconcile.ts` CLI pulls MEXC truth, overwrites Redis, writes `reconciled_at`; Phase 5 replaces with automated version | ✓ |
| Auto-sync with MEXC truth on boot | Query MEXC openOrders + fetchBalance, overwrite Redis automatically; risk if MEXC returns partial | |
| Log warn + continue | Trust Redis state; unsafe | |
| Panic-lock (refuse + trip armed flag) | Require BOTH `pnpm reconcile` AND `pnpm arm` to recover | |

---

## F — Order Types Scope

### F1: Market-only or market+limit in Phase 2?

| Option | Description | Selected |
|--------|-------------|----------|
| Market-only in Phase 2 | `placeMarketBuy`/`placeMarketSell`; simpler; Phase 4 adds limit when ML signals need specific entry prices | ✓ |
| Market + limit both in Phase 2 | Matches EXEC-02 literally; more code + more state-machine edges | |
| Market + limit but limit feature-flagged | Ship both, limit gated by `FEATURE_LIMIT_ORDERS=true`; hedged | |

---

## Claude's Discretion

Captured in 02-CONTEXT.md `<decisions>` §Claude's Discretion. Summary: executor package vs folder layout, Redis key namespacing, rate-limit fail-closed behavior, fee-cache TTL, exact vitest matrix, and explicit exclusion of Fastify from Phase 2.

## Deferred Ideas

See 02-CONTEXT.md `<deferred>` section. Notable items: web dashboard panic button (Phase 9), auto re-arm after clean ledger (Phase 10?), unrealized-PnL circuit breaker, soft-stop order downsizing, limit orders (Phase 4), automated reconciler (Phase 5).
