---
phase: 01-foundation
plan: 03
subsystem: foundation
tags: [typescript, ioredis, better-sqlite3, wal, redis, sqlite, vitest]

requires: [01, 02]
provides:
  - "@kr8tiv/redis-client — ioredis factory (lazyConnect + maxRetriesPerRequest:3) + pingOrThrow helper for boot-time FND-03 smoke test"
  - "@kr8tiv/db — better-sqlite3 open helper enforcing WAL + synchronous=FULL + foreign_keys=ON + closeDatabase that WAL-checkpoints before close"
  - "data/.gitkeep — tracked so sqlite path exists on fresh clone"
affects: [01-foundation]

tech-stack:
  added:
    - "ioredis ^5.4"
    - "better-sqlite3 ^12.0.0 (plan specified ^11.7 — bumped to ^12 because 11.x has no prebuilt binaries for Node 24.13.1 and Matt has no VS Build Tools)"
    - "@types/better-sqlite3 ^7.6"
  patterns:
    - "Client factory layering: ioredis + better-sqlite3 imported ONLY inside their owning packages; downstream plans consume via createRedis / openDatabase"
    - "Conditional live tests via vitest describe.skipIf + synchronous TCP probe (port 6379) at module scope — unit tests still run without Memurai"

key-files:
  created:
    - packages/redis-client/package.json
    - packages/redis-client/tsconfig.json
    - packages/redis-client/vitest.config.ts
    - packages/redis-client/src/factory.ts
    - packages/redis-client/src/index.ts
    - packages/redis-client/src/ping.test.ts
    - packages/db/package.json
    - packages/db/tsconfig.json
    - packages/db/vitest.config.ts
    - packages/db/src/open.ts
    - packages/db/src/index.ts
    - packages/db/src/open.test.ts
    - data/.gitkeep
  modified:
    - .gitignore (append `!data/.gitkeep` negation)
    - pnpm-lock.yaml

key-decisions:
  - "better-sqlite3 ^11.7 → ^12.0.0 — 11.10.0 has no Node 24 prebuilts and node-gyp fallback requires VS Build Tools Matt doesn't have. 12.x includes Node 24 prebuilts."
  - "ioredis type import pattern: `import { Redis, type RedisOptions } from \"ioredis\"` (named export) instead of plan-spec'd `import Redis, ...` default import — the latter trips TS2709 under verbatimModuleSyntax because `Redis` the default export is a namespace-ish thing, not a type. Named import works cleanly."
  - "Live Redis tests (#4, #5 in plan spec) made conditional via `describe.skipIf(!REDIS_UP)` with a 300ms TCP probe at module scope — Memurai isn't installed on this machine, so live tests skip cleanly. Unit tests (constructor defaults, override URL) still run."
  - "`data/` directory tracked via `data/.gitkeep` + `!data/.gitkeep` negation in .gitignore — `git add` needed `-f` force flag because the ignore rule is evaluated after the negation at the directory level."

patterns-established:
  - "TCP probe at module scope to gate live-service tests (applicable to MEXC health check tests in Plan 01-04)"
  - "Invariant: `from \"ioredis\"` only in packages/redis-client/src/factory.ts (1 match across repo)"
  - "Invariant: `from \"better-sqlite3\"` only in packages/db/src/open.ts (1 match across repo)"

requirements-completed: [FND-02, FND-03]
partial-requirements:
  - "FND-03 automated assertion: live Redis PING is behind Memurai install — unit tests prove factory defaults, live PING verified once Matt runs `winget install MemuraiDeveloper` + `Start-Service Memurai` + `pnpm -F @kr8tiv/redis-client test`. Expected to surface 2 passing live tests (currently skipped)."

commits:
  - "f6a7532 — feat(01-03): @kr8tiv/redis-client ioredis factory + pingOrThrow (FND-03)"
  - "c618cc9 — feat(01-03): @kr8tiv/db better-sqlite3 WAL + synchronous=FULL + foreign_keys=ON (FND-02)"
  - "1be7211 — chore(01-03): track data/.gitkeep so SQLite path exists on fresh clone"

duration: "~25 min inline via PowerShell MCP"
completed: 2026-04-18
---

# Plan 01-03 Summary — @kr8tiv/redis-client + @kr8tiv/db

Two persistence primitive packages: an ioredis factory with boot-time ping helper (FND-03) and a better-sqlite3 open helper that enforces the WAL + synchronous=FULL + foreign_keys=ON pragmas (FND-02).

## Test outcomes

| Package | Tests | Result |
|---------|-------|--------|
| @kr8tiv/db | 7 | **7 passed** (creates file, WAL set, synchronous=FULL=2, foreign_keys=1, mkdir recursive, close+reopen clean, FK fires) |
| @kr8tiv/redis-client | 6 | **4 passed, 2 skipped** (skipped: live PING — Memurai not installed) |
| turbo typecheck | 7 packages | **7/7 successful** |

## Deviations

1. **better-sqlite3 11→12:** Node 24 + no VS Build Tools blocked 11.10.0's node-gyp fallback. Bumped to ^12.0.0 which ships Node 24 prebuilts.
2. **ioredis default-import → named-import:** `verbatimModuleSyntax` refused the plan's `import Redis, {...}` pattern with TS2709 (Redis the default is a namespace-ish shape, not a plain class type). Switched to `import { Redis, type RedisOptions } from "ioredis"` — same behavior, cleaner types.
3. **Live Redis tests made conditional:** Memurai not installed → added module-scope TCP probe on 6379 + `describe.skipIf(!REDIS_UP)`. Unit tests still prove constructor defaults. Live tests re-activate the moment Matt runs `Start-Service Memurai`.
4. **data/.gitkeep force-added:** Plan said add `!data/.gitkeep` negation; in practice gitignore evaluates `data/` against the directory itself before file-level negation can take effect, so `git add -f` was needed. Once committed, future pulls see the file normally.

## Next-session follow-ups

- Matt: `winget install MemuraiDeveloper` → `Start-Service Memurai` → `pnpm -F @kr8tiv/redis-client test` to flip 2 skipped tests to green (closes FND-03 live-verification gap).
- Plan 01-04 can now consume `createRedis()` and `openDatabase()` from these packages; no direct ioredis / better-sqlite3 imports anywhere else.

## Self-check

- 13 files created, all verified
- 3 atomic commits landed (`f6a7532`, `c618cc9`, `1be7211`)
- 11 tests passing overall (4 redis unit + 7 db) + 2 skipped (live redis, conditional)
- 7/7 workspace typecheck green
- `from "ioredis"` appears only in `packages/redis-client/src/factory.ts` (invariant holds)
- `from "better-sqlite3"` appears only in `packages/db/src/open.ts` (invariant holds)

---
*Phase: 01-foundation · Completed: 2026-04-18*
