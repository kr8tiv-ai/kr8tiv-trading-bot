---
phase: 02
slug: execution-skeleton
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-18
source: 02-RESEARCH.md §Validation Architecture
---

# Phase 2 — Validation Strategy

Per-phase validation contract for feedback sampling during execution. Distilled from 02-RESEARCH.md §Validation Architecture (lines 1207–1236) to the standalone artifact Nyquist Dimension 8 requires.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.9 (already installed at workspace level by Plan 01-02 + extended in Plan 01-05) |
| **Config file** | Each new package gets its own `vitest.config.ts` mirroring `packages/logger/vitest.config.ts` pattern (exclude `*.live.test.ts` when present) |
| **Quick run command** | `pnpm -F <package> test` per-package after task commits |
| **Full suite command** | `pnpm turbo test` (10 packages after Phase 2 → 11 with @kr8tiv/executor) |
| **Typecheck** | `pnpm turbo typecheck` after each task |
| **Estimated runtime** | Quick: ~5s per package. Full: ~30s. Live MEXC path: 15-60s depending on network. |
| **Live gate** | `MEXC_LIVE=1` env var mirrors Plan 01-04 pattern. Default runs stay mocked. |
| **Redis dependency** | Portable Redis 5.0.14 at 127.0.0.1:6379 (per docs/setup-windows.md Path B). Tests that need real Redis use `describe.skipIf(!REDIS_UP)` with module-scope TCP probe (mirrors Plan 01-03). |

---

## Sampling Rate

- **After every task commit:** Run `pnpm -F <affected_package> test` (quick per-package)
- **After every plan wave:** Run `pnpm turbo test` (full workspace)
- **After Wave 6 (Plan 02-06 Task 1):** Run `$env:MEXC_LIVE=1; pnpm -F @kr8tiv/mexc-spot test` — live duplicate-rejection proof
- **Before `/gsd:verify-work`:** Full suite green + one successful `pnpm smoke` run
- **Max feedback latency:** 30 seconds for workspace, ~2 minutes including live tests

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | EXEC-02, EXEC-04, EXEC-05 | unit | `pnpm -F @kr8tiv/shared-schemas test` (verifies new order/fill/exchangeInfo Zod schemas) | ✓ at Wave 0 | ☐ pending |
| 02-01-02 | 01 | 1 | EXEC-08 | unit | `pnpm -F @kr8tiv/executor test -- executor-state.test.ts` (verifies SQLite DDL + initialState) | ☐ W0 (executor pkg fresh) | ☐ pending |
| 02-02-01 | 02 | 2 | EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06 | unit + structural grep | `pnpm -F @kr8tiv/mexc-spot test` + `Select-String "stopPrice|triggerPrice" packages/mexc-spot/src/client.ts` (must be 0 matches) | ✓ existing pkg | ☐ pending |
| 02-03-01 | 03 | 3 | EXEC-02, EXEC-05, EXEC-08 | unit | `pnpm -F @kr8tiv/executor test -- idempotency fees ledger` | ☐ W0 | ☐ pending |
| 02-03-02 | 03 | 3 | EXEC-01, EXEC-04, EXEC-06, EXEC-07 | unit | `pnpm -F @kr8tiv/executor test -- risk-manager breaker panic` | ☐ W0 | ☐ pending |
| 02-03-03 | 03 | 3 | EXEC-09 | unit + integration | `pnpm -F @kr8tiv/executor test -- handler consumer` (includes `describe.skipIf(!REDIS_UP)` live PEL-replay test) | ☐ W0 | ☐ pending |
| 02-04-01 | 04 | 4 | EXEC-07, EXEC-08 | CLI smoke | `pnpm panic; pnpm arm` against a test-prefix Redis key — verify Redis key flips | ☐ needs Redis | ☐ pending |
| 02-04-02 | 04 | 4 | EXEC-08 | CLI smoke | `pnpm reconcile` against stale state — verify Redis overwrite + `reconciled_at` set | ☐ needs Redis | ☐ pending |
| 02-05-01 | 05 | 5 | EXEC-08, EXEC-09 | unit | `pnpm -F core test -- boot.test.ts` — executor subscription + stale-state refuse + Step 12 gate | ✓ existing pkg | ☐ pending |
| 02-05-02 | 05 | 5 | EXEC-09 | CLI integration | `pnpm place-order --side buy --notional 10 --dry-run` — verify full pipeline writes all 4 streams (signals.candidate → filtered → approvals.pending → decided) | ☐ W0 dry-run mode | ☐ pending |
| 02-06-01 | 06 | 6 | EXEC-02, EXEC-06 | **LIVE MEXC** (gated) | `$env:MEXC_LIVE=1; pnpm -F @kr8tiv/mexc-spot test -- client.live.test.ts` — expects duplicate-rejection error from real MEXC on retry | ✓ client.live.test.ts | ☐ pending |
| 02-06-02 | 06 | 6 | EXEC-02, EXEC-03, EXEC-04, EXEC-07 | **CHECKPOINT:human-verify** | Matt runs `pnpm place-order --side buy --notional 10 → pnpm panic` on real MEXC. Captures clientOrderId, duplicate-reject response, panic cancel response into SUMMARY. | N/A — runbook | ☐ pending |
| 02-06-03 | 06 | 6 | EXEC-08, EXEC-09 | documentary | Creates 02-SUMMARY.md with live-run data; grep for "EXEC-03 amendment" + "DUPLICATE_REJECTION_CAPTURE" | N/A | ☐ pending |

*Status: ☐ pending → ✓ green → ✗ red → ⚠ flaky*

---

## Wave 0 Requirements

Before Wave 1 begins:

- [x] **vitest 2.1.9** — already installed at root + each package from Plan 01-02 onward; Plan 02-01 will reuse via `"vitest": "^2.1"` devDep
- [x] **better-sqlite3 12.x + @types/better-sqlite3** — already installed from Plan 01-03; reused by @kr8tiv/executor's ledger tests
- [x] **ioredis 5.4+** — already installed from Plan 01-03; reused by @kr8tiv/executor's stream consumer
- [x] **pino 9.5+** — already installed from Plan 01-02; executor uses `createLogger()` from @kr8tiv/logger
- [x] **Portable Redis running** on 127.0.0.1:6379 — already started this session per STATE.md Known Blockers resolution
- [ ] **@kr8tiv/executor vitest.config.ts** — Plan 02-01 Task 2 creates (excludes `*.live.test.ts`, environment: node, testTimeout: 10000)
- [ ] **Root package.json script entries** for `panic`, `arm`, `reconcile`, `place-order` — per C-2 resolution: all 4 pre-added at Wave 1 OR added atomically in Wave 5 after 02-04 completes (current plan: add in respective waves + 02-05 now depends on 02-04)

*Existing Phase 1 infrastructure covers all test framework requirements. @kr8tiv/executor is a fresh package but reuses the established vitest + @types/better-sqlite3 + ioredis pattern.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MEXC accepts real duplicate-clientOrderId with an error response | EXEC-02 | Real exchange behavior can't be faithfully mocked — the error CODE is the empirical finding Matt captures | Plan 02-06 Task 2: `pnpm place-order --side buy --notional $(2*minNotional)` → record clientOrderId from stdout → `pnpm place-order` **same clientOrderId** (override via env or test harness) → expect non-zero exit with error code. Paste code + message into 02-SUMMARY.md `duplicate_rejection_capture` frontmatter field. |
| Server-side stop visible in MEXC UI | EXEC-03 (amended) | EXEC-03 amended to defer server-side stops to Phase 6 — manual verification point is that NO stop order is created (confirms the amendment is architecturally preserved) | Plan 02-06 Task 2: during live trade, open MEXC web UI → Spot → Open Orders → confirm NO stop/trigger order exists alongside the entry. Note in SUMMARY's `exec_03_amendment_confirmed` field. |
| `pnpm panic` actually cancels on real MEXC | EXEC-07 | Cancel API response format is MEXC-specific + timing of matching-engine unwind is observable only live | Plan 02-06 Task 2: after `pnpm place-order`, immediately `pnpm panic`. Capture cancel response, confirm via MEXC UI that no orders remain. Record in SUMMARY's `panic_cancel_capture` field. |
| Full 4-stream pipeline writes with real Redis | EXEC-09 | Architectural invariant requires real stream I/O round-trip (not mock) | Plan 02-05 Task 2 tests against portable Redis: `redis-cli --scan --pattern "signals.*"` + similar for `approvals.*` during test — verify all 4 streams have ≥1 entry after a test `pnpm place-order` run |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify command OR explicit Wave 0/manual-verify dependency
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (all infrastructure deps satisfied by Phase 1 packages)
- [x] No watch-mode flags in plan acceptance criteria (only `--run` or explicit single-shot invocations)
- [x] Feedback latency < 30s for workspace suite, ~2min for live tests
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** drafted 2026-04-18 — pending Matt sign-off at Phase 2 close-out (Plan 02-06 Task 2 checkpoint)

---

## Manual verifications gate these as unavoidable real-world signals

Plan 02-06 is marked `autonomous: false` specifically because its Task 2 cannot be automated — real money moves through MEXC. The 4 manual-only verification rows above collapse into one runbook execution: `pnpm place-order → observe → pnpm panic → observe → record`. That single runbook is the structural close of Phase 2.

No behavior in Phase 2 is manual-ONLY *and* doesn't also have a corresponding automated test running against mocks. The manual verifications are live-MEXC proofs on top of the automated substrate, not substitutes for it.
