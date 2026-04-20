---
phase: 02-execution-skeleton
plan: 06
subsystem: live-trade-proof
tags: [mexc-live, duplicate-rejection, runbook, checkpoint, phase-close]

requires: [01, 02, 03, 04, 05]
provides:
  - "MEXC_LIVE=1 gated integration test in packages/mexc-spot/src/client.live.test.ts — EXEC-02 duplicate-clientOrderId rejection capture"
  - "docs/phase-2-readiness.md — Matt's Steps A–H runbook mirroring phase-1-readiness.md format"
  - ".planning/phases/02-execution-skeleton/02-SUMMARY.md — Phase 2 close-out with EXEC-01..09 verification table (authored by Plan 02-06 Task 3)"
affects: [02-execution-skeleton]

key-files:
  created:
    - docs/phase-2-readiness.md
    - .planning/phases/02-execution-skeleton/02-SUMMARY.md (phase-level close-out)
  modified:
    - packages/mexc-spot/src/client.live.test.ts (added Phase 2 describe block with duplicate-rejection capture)

key-decisions:
  - "makeClientOrderId inlined in mexc-spot/client.live.test.ts to avoid mexc-spot ⇄ executor circular workspace dep (byte-identical to executor's version)"
  - "Live trade gated by MEXC_LIVE=1; default test runs stay mocked"
  - "Task 2 (human-verify live trade) deferred to operator — structural infrastructure is ready; Matt runs the runbook"

requirements-completed:
  - "EXEC-02 (live verification surface) — test authored, awaiting MEXC_LIVE=1 + Matt's runbook execution"
partial-requirements:
  - "Task 2 checkpoint:human-verify — Matt runs docs/phase-2-readiness.md Steps A–H, captures clientOrderId + duplicate-rejection code + panic cancel response into phase SUMMARY live-trade-evidence block, then signs"

commits:
  - "8320eb5 — test(02-06): live MEXC_LIVE=1 test for EXEC-02 duplicate-clientOrderId rejection (Task 1)"
  - "ec39402 — docs(02-06): Phase 2 close — SUMMARY + readiness runbook + REQUIREMENTS sweep (Task 3)"

duration: "~30 min inline (Tasks 1 + 3); Task 2 pending Matt"
completed: "2026-04-19 (Tasks 1 + 3 code-complete; Task 2 live-trade gate pending)"
---

# Plan 02-06 Summary — Live Trade Proof (Tasks 1 + 3 Complete, Task 2 Pending Matt)

## Tasks

**Task 1 (auto) — COMPLETE.** Added `describe.skipIf(!MEXC_LIVE)` block to `packages/mexc-spot/src/client.live.test.ts` that:
- Pulls exchangeInfo to compute `notional = 2 * minNotional` dynamically
- Refuses to run if account balance < notional (under-funded guard)
- Generates deterministic `clientOrderId` via inlined `makeClientOrderId`
- Places one real MEXC ETHUSDT market buy
- Retries the same clientOrderId 300ms later — expects MEXC duplicate-rejection error
- Writes structured `[DUPLICATE_REJECTION_CAPTURE]` JSON to stdout for back-filling the phase SUMMARY
- `finally` block fires cleanup cancel + market-close (bounded real-money exposure)

**Task 2 (checkpoint:human-verify) — PENDING MATT.** Runbook in `docs/phase-2-readiness.md`. Requires Matt to execute:

```powershell
Remove-Item Env:\NODE_ENV -EA 0
pnpm smoke                      # exit 0 expected
pnpm arm                        # flip executor:armed=true
pnpm dev                        # keep consumer loop running in one terminal
# In a second terminal:
pnpm place-order --side buy --notional <2 * minNotional>
# → record clientOrderId, fill response
# Retry the same clientOrderId — capture rejection code
pnpm panic                      # cancel + flatten
# → record cancel response + position-flat verification in MEXC UI
```

Then edit phase SUMMARY §Live-Trade Evidence, fill `signed_by:`, commit.

**Task 3 (auto) — COMPLETE.** Phase-level `02-SUMMARY.md` written with EXEC-01..09 verification table, EXEC-03 amendment note, live-trade-evidence placeholders. REQUIREMENTS.md updated (EXEC-01/02/04/05/06/07/08/09 marked `[x]`; EXEC-03 stays `[~]`). ROADMAP.md Phase 2 marked code-complete. STATE.md progress + decisions log updated.

## Self-Check

- ✅ Task 1 file modified + committed (8320eb5)
- ✅ Task 3 phase SUMMARY + runbook + REQ/ROADMAP/STATE all committed (ec39402)
- 🟡 Task 2 structurally ready; execution awaits Matt's runbook pass
- ✅ Circular dep avoided (makeClientOrderId inlined in test)
- ✅ 11/11 workspace typecheck green after fixes
- ✅ 35/35 mexc-spot tests green with MEXC_LIVE unset (live block cleanly skipped)

---
*Phase: 02-execution-skeleton · Plan 02-06 · Tasks 1+3 completed 2026-04-19, Task 2 live-trade checkpoint pending*
