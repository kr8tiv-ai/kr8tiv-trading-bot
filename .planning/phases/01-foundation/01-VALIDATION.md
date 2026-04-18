---
phase: 1
slug: 01-foundation
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-17
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Extracted from `01-RESEARCH.md` §Validation Architecture. Mirrors the test map there and adds the Nyquist sign-off so Dimension 8 (Nyquist validation) can pass.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1+ |
| **Config file** | `vitest.config.ts` per package (minimal — inherits Turbo) + root `vitest.workspace.ts` (created in plan 01-01 Task 1) |
| **Quick run command** | `pnpm -F <pkg> test -- --run` (single package) |
| **Full suite command** | `pnpm turbo test` |
| **Coverage command** | `pnpm turbo test -- --coverage` (v8 reporter) |
| **Estimated runtime** | ~30 seconds full suite (dominated by Zowe Credential Manager round-trip in `@kr8tiv/secrets` + live Memurai ping in `@kr8tiv/redis-client`). `pnpm -F <pkg> test -- --run` on any single package: <10s. |

---

## Sampling Rate

- **After every task commit:** `pnpm turbo typecheck && pnpm turbo lint && pnpm turbo test -- --run` — all unit tests; excludes `.live.test.ts` (opt-in via `MEXC_LIVE=1`).
- **After every plan wave:** Full above + `MEXC_LIVE=1 pnpm smoke` — adds live MEXC round-trip once credentials are provisioned (Wave 2+).
- **Before `/gsd:verify-work`:** Full suite green + `pnpm smoke` exit 0 + `pnpm -F core test -- --run src/gitleaks.test.ts` passes + manual FND-11 checklist signed in `docs/phase-1-readiness.md`.
- **Max feedback latency:** ~30s full suite — safely under the 2-minute ceiling and well inside "fix now, not after context decays".

---

## Per-Task Verification Map

Columns mirror `01-RESEARCH.md` §Phase Requirements → Test Map. Each row maps a requirement to the plan that owns it and the automated command that proves it.

| Requirement | Plan | Wave | Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|---|---|
| FND-01 | 01-01 | 1 | pnpm + Turborepo monorepo boots; TS strict compiles | smoke | `pnpm turbo typecheck` | ❌ W0 (Plan 01-01 Task 1 creates `tsconfig.base.json`, `turbo.json`, `pnpm-workspace.yaml`) | ⬜ pending |
| FND-02 | 01-03 | 2 | SQLite opens in WAL + synchronous=FULL + foreign_keys=ON; FK enforcement fires | unit | `pnpm -F @kr8tiv/db test -- --run src/open.test.ts` | ❌ W0 (Plan 01-03 Task 2 creates the test) | ⬜ pending |
| FND-03 | 01-03 | 2 | `createRedis()` defaults + `pingOrThrow()` against live Memurai | unit + live | `pnpm -F @kr8tiv/redis-client test -- --run src/ping.test.ts` | ❌ W0 (Plan 01-03 Task 1) | ⬜ pending |
| FND-04 | 01-02 | 2 | SecretProvider reads/writes/lists/deletes via Windows Credential Manager | integration (test prefix) | `pnpm -F @kr8tiv/secrets test -- --run src/provider.test.ts` | ❌ W0 (Plan 01-02 Task 2) | ⬜ pending |
| FND-05 (automated) | 01-05 | 4 | Boot pre-flight reports ALL missing secrets in one log line | unit (mocked secrets) | `pnpm -F core test -- --run src/boot.test.ts -t "missing secrets"` | ❌ W0 (Plan 01-05 Task 1) | ⬜ pending |
| FND-05 (manual) | 01-02 | 2 | `pnpm verify-env` exits 0 when three secrets present | smoke | `pnpm verify-env` | ❌ W0 (Plan 01-02 Task 3) | ⬜ pending |
| FND-06 (unit) | 01-04 | 3 | MEXCSpotClient constructs with `defaultType:'spot'` + URL override | unit (ccxt mock) | `pnpm -F @kr8tiv/mexc-spot test -- --run src/client.test.ts` | ❌ W0 (Plan 01-04) | ⬜ pending |
| FND-06 (live) | 01-04 | 3 | MEXCSpotClient.ping() returns valid serverTime | integration (live, opt-in) | `MEXC_LIVE=1 pnpm -F @kr8tiv/mexc-spot test -- --run src/client.live.test.ts` OR `pnpm smoke` | ❌ W0 (Plan 01-04) | ⬜ pending |
| FND-06 (redaction) | 01-02 | 2 | Logger masks `apiKey` in emitted JSON | unit | `pnpm -F @kr8tiv/logger test -- --run src/redaction.test.ts -t "apiKey"` | ❌ W0 (Plan 01-02 Task 1) | ⬜ pending |
| FND-07 (unit) | 01-04 | 3 | MEXCFuturesClient constructs with `defaultType:'swap'`; independent rate bucket from spot | unit (ccxt mock) | `pnpm -F @kr8tiv/mexc-futures test -- --run src/client.test.ts` | ❌ W0 (Plan 01-04) | ⬜ pending |
| FND-07 (live) | 01-04 | 3 | MEXCFuturesClient.ping() returns valid serverTime | integration (live, opt-in) | `MEXC_LIVE=1 pnpm -F @kr8tiv/mexc-futures test -- --run src/client.live.test.ts` OR `pnpm smoke` | ❌ W0 (Plan 01-04) | ⬜ pending |
| FND-08 (boot contract) | 01-05 | 4 | Boot pings both endpoints in parallel via Promise.allSettled; BootError.stage="mexc" on either-fail | unit (all factories stubbed) | `pnpm -F core test -- --run src/boot.test.ts` | ❌ W0 (Plan 01-05 Task 1) | ⬜ pending |
| FND-08 (e2e) | 01-05 | 4 | `pnpm smoke` exits 0 against real Memurai + real MEXC + real Credential Manager | integration (live) | `pnpm smoke` | ❌ W0 (Plan 01-05 Task 2) | ⬜ pending |
| FND-09 | 01-02 | 2 | Pino redacts `apiKey`, `secret`, `token`, `apiSecret`, `req.headers["x-mexc-apikey"]`, `mexc.apiKey`, `telegramToken`, `walletAddress`, `**.secret`, etc. — ≥8 path families | unit | `pnpm -F @kr8tiv/logger test -- --run src/redaction.test.ts` | ❌ W0 (Plan 01-02 Task 1 creates the 11 tests) | ⬜ pending |
| FND-10 (automated) | 01-05 | 4 | `gitleaks protect --staged` rejects a planted `mx0testkey0123456789abcdef` fixture with finding id `mexc-access-key`; allows innocuous content | integration (subprocess) | `pnpm -F core test -- --run src/gitleaks.test.ts` | ❌ W0 (Plan 01-05 Task 3) | ⬜ pending |
| FND-10 (Telegram rule) | 01-01 | 1 | Gitleaks rule recognizes Telegram bot token format (`[0-9]{9,10}:[A-Za-z0-9_-]{35}`) | manual ritual | `gitleaks protect --staged --config=.gitleaks.toml` against a planted token fixture (documented in Plan 01-01 Task 3) | ❌ W0 — ritual in Plan 01-01; the automated Plan 01-05 gitleaks.test.ts can be extended in a future phase to also cover Telegram if the reviewer wants a second automated case | ⬜ pending |
| FND-11 | 01-06 | 5 | MEXC API key is trading-only + IP-whitelisted — confirmed by operator inspection of MEXC web UI | **manual-only** (no API exposes "has withdrawal permission") | Operator signs `docs/phase-1-readiness.md` with checked boxes + live `pnpm smoke` log line pasted | ❌ W0 (Plan 01-06 Task 2 checkpoint) | ⬜ pending |

*Status legend: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

The Wave-0 layer of each plan must create the test files below so subsequent tasks can exercise them. This list mirrors `01-RESEARCH.md` §Wave 0 Gaps (lines 1419-1433) with the B-3 fix applied (`gitleaks.test.ts` now owned by Plan 01-05, not orphaned).

- [ ] `vitest.workspace.ts` at repo root — declares `apps/*/vitest.config.ts` + `packages/*/vitest.config.ts` (Plan 01-01 Task 1)
- [ ] `packages/logger/src/redaction.test.ts` — covers FND-09 pino redaction patterns (Plan 01-02 Task 1)
- [ ] `packages/secrets/src/provider.test.ts` — covers FND-04 round-trip against test-prefix credentials (Plan 01-02 Task 2)
- [ ] `packages/redis-client/src/ping.test.ts` — covers FND-03 live PING + factory defaults (Plan 01-03 Task 1)
- [ ] `packages/db/src/open.test.ts` — covers FND-02 WAL + synchronous=FULL + FK enforcement (Plan 01-03 Task 2)
- [ ] `packages/mexc-spot/src/client.test.ts` — covers FND-06 CCXT constructor + URL override (Plan 01-04)
- [ ] `packages/mexc-spot/src/client.live.test.ts` — opt-in live spot ping (`MEXC_LIVE=1`) (Plan 01-04)
- [ ] `packages/mexc-futures/src/client.test.ts` — covers FND-07 CCXT constructor + independent rate bucket (Plan 01-04)
- [ ] `packages/mexc-futures/src/client.live.test.ts` — opt-in live futures ping (Plan 01-04)
- [ ] `apps/core/src/boot.test.ts` — covers FND-05 (missing-secret reporting) + FND-08 boot contract + IP-whitelist WARN + clock-skew WARN (Plan 01-05 Task 1)
- [ ] `apps/core/src/gitleaks.test.ts` — covers FND-10 automated subprocess verification (Plan 01-05 Task 3; closes the gap RESEARCH §Wave 0 Gaps line 1424 promised but no plan previously owned)
- [ ] `docs/phase-1-readiness.md` — FND-11 manual checklist with signed-off sign-off block (Plan 01-06 Task 1 drafts, Task 2 operator signs)
- [ ] `scripts/preflight-windows.ps1` — probes Node, pnpm, Memurai, gitleaks, Credential Manager targets (Plan 01-01 Task 2)
- [ ] `scripts/tsconfig.json` — scripts-only tsconfig so `tsc --noEmit --project scripts/tsconfig.json` typechecks `setup-credentials.ts` + `verify-env.ts` (Plan 01-02 Task 3)
- [ ] Framework install: `pnpm add -D -w vitest@^2 @vitest/coverage-v8@^2` — declared in root `package.json` (Plan 01-01 Task 1)

---

## Manual-Only Verifications

Only one requirement in this phase is structurally manual — FND-11. All other requirements have automated commands listed in the table above.

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MEXC API key has Trading ON / Withdrawals OFF / IP whitelisted | FND-11 | MEXC API does not expose "what permissions does this key have". Only the MEXC web UI (https://www.mexc.com/user/openapi) shows the permission checkboxes + whitelist. No automated probe can substitute for a human reading the web UI. | Operator opens MEXC web UI, checks the three permission/whitelist boxes on the API key matching `kr8tiv-mexc-bot/mexc-spot-access` (first 6 chars), edits `docs/phase-1-readiness.md` to tick every checkbox, pastes the live `pnpm smoke` `Phase 1 boot complete` log line into the evidence block, and commits the signed doc. See Plan 01-06 Task 2 for the exact checkpoint steps. |

*FND-10 Telegram-rule verification is currently listed as a manual ritual in Plan 01-01 Task 3 (plant a Telegram bot token fixture and run gitleaks by hand). This is acceptable for Phase 1 because the `mx0` rule — the one that directly guards MEXC keys — now has automated coverage via Plan 01-05's `gitleaks.test.ts`. If a future phase introduces Telegram credential flow (Phase 3), extend `gitleaks.test.ts` with a parallel subprocess assertion planting a Telegram token fixture.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify OR a Wave 0 dependency explicitly listed in §Wave 0 Requirements above
- [x] Sampling continuity: no 3 consecutive tasks without an automated verify (spot-check: Plan 01-05 Task 1 auto, Task 2 typecheck auto, Task 3 auto — all three waves chain through `pnpm turbo test -- --run`)
- [x] Wave 0 covers all MISSING references — gaps listed in RESEARCH §Wave 0 Gaps all resolved, plus the previously orphaned `apps/core/src/gitleaks.test.ts` now owned by Plan 01-05 Task 3
- [x] No watch-mode flags in any `<verify>` recipe (all use `--run`, no `vitest watch`)
- [x] Feedback latency < 60s (full suite ~30s — well under the 2-minute ceiling)
- [x] `nyquist_compliant: true` set in frontmatter above

**Approval:** pending — sign on green run of `pnpm turbo test -- --run && pnpm smoke && pnpm -F core test -- --run src/gitleaks.test.ts` + signed `docs/phase-1-readiness.md`.
