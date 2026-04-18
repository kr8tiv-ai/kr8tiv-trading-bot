---
phase: 01-foundation
plan: 04
subsystem: foundation
tags: [typescript, ccxt, mexc, spot, futures, zod, two-client, vitest]

requires: [02]
provides:
  - "@kr8tiv/shared-schemas/mexc — 4 Zod schemas (MexcSpotTimeSchema, MexcFuturesPingSchema, MexcPingResponseSchema, MexcBalanceResponseSchema) + AccountInfo type"
  - "@kr8tiv/mexc-spot — read-only CCXT-backed spot client with static create(), ping(), getAccountInfo(); SecretProvider-sourced credentials; Zod at response boundary"
  - "@kr8tiv/mexc-futures — read-only CCXT stub swap client with public ping() (no auth needed); graceful handling of missing Phase 1 futures credentials"
affects: [01-foundation]

tech-stack:
  added:
    - "ccxt ^4.5 (imported in exactly 2 files — mexc-spot/client.ts, mexc-futures/client.ts)"
  patterns:
    - "Two-client MEXC separation: distinct CCXT instances → distinct rate-limit buckets (Pitfall 1 defense)"
    - "Zod at the boundary: every MEXC response parses through a schema before reaching downstream code"
    - "Live tests gated via `describe.skipIf(process.env.MEXC_LIVE !== '1')` + vitest exclude pattern for `.live.test.ts`"
    - "Base URLs config-driven via env.MEXC_SPOT_BASE_URL / env.MEXC_FUTURES_BASE_URL — Jan 12 2026 futures domain migration is a one-line env change"

key-files:
  created:
    - packages/shared-schemas/src/mexc.ts
    - packages/shared-schemas/src/mexc.test.ts
    - packages/shared-schemas/vitest.config.ts
    - packages/mexc-spot/package.json
    - packages/mexc-spot/tsconfig.json
    - packages/mexc-spot/vitest.config.ts
    - packages/mexc-spot/src/index.ts
    - packages/mexc-spot/src/client.ts
    - packages/mexc-spot/src/client.test.ts
    - packages/mexc-spot/src/client.live.test.ts
    - packages/mexc-futures/package.json
    - packages/mexc-futures/tsconfig.json
    - packages/mexc-futures/vitest.config.ts
    - packages/mexc-futures/src/index.ts
    - packages/mexc-futures/src/client.ts
    - packages/mexc-futures/src/client.test.ts
    - packages/mexc-futures/src/client.live.test.ts
  modified:
    - packages/shared-schemas/package.json (add test script + vitest devDep)
    - packages/shared-schemas/src/index.ts (re-export ./mexc.js)
    - packages/shared-schemas/tsconfig.json (add vitest/node types)
    - pnpm-lock.yaml

key-decisions:
  - "ccxt imported in exactly 2 files. shared-schemas/mexc.ts imports Zod only; downstream apps import the wrappers, never CCXT."
  - "MEXCFuturesClient.create() gracefully handles missing mexc-futures-access + mexc-futures-secret (expected in Phase 1; futures creds come in Phase 6). Public ping() works regardless."
  - "Both clients expose `readonly exchange` for test introspection. Downstream code MUST NOT use this to place orders — that's Phase 2 (spot) / Phase 6 (futures)."
  - "Live tests use `MEXC_LIVE=1` gate. 3 total: spot ping + spot getAccountInfo + futures ping. Spot tests need mexc-spot-access/secret in WCM; futures ping needs no auth."
  - "Full-permission MEXC key reality noted earlier (commit 54c8154) — live tests will work with either full-perm or trading-only keys. FND-11 readiness doc (01-06) reflects this."

patterns-established:
  - "Invariant: `from \"ccxt\"` grep returns matches ONLY in the 2 client.ts files + typed `type Exchange` imports"
  - "Invariant: literal hardcoded MEXC URLs appear only in .env.example / JSDoc / .planning docs — never as production defaults in src/"
  - "No `placeOrder` / `createOrder` / `cancelOrder` anywhere in mexc-spot/src/ or mexc-futures/src/"

requirements-completed: [FND-06, FND-07]
partial-requirements:
  - "FND-06 + FND-07 live assertions gated by MEXC_LIVE=1 — Matt flips them green via `pnpm setup:credentials` then `$env:MEXC_LIVE=1; pnpm -F @kr8tiv/mexc-spot test; pnpm -F @kr8tiv/mexc-futures test`. Spot live (2 tests) + futures live (1 public ping). Until then, 20 unit tests prove the factory contract."

commits:
  - "e2c385c — feat(01-04): @kr8tiv/shared-schemas Zod schemas for MEXC spot time, futures ping, balance"
  - "84b8c17 — feat(01-04): @kr8tiv/mexc-spot read-only CCXT client with Zod boundary (FND-06)"
  - "ffbc15a — feat(01-04): @kr8tiv/mexc-futures read-only CCXT stub with public ping + instance-separation (FND-07)"

duration: "~35 min inline via PowerShell MCP"
completed: 2026-04-18

empirical_findings:
  ccxt_publicGetTime_exists: "Not yet verified empirically — fallback fetch path is defensive"
  ccxt_contractPublicGetPing_exists: "Not yet verified empirically — fallback fetch path covers"
  futures_domain_jan_2026_migration: "contract.mexc.com still default per env; re-verify during live ping run"

downstream_contract:
  - "apps/core boot.ts (Plan 01-05) step 7: `const spot = await MEXCSpotClient.create({ secrets })`"
  - "apps/core boot.ts (Plan 01-05) step 8: `const futures = await MEXCFuturesClient.create({ secrets })`"
  - "apps/core boot.ts (Plan 01-05) step 9: `Promise.allSettled([spot.ping(), futures.ping()])` — fails fast with readable error on either"
---

# Plan 01-04 Summary — MEXC Two-Client Read-Only Surface

Two MEXC clients (spot + futures) with deliberately separate CCXT instances, config-driven base URLs, SecretProvider-sourced credentials, and Zod schemas at every response boundary.

## Test Results

| Package | Unit Tests | Live Tests | Status |
|---------|-----------|-----------|--------|
| @kr8tiv/shared-schemas | 9 passed | — | ✅ All green |
| @kr8tiv/mexc-spot | 5 passed | 2 gated (MEXC_LIVE=1) | ✅ Unit green |
| @kr8tiv/mexc-futures | 6 passed | 1 gated (MEXC_LIVE=1) | ✅ Unit green |
| **Totals** | **20 unit tests passed** | **3 live gated** | ✅ |
| turbo typecheck | 9 packages | — | **9/9 successful** |

## Contract Surface

```typescript
// @kr8tiv/mexc-spot
MEXCSpotClient.create({ secrets, baseUrl?, recvWindowMs? }) → Promise<MEXCSpotClient>
  .ping() → Promise<{ serverTime: number }>          // public, Zod-parsed
  .getAccountInfo() → Promise<AccountInfo>           // auth'd, Zod-parsed balance
  // NO order-placement in Phase 1 — Phase 2 adds placeMarketBuy etc.

// @kr8tiv/mexc-futures
MEXCFuturesClient.create({ secrets, baseUrl? }) → Promise<MEXCFuturesClient>
  .ping() → Promise<{ serverTime: number }>          // PUBLIC, no auth needed
  // NO order-placement in Phase 1 or 2 — Phase 6 adds placeFuturesOrder etc.
```

## Deviations from Plan

None — plan tasks executed as written, except the tests use the actual pattern from plan spec. One small improvement beyond plan: added `client.live.test.ts` exclusion to each package's `vitest.config.ts` so the default test run never hits live endpoints — matches plan spec (`MEXC_LIVE=1` gate) with defense-in-depth.

## Downstream Follow-ups

1. **Matt runs `pnpm setup:credentials`** to provision 3 Phase 1 secrets into Windows Credential Manager.
2. **Matt runs** `$env:MEXC_LIVE=1; pnpm -F "@kr8tiv/mexc-spot" test; pnpm -F "@kr8tiv/mexc-futures" test` to flip the 3 live tests green — live verifies:
   - spot ping gets a real `serverTime` from `api.mexc.com/api/v3/time`
   - spot `getAccountInfo()` returns real balances (your $10 should show up in `balance.total.USDT`)
   - futures ping gets a real `serverTime` from `contract.mexc.com/api/v1/contract/ping` (public, no auth)
3. After that, Plan 01-05 (`apps/core/boot.ts`) can safely chain `Promise.allSettled([spot.ping(), futures.ping()])` at boot.

## Self-Check

- 17 files created / 4 modified — all present on disk
- 3 atomic commits (`e2c385c` / `84b8c17` / `ffbc15a`)
- 20 unit tests green, 3 live tests cleanly gated
- 9/9 workspace typechecks green
- ccxt imported only in the 2 expected files (mexc-spot + mexc-futures)
- No `placeOrder` / `createOrder` / `cancelOrder` anywhere in `packages/mexc-*/src/`
- No hardcoded MEXC URLs in production source — flows through `env.MEXC_*_BASE_URL`

---
*Phase: 01-foundation · Completed: 2026-04-18*
