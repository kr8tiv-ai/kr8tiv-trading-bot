# Phase 1 Readiness Checklist — kr8tiv-mexc-bot

**Purpose:** Structural gate between Phase 1 (read-only surface) and Phase 2 (MEXC write path). Phase 2 wires real order placement; before that happens, Matt must personally verify the environment is sound.

When every checkbox is signed, Phase 1 is complete. Phase 2 planning/execution should not begin until this doc is signed.

---

## Signed by

```yaml
signed_by: [pending]
signed_at: [pending ISO timestamp]
```

To sign, replace `[pending]` with `Matt-Aurora-Ventures` and `[pending ISO timestamp]` with the current time, then commit the change.

---

## 1. MEXC API Key Permissions (FND-11)

**Matt's decision, logged 2026-04-18:** Using an existing **full-permission** MEXC API key (not the stricter trading-only + no-withdraw key the original plan specified). Risk accepted on the explicit understanding that:

- Key is stored in Windows Credential Manager only, never on disk
- Pino redaction prevents log leaks
- Gitleaks prevents commit-time leaks
- The bot has no `withdraw` code path — nothing in this codebase calls the withdraw API
- Review this decision before VPS deploy (Phase 10) if the key ever leaves this machine

### Check in the MEXC web UI (`mexc.com → Account → API Management`)

- [ ] **Key exists** under the API key with access ID matching Windows Credential Manager target `kr8tiv-mexc-bot/mexc-spot-access`
- [ ] **Trading permission:** ON (required — bot cannot place orders otherwise)
- [ ] **Read permission:** ON (required for `getAccountInfo()` and trade history in Phase 4)
- [ ] **Withdraw permission:** ON (accepted per 2026-04-18 decision — NOT the original plan's requirement)
- [ ] **Futures permission:** OFF expected (Phase 1), Matt may enable later for Phase 6
- [ ] **IP whitelist:** set to Matt's current public IP (see §3 below — run `pnpm smoke` and watch for the "IP whitelist matches" log line; a WARN means update the whitelist)

### Edge cases Matt must be aware of

- **ISP re-assigns your IP.** MEXC silently rejects requests with no useful error. `pnpm smoke` will still connect to public endpoints (ping works) but `getAccountInfo()` fails with a signature-ish error. Fix: re-whitelist the new IP in MEXC UI, then update the `mexc-whitelist-ip` secret (`pnpm setup:credentials` → overwrite just that one).
- **VPN / Tailscale turned on.** Public IP shifts to the VPN exit node. MEXC sees the new IP, fails auth. Fix: disconnect VPN, or whitelist the VPN exit too (risky — it's shared).
- **Keys without an IP whitelist auto-expire after 90 days.** Keys WITH a whitelist don't expire. Keeping the whitelist set = key stays valid indefinitely.

---

## 2. Windows Credential Manager Provisioning (FND-04, FND-05)

Run:
```powershell
cd C:\Users\lucid\Desktop\kr8tiv-mexc-bot
pnpm verify-env
```

**Expected:** exit 0 with three `[OK]` lines:
```
[OK]   kr8tiv-mexc-bot/mexc-spot-access
[OK]   kr8tiv-mexc-bot/mexc-spot-secret
[OK]   kr8tiv-mexc-bot/mexc-whitelist-ip
```

If any shows `[MISSING]`:
```powershell
pnpm setup:credentials
```
Then re-run `pnpm verify-env`.

- [ ] `pnpm verify-env` exits 0 with all three secrets present

---

## 3. End-to-End Smoke Test (FND-08)

**Prerequisite:** Redis reachable on `127.0.0.1:6379`. Either:
- Memurai installed: `winget install Memurai.MemuraiDeveloper` then `Start-Service Memurai`, or
- Portable Redis running (kr8tiv-mexc-bot default per STATE.md): `& "$env:USERPROFILE\tools\redis-portable\redis-server.exe" --port 6379 --maxmemory 256mb --maxmemory-policy noeviction` (runs as user process; no admin needed)

Run:
```powershell
pnpm smoke
echo $LASTEXITCODE
```

**Expected (success):**
```
INFO: boot starting { nodeVersion: "v22.x" or "v24.x", env: "development" }
INFO: redis connected { url: redis://127.0.0.1:6379 }
INFO: sqlite opened (WAL, synchronous=FULL, foreign_keys=ON) { path: ./data/core.sqlite }
INFO: MEXC spot ping OK { serverTime: <positive int> }
INFO: MEXC futures ping OK { serverTime: <positive int> }
INFO: IP whitelist matches current public IP
INFO: Phase 1 boot complete - all systems ready
INFO: smoke test passed
```
Exit code: **0**

**Failure modes (each exits non-zero with a specific log line — see Plan 01-05 SUMMARY for details):**
- Missing secrets → exit 1 with all missing names listed
- Redis unreachable → exit 1 with `Redis unreachable — is Memurai running?`
- Either MEXC ping fails → exit 2 with the failing endpoint logged
- Clock skew > 3s → WARN (not fatal) with `Local clock is ~Xms off MEXC server time`
- IP whitelist mismatch → WARN (not fatal)

### Paste the last run's exit code + final log line here

```
last_smoke_run_exit_code: [pending — paste integer]
last_smoke_run_last_log:  [pending — paste the "smoke test passed" line or the final FATAL line]
```

- [ ] `pnpm smoke` has been run on this machine
- [ ] Exit code was 0 (or the failure was expected and noted)
- [ ] The final log line showed `Phase 1 boot complete - all systems ready` (success case)

---

## 4. Structural Invariants (quick grep check)

Run these PowerShell one-liners and confirm the results match:

```powershell
# 1. ccxt imported from exactly 2 files
Select-String -Path "packages/**/*.ts","apps/**/*.ts" -Pattern 'from "ccxt"' | Measure-Object
# Expected: Count = 2 (packages/mexc-spot/src/client.ts + packages/mexc-futures/src/client.ts)

# 2. Zowe SDK imported from exactly 1 file
Select-String -Path "packages/**/*.ts","apps/**/*.ts" -Pattern '@zowe/secrets-for-zowe-sdk' | Measure-Object
# Expected: Count = 1 (packages/secrets/src/provider.ts)

# 3. No hardcoded MEXC URLs in production source
Select-String -Path "packages/**/src/**/*.ts","apps/**/src/**/*.ts" -Pattern 'https://api\.mexc\.com|https://contract\.mexc\.com' | Where-Object { $_.Line -notmatch '^\s*//' }
# Expected: zero lines of output (matches only appear in JSDoc comments + docs + fallback fetch using env.*)

# 4. No placeOrder / createOrder / cancelOrder anywhere in Phase 1 sources
Select-String -Path "packages/**/*.ts","apps/**/*.ts" -Pattern "placeOrder|createOrder|cancelOrder"
# Expected: zero matches in packages/mexc-* or apps/core
```

- [ ] All four grep assertions pass (counts match)

---

## 5. Commit Identity

```powershell
git config --local user.name
git config --local user.email
```

- [ ] `user.name` is `Matt-Aurora-Ventures`
- [ ] `user.email` is `lucidbloks@gmail.com`
- [ ] No commit in Phase 1's history has `Co-Authored-By: Claude` lines (`git log --all --grep "Co-Authored-By: Claude"` should return nothing)

---

## 6. Sign-Off

When every checkbox above is checked AND the "Signed by" block at the top is filled in, Phase 1 is complete. Commit the signed doc:

```powershell
git add docs/phase-1-readiness.md
git commit -m "docs(01-06): Phase 1 readiness signed by Matt-Aurora-Ventures"
```

Then proceed to `/gsd:execute-phase 2` (or the project's Phase 2 entry point).

---

*Plan: 01-06 · Phase: 01-foundation · Closes Phase 1 of the kr8tiv-mexc-bot milestone*
