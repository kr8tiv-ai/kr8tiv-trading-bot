---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-17T00:00:00.000Z"
progress:
  total_phases: 10
  completed_phases: 0
  total_plans: 6
  completed_plans: 1
---

# State: kr8tiv-mexc-bot

**Created:** 2026-04-18
**Last updated:** 2026-04-17 (post Plan 01-01 — scaffold landed, bootstrap pending)

## Project Reference

- **Project doc:** `.planning/PROJECT.md`
- **Requirements:** `.planning/REQUIREMENTS.md`
- **Roadmap:** `.planning/ROADMAP.md`
- **Research:** `.planning/research/SUMMARY.md` (+ STACK, FEATURES, ARCHITECTURE, PITFALLS)

**Core Value:** Make Matt a better trader by surfacing what he already does well and correcting what he consistently does wrong — with a bot that never fires without his approval.

**Current focus:** Phase 01 — foundation

## Current Position

Phase: 01 (foundation) — EXECUTING
Plan: 2 of 6 (next)
**Status:** Plan 01-01 scaffolded; awaiting Matt to run `scripts/bootstrap-phase-01-01.ps1` to finalize installs + atomic commits, then proceed to Plan 01-02
**Progress:** 1/6 plans in Phase 1 complete (scaffold landed)

```
[>] Phase 1: Foundation                                (1/6 plans — 01-01 scaffold authored)
[·] Phase 2: Execution Skeleton                        (0 plans)
[·] Phase 3: Telegram Approval Loop                    (0 plans)
[·] Phase 4: Style Fingerprint + Rule Signal + Leak    (0 plans)
[·] Phase 5: Ledger + Reconciler + First Live Trade    (0 plans)
--- end of weekend v1 ---
[·] Phase 6: Futures Write + Full Leak Suite           (0 plans)
[·] Phase 7: News Veto + On-chain Ingest               (0 plans)
[·] Phase 8: ML Signal (XGBoost/ONNX)                  (0 plans)
[·] Phase 9: Web + CLI Dashboards                      (0 plans)
[·] Phase 10: VPS Failover                             (0 plans)
```

## Performance Metrics

- **Requirements mapped:** 75/75 (43 v1 + 32 v2) — 100% coverage, zero orphans
- **Plans drafted:** 6 (Phase 1 fully decomposed)
- **Plans executed:** 1 (01-01 — scaffold landed; commits pending bootstrap run)
- **Phases complete:** 0
- **Live trades executed:** 0 (target: 1 by end of Phase 5 for Core Value validation)
- **Leak reports generated:** 0 (target: 1 stub by end of Phase 4)

| Plan  | Duration      | Tasks | Files | Notes                                                    |
| ----- | ------------- | ----- | ----- | -------------------------------------------------------- |
| 01-01 | authored 1 session | 3     | 19 created + 1 modified | Subprocess execution deferred to bootstrap-phase-01-01.ps1 |

## Accumulated Context

### Decisions (from PROJECT.md + research synthesis)

- **Execution venue:** MEXC only (spot + USDT-M futures) — two separate API clients from day 1 (different base URLs, different auth, different rate buckets).
- **Copilot framing:** Semi-auto with Telegram approval, never autonomous. Approval is the value, not the friction.
- **Local CPU ML only:** XGBoost/LightGBM via ONNX handoff to Node. No GPU, no cloud inference, no LLMs in the trade path.
- **Live from day 1:** $10 real bankroll. No paper mode. The $10 IS the test.
- **Pair whitelist v1:** ETHUSDT spot only. BTC + SOL + futures = Phase 6+.
- **Stack:** Node 22 LTS + TypeScript 5.5+ strict, pnpm workspaces + Turborepo, CCXT 4.5.48+, Redis 7.4+ (ioredis + BullMQ), better-sqlite3 11.7+ (WAL + synchronous=FULL), grammY for Telegram, @zowe/secrets-for-zowe-sdk for Windows Credential Manager, pino with redaction, gitleaks pre-commit.
- **Primary topology v1:** Windows-only, no VPS. VPS failover = Phase 10 after ≥1 week of stable local running.
- **Commit identity:** Matt-Aurora-Ventures <lucidbloks@gmail.com>. Never Claude. No Co-Authored-By lines.
- **Leak philosophy:** Every leak must be backed by ≥20 historical samples AND show negative expected value before it can veto a signal. Leak-flagged signals are surfaced with a conflict-note, never auto-blocked.
- **Phase ordering discipline:** Secrets + two-client MEXC before any order code. Risk manager before executor. Approval orchestrator before executor write path. Ledger before reconciler. Style fingerprint before signal generation. Spot write before futures write. VPS after ≥1 week of stable local operation.

### Open Todos (during Phase 1)

- [x] Approve roadmap (orchestrator handles this before Phase 1 kickoff)
- [x] Run `/gsd:plan-phase 1` to decompose Phase 1 into executable plans
- [x] Plan 01-01 — scaffold authored (all 19 files)
- [ ] **NEXT:** Matt runs `powershell -ExecutionPolicy Bypass -File scripts\bootstrap-phase-01-01.ps1` to install deps, run gitleaks acceptance tests, wire lefthook, and create 3 atomic commits
- [ ] Plan 01-02 — @kr8tiv/config + @kr8tiv/secrets + @kr8tiv/logger
- [ ] Plan 01-03 — @kr8tiv/redis-client + @kr8tiv/db
- [ ] Plan 01-04 — @kr8tiv/mexc-spot + @kr8tiv/mexc-futures
- [ ] Plan 01-05 — apps/core boot.ts + smoke.ts
- [ ] Plan 01-06 — docs/phase-1-readiness.md + docs/setup-windows.md
- [ ] Before Phase 5 starts: verify MEXC account has a trading-only API key generated with IP whitelist for Matt's Windows machine (FND-11)
- [ ] Before Phase 6 starts: verify Matt's current ETH price and confirm ETHUSDT contract notional at 4x leverage is affordable on $10 bankroll (Pitfall 3 mitigation)

### Known Blockers

- **Claude agent shell environment (resolved via deferred bootstrap):** Matt's Windows 11 machine has broken Git Bash / Cygwin (fork errors) which blocks the Claude agent from running ANY subprocess during plan execution. Mitigation baked into Plan 01-01: every subprocess step folded into `scripts/bootstrap-phase-01-01.ps1` which Matt runs once in PowerShell. Downstream plans (01-02+) that also need subprocess execution (e.g., `pnpm add` for new packages, running vitest) will follow the same deferred-bootstrap pattern unless the agent environment is fixed.

### Open Research Questions (flagged from SUMMARY.md)

- **Phase 1:** Confirm current active MEXC futures domain — migration happened Jan 12, 2026; base URL must match current docs. Config-driven, so low-risk.
- **Phase 6:** Verify Matt's MEXC account has futures API write permission enabled (public since Mar 31, 2026; key settings may still be spot-only).
- **Phase 7:** Confirm CryptoPanic free-tier quota floor at time of use (research shows 50-200 req/hr; design for 30/hr to stay under floor).
- **Phase 8:** Sample count only knowable after Phase 4 ingest. If Matt has <150 usable entries in 60d, consider extending lookback to 90d or deferring ML further.
- **Phase 10:** Evaluate Litestream vs rsync for SQLite sync; WireGuard vs SSH tunnel vs Tailscale for Redis exposure.

### Decisions Log (additions during execution)

Format: `YYYY-MM-DD | phase | decision | rationale`

- 2026-04-17 | Phase 1 Plan 01-01 | All subprocess execution (pnpm install, winget, lefthook install, gitleaks tests, atomic commits) folded into `scripts/bootstrap-phase-01-01.ps1` | Claude agent's Bash tool is completely non-functional on this machine (Cygwin fork errors on any command). Single idempotent PowerShell script preserves plan correctness while matching the one-command-user-runs operator pattern.
- 2026-04-17 | Phase 1 Plan 01-01 | Per-package `typescript` dep uses `^5.7` literal, not `workspace:*` | TypeScript is installed at root via `pnpm add -D -w`, not as a published workspace package; `workspace:*` would fail to resolve.
- 2026-04-17 | Phase 1 Plan 01-01 | Bootstrap commits use `--no-verify` | lefthook is installed DURING the same script run; hooks only apply to subsequent commits, not the bootstrap commits themselves. Per plan critical_rules #7.

## Session Continuity

**Last session:** 2026-04-17 — Plan 01-01 authored (all 19 files) via Claude agent. Subprocess execution (installs, typecheck, hook-wiring, atomic commits) folded into `scripts/bootstrap-phase-01-01.ps1` due to broken agent shell; Matt runs that script once to land the 3 atomic commits.

**Next session entry point:**

1. Matt runs `powershell -ExecutionPolicy Bypass -File scripts\bootstrap-phase-01-01.ps1` from the repo root.
2. On success (3 commits created, typecheck green, gitleaks acceptance tests pass), run `/gsd:execute-phase` to start Plan 01-02 — or `/gsd:execute-plan 01-02` to run just the next plan.

**Handoff notes for next session:**

- Phase 1 has 11 REQs (FND-01..11). Plan 01-01 satisfied FND-01 and FND-10. Plan 01-02 targets FND-04, FND-05, FND-09. Plan 01-03 targets FND-02, FND-03. Plan 01-04 targets FND-06, FND-07. Plan 01-05 targets FND-08. Plan 01-06 targets FND-11 (operator checklist + runbook).
- Do NOT hardcode MEXC base URLs anywhere (FND-06, FND-07) — config-driven is load-bearing for the Jan 12, 2026 futures domain migration.
- If Matt hits any error running `bootstrap-phase-01-01.ps1`, the script fails loud with a clear message; each step is idempotent so re-running after a fix picks up where it stopped.
- SecretName union in `packages/shared-types/src/index.ts` is the source of truth for Plan 01-02's SecretProvider — do not diverge.

---
*State initialized: 2026-04-18*
