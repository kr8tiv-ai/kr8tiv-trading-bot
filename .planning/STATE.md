# State: kr8tiv-mexc-bot

**Created:** 2026-04-18
**Last updated:** 2026-04-18 (post-roadmap)

## Project Reference

- **Project doc:** `.planning/PROJECT.md`
- **Requirements:** `.planning/REQUIREMENTS.md`
- **Roadmap:** `.planning/ROADMAP.md`
- **Research:** `.planning/research/SUMMARY.md` (+ STACK, FEATURES, ARCHITECTURE, PITFALLS)

**Core Value:** Make Matt a better trader by surfacing what he already does well and correcting what he consistently does wrong — with a bot that never fires without his approval.

**Current focus:** Pre-Phase 1. Roadmap defined, awaiting kickoff of Phase 1 (Foundation: scaffold + secrets + MEXC read).

## Current Position

**Phase:** 0 (pre-kickoff — roadmap complete, no phase started)
**Plan:** None
**Status:** Roadmap approved; ready to run `/gsd:plan-phase 1`
**Progress:** 0/10 phases complete

```
[·] Phase 1: Foundation                                (0 plans)
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
- **Plans drafted:** 0
- **Plans executed:** 0
- **Phases complete:** 0
- **Live trades executed:** 0 (target: 1 by end of Phase 5 for Core Value validation)
- **Leak reports generated:** 0 (target: 1 stub by end of Phase 4)

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

### Open Todos (pre-Phase 1)

- [ ] Approve roadmap (orchestrator handles this before Phase 1 kickoff)
- [ ] Run `/gsd:plan-phase 1` to decompose Phase 1 into executable plans
- [ ] Before Phase 1 starts: verify MEXC account has a trading-only API key generated with IP whitelist for Matt's Windows machine
- [ ] Before Phase 1 starts: verify Matt's current ETH price and confirm ETHUSDT contract notional at 4x leverage is affordable on $10 bankroll (Pitfall 3 mitigation)

### Known Blockers

None at this stage. Blockers tracked here once they emerge during plan execution.

### Open Research Questions (flagged from SUMMARY.md)

- **Phase 1:** Confirm current active MEXC futures domain — migration happened Jan 12, 2026; base URL must match current docs. Config-driven, so low-risk.
- **Phase 6:** Verify Matt's MEXC account has futures API write permission enabled (public since Mar 31, 2026; key settings may still be spot-only).
- **Phase 7:** Confirm CryptoPanic free-tier quota floor at time of use (research shows 50-200 req/hr; design for 30/hr to stay under floor).
- **Phase 8:** Sample count only knowable after Phase 4 ingest. If Matt has <150 usable entries in 60d, consider extending lookback to 90d or deferring ML further.
- **Phase 10:** Evaluate Litestream vs rsync for SQLite sync; WireGuard vs SSH tunnel vs Tailscale for Redis exposure.

### Decisions Log (additions during execution)

Format: `YYYY-MM-DD | phase | decision | rationale`

(None yet — populated as plans execute.)

## Session Continuity

**Last session:** 2026-04-18 — Roadmap generated from 43 v1 + 32 v2 requirements with full traceability. 10-phase structure approved (honoring research SUMMARY.md's reconciled proposal). Weekend v1 = Phases 1-5; iteration = Phases 6-10.

**Next session entry point:** `/gsd:plan-phase 1` to begin Foundation phase decomposition.

**Handoff notes for next session:**
- Phase 1 has 11 REQs (FND-01..11) — scaffold + secrets + MEXC read + safety tooling. Largest REQ count of any phase.
- Plan-phase will need to decide plan granularity within Phase 1 — candidate split: (a) monorepo + SQLite + Redis scaffold, (b) SecretProvider + Windows Credential Manager, (c) MEXCSpotClient + MEXCFuturesClient (read-only), (d) boot-time smoke test + logging + gitleaks. But that's plan-phase's decision, not the roadmap's.
- Do NOT skip the gitleaks pre-commit hook setup (FND-10) — it must land before any commit that could touch a secret.
- Do NOT hardcode MEXC base URLs anywhere (FND-06, FND-07) — config-driven is load-bearing for the Jan 12, 2026 futures domain migration.

---
*State initialized: 2026-04-18*
