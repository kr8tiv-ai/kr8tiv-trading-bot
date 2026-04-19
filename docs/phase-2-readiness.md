# Phase 2 Readiness Checklist — kr8tiv-mexc-bot

**Purpose:** Structural gate between Phase 2 (MEXC spot write path + safety rails) and Phase 3 (Telegram approval loop). Phase 3 replaces the `approvals.pending → approvals.decided` link with a real Telegram round-trip; before that happens, Matt must personally verify that the Phase 2 live-trade proof works end-to-end against real MEXC — one real ETHUSDT market buy, observe MEXC reject the duplicate-clientOrderId re-submission, then `pnpm panic` to cancel + flatten.

When every checkbox below is signed, Phase 2 is complete. Phase 3 planning/execution should not begin until this doc is signed.

This runbook is the same live-trade proof referenced in `.planning/phases/02-execution-skeleton/02-06-PLAN.md` Task 2. Estimated operator time: 15-30 minutes. Real-money exposure: ≤ 2 × minNotional USDT (≈ $10-$11) for < 60 seconds.

---

## Signed by

```yaml
signed_by:
signed_at:
signature_scope:
```

---

## 0. Prerequisites (one-time, before running any step below)

- [ ] **Phase 1 signed off.** See `docs/phase-1-readiness.md`. Phase 2 cannot start until Phase 1's readiness doc is signed.
- [ ] **Redis is running on 127.0.0.1:6379.** Either Memurai service OR portable Redis. If portable:
  ```powershell
  Start-Process -FilePath "$env:USERPROFILE\tools\redis-portable\redis-server.exe" `
    -ArgumentList "--port","6379","--maxmemory","256mb","--maxmemory-policy","noeviction" `
    -WindowStyle Hidden
  ```
  See `docs/setup-windows.md` for the portable-Redis install.
- [ ] **Secrets are provisioned.** Run `pnpm verify-env` — expect exit 0 with `[OK]` lines for `mexc-spot-access`, `mexc-spot-secret`, `mexc-whitelist-ip`. If anything is `[MISSING]`, run `pnpm setup:credentials` and re-verify.
- [ ] **MEXC Spot account is funded.** At least **2 × ETHUSDT minNotional USDT** free. At current ETH prices MEXC's market-buy minNotional on ETHUSDT is typically ~$5 USDT, so have **≥ $11 USDT free** to be safe. The Phase 2 live-test will refuse to run if under-funded (checks via `getAccountInfo()` before any order placement).
- [ ] **MEXC API key IP whitelist matches current public IP.** Boot's Step 9 warns if mismatched. If you see `WARN IP whitelist mismatch`, update the whitelist in the MEXC UI (API Management → edit key → IP whitelist) before proceeding.

---

## 1. Step A — Baseline smoke test (no real trade yet)

Run:
```powershell
cd C:\Users\lucid\Desktop\kr8tiv-mexc-bot
pnpm smoke
echo $LASTEXITCODE
```

**Expected (success — exit 0):**
```
INFO  redis connected
INFO  sqlite opened (WAL, synchronous=FULL, foreign_keys=ON)
INFO  MEXC spot ping OK
INFO  MEXC futures ping OK
INFO  IP whitelist matches current public IP
INFO  executor NOT armed (first-run expected) OR executor armed
INFO  executor listening on approvals.decided
INFO  Phase 2 boot complete - all systems ready
INFO  smoke test passed
```

- [ ] `pnpm smoke` exited 0
- [ ] Log showed "executor listening on approvals.decided" (Phase 2 Step 12 wiring)

**Failure modes (exit codes per Plan 02-05's contract):**
- Exit 1 = pre-flight (missing secrets, Redis unreachable, SQLite open failed) — fix via `pnpm setup:credentials` / start Redis
- Exit 2 = MEXC ping failed — check network, IP whitelist, key permissions
- Exit 3 = stale-state detected — run `pnpm reconcile` first, then retry smoke

---

## 2. Step B — Arm the executor

Run:
```powershell
pnpm arm
echo $LASTEXITCODE
```

**Expected:** exit 0 with message similar to:
```
INFO  executor ARMED — Next approved signal will fire a real order if MEXC_LIVE=1.
```

Verify Redis + SQLite state both reflect armed=true:
- Redis: `executor:armed` = `"true"` (Plan 02-04's arm.ts writes this)
- SQLite: `executor_state` row with key=`armed`, value=`true` (durability backstop)

- [ ] `pnpm arm` exited 0
- [ ] Confirmation log line visible

---

## 3. Step C — Start the core process (separate window)

Open a **second** PowerShell window (leave Step B's window open). In the second window:

```powershell
cd C:\Users\lucid\Desktop\kr8tiv-mexc-bot
pnpm dev
```

Leave this running. `pnpm dev` boots the core + starts the executor consumer loop on `approvals.decided` via a dedicated Redis connection (per Pitfall 9).

Expected log sequence:
```
INFO  Phase 2 boot complete - all systems ready
INFO  executor listening on approvals.decided
```

Then the process idles (XREADGROUP BLOCK 5000 on the approvals.decided stream).

- [ ] `pnpm dev` is running in window 2
- [ ] Last log line is `executor listening on approvals.decided`

---

## 4. Step D — Live-trade proof via MEXC_LIVE=1 live test

Open a **third** PowerShell window. This is where the real-money call happens.

```powershell
cd C:\Users\lucid\Desktop\kr8tiv-mexc-bot
$env:MEXC_LIVE = "1"
pnpm --filter @kr8tiv/mexc-spot test -t "EXEC-02 duplicate clientOrderId"
```

The test (in `packages/mexc-spot/src/client.live.test.ts`) will:
1. Pull `exchangeInfo.quoteAmountPrecisionMarket` for ETHUSDT → compute `notional = 2 * minNotional`.
2. Check `getAccountInfo().free.USDT ≥ notional` — refuses to run if under-funded.
3. Generate `clientOrderId = makeClientOrderId(randomUUID(), Date.now())` (sha256 truncated to 32 hex chars — the same generator the executor uses).
4. Call `placeMarketBuy({ symbol: "ETHUSDT", clientOrderId, quoteOrderQty: notional })` — **this is the real MEXC order**.
5. Wait 300ms, then re-submit the SAME clientOrderId — expect MEXC to reject.
6. Capture the rejection error code + message and write `[DUPLICATE_REJECTION_CAPTURE]` JSON to stdout.
7. In a `finally` block: cancel any open orders for the clientOrderId AND flatten any resulting ETH balance via `placeMarketSell` with a `cleanup-*` clientOrderId prefix.

**Expected stdout lines (in order):**
```
[Phase 2 live proof] minNotional = <value> USDT, firing at notional = <2*value> USDT
[Phase 2 live proof] signalId=<uuid> clientOrderId=<32hex> notional=<value>
[Phase 2 live proof] first-order ACCEPTED — exchangeOrderId=<id> filled=<eth_qty>
[Phase 2 live proof] duplicate-rejection captured — msg=<error message>

[DUPLICATE_REJECTION_CAPTURE] {"signalId":"<uuid>","clientOrderId":"<32hex>","exchangeOrderId":"<id>","errorMessage":"<msg>","errorName":"<name>"}

[Phase 2 live proof] cleanup: cancelled <clientOrderId>   (or "no open orders to cancel")
[Phase 2 live proof] cleanup: flattened <eth_qty> ETH via cleanup-<hex>
Final line: 1 passed (or "1 passed" with a console.warn about unexpected signature)
```

**Capture for Task 3 (paste into 02-SUMMARY.md):**
- [ ] The full `[DUPLICATE_REJECTION_CAPTURE]` JSON line (verbatim, copy from stdout)
- [ ] `minNotional` value (the ETHUSDT `quoteAmountPrecisionMarket` MEXC returned)
- [ ] First-order `exchangeOrderId` and `filled` quantity
- [ ] Cleanup flatten quantity (ETH) and cleanup clientOrderId

**If the test FAILS loudly with "EXEC-02 INVALIDATED":** STOP. MEXC accepted the duplicate clientOrderId. This is a critical finding. Do NOT proceed to Step F. Investigate:
- Is the clientOrderId actually being forwarded as `newClientOrderId` in the MEXC order payload? Check `packages/mexc-spot/src/client.ts` `placeMarketBuy` impl.
- Is MEXC actually receiving the same value on both calls? Enable debug logging: `$env:NODE_DEBUG="ccxt"` and re-run, inspect the POST body.
- File a blocker in STATE.md, do NOT sign this doc.

---

## 5. Step E — Independent MEXC UI verification

Open MEXC web UI → **Spot** → **Order History**. Verify:

- [ ] Exactly ONE filled market BUY order with your captured `exchangeOrderId` at notional ≈ 2 × minNotional
- [ ] Matching `clientOrderId` visible in the order detail view (our 32-hex key)
- [ ] **No second row** with the same clientOrderId — the duplicate was rejected by MEXC (not silently accepted)
- [ ] A `cleanup-*` market SELL order visible (flattening the ETH balance)
- [ ] Current ETH balance = 0 (or back to pre-trade baseline, if there was any)
- [ ] USDT balance dropped by approximately `notional + fee` (the round-trip cost — the Phase 2 operating expense)

**Screenshot (optional, for archival):** capture the Order History page with timestamps visible. Save as `.planning/phases/02-execution-skeleton/evidence/mexc-ui-post-test.png`. The `evidence/` directory is ignored in git (contains balance info); do NOT commit.

- [ ] MEXC UI observation recorded in notes below

---

## 6. Step F — Run `pnpm panic` (idempotent verification)

Back in window 1 (or any free PowerShell):

```powershell
pnpm panic
echo $LASTEXITCODE
```

**Expected:** exit 0 with a PanicReport JSON to stdout. Something like:
```json
{
  "frozen": true,
  "cancelled": [],
  "flattenedQty": 0,
  "flattenedClientOrderId": null,
  "errors": []
}
```

(The Step D cleanup `finally` already cancelled + flattened, so `cancelled: []` and `flattenedQty: 0` are expected. The critical field is `frozen: true`.)

**Then re-run immediately** to prove idempotency:

```powershell
pnpm panic
echo $LASTEXITCODE
```

**Expected:** exit 0 with identical output. `executor:armed` in Redis stays `false`. No errors.

- [ ] First `pnpm panic` exited 0 with `frozen: true`
- [ ] Second `pnpm panic` exited 0 with identical output (idempotent)
- [ ] Redis `executor:armed` = `false`

**Capture for 02-SUMMARY.md:**
- [ ] Both PanicReport JSON bodies (copy verbatim)

---

## 7. Step G — Shut down `pnpm dev` gracefully

In window 2, press **Ctrl+C**.

**Expected:**
- Log line: `INFO  shutting down { signal: "SIGINT" }`
- Log line: `INFO  executor stopped` (stopExecutor disconnects the consumerRedis, unblocking the XREADGROUP BLOCK 5000 loop)
- Log line: `INFO  sqlite closed`
- Process exits cleanly (no hang — without the Plan 02-05 dev.ts teardown fix, Ctrl+C would hang up to 5 seconds per BLOCK cycle)
- Exit code 0

- [ ] Ctrl+C caused graceful shutdown within 1 second
- [ ] Process exited without hanging
- [ ] No unhandled-error stack traces in the log

---

## 8. Step H — Final state verification

Independent of the CLIs, verify final state:

- [ ] MEXC Spot Order History shows the full cycle: market BUY + duplicate-rejected (may not be visible; error-only) + market SELL cleanup
- [ ] MEXC Spot balance: USDT decreased by ≈ `notional + fee`; ETH at 0 (or pre-trade baseline)
- [ ] Redis `executor:armed` = `false` (`redis-cli GET executor:armed` shows "false")
- [ ] SQLite `executor_state` has a row with `key='armed'`, `value='false'` (durability backstop)
- [ ] Real-money exposure was bounded to < 60 seconds from first-order fill to cleanup-flatten completion

---

## 9. Paste Captured Evidence Here

This section is what gets mirrored into `.planning/phases/02-execution-skeleton/02-SUMMARY.md` by Task 3.

### ETHUSDT exchangeInfo snapshot (Step D)

```
minNotional (quoteAmountPrecisionMarket):
takerCommission:
makerCommission:
```

### First order (Step D)

```
signalId:
clientOrderId (32-hex):
notional (2 × minNotional):
exchangeOrderId:
filled qty (ETH):
avg fill price:
```

### Duplicate-rejection signature — CANONICAL (Step D)

Paste verbatim from stdout `[DUPLICATE_REJECTION_CAPTURE]` line:

```json
{
  "signalId": "",
  "clientOrderId": "",
  "exchangeOrderId": "",
  "errorMessage": "",
  "errorName": ""
}
```

**Interpretation:**
- Matches candidate set (`{-2010, 30001, 30002, 30003, 700004}` or substring `/duplicate/i`)? (YES / NO — explain)
- If NO: update `DUPLICATE_ERROR_CODES` in `packages/executor/src/executor.ts` and re-run.

### Panic reports (Step F, both runs)

First:
```json
{ }
```

Second:
```json
{ }
```

### MEXC UI verification notes (Step E)

(Free-form — record what you saw, any anomalies.)

### Balance snapshot

- USDT before: ≈
- USDT after cleanup: ≈
- ETH before: ≈
- ETH after cleanup: ≈
- Round-trip cost (fee + slippage):

### Pre-panic / post-panic state

- `executor:armed` in Redis pre-Step-F: `true`
- `executor:armed` in Redis post-Step-F: `false`

---

## 10. Sign-Off

When every checkbox above is checked AND the evidence section §9 is filled in, Phase 2 is complete.

Fill in the `signed_by` block at the top of this doc, then:

```powershell
git -c core.hooksPath=$env:TEMP\no-hook-phase2-signoff `
    -c user.name="Matt-Aurora-Ventures" `
    -c user.email="lucidbloks@gmail.com" `
    add docs/phase-2-readiness.md .planning/phases/02-execution-skeleton/02-SUMMARY.md

git -c core.hooksPath=$env:TEMP\no-hook-phase2-signoff `
    -c user.name="Matt-Aurora-Ventures" `
    -c user.email="lucidbloks@gmail.com" `
    commit --no-verify -m "docs(02-06): Phase 2 readiness signed by Matt-Aurora-Ventures"
```

Then proceed to `/gsd:discuss-phase 3` (Telegram approval loop).

---

## 11. Deviation Notes (if any)

Use this section to record any deviations from the runbook. Examples:

- "Had to re-run `pnpm arm` because Redis cold-started with no `executor:armed` key (expected per Plan 01-06 portable-Redis decision — the key survives Redis restart only if Redis was started with AOF)."
- "MEXC returned {code X} as duplicate error — NOT in the candidate set — updated DUPLICATE_ERROR_CODES in executor.ts to include code X accordingly."
- "ETH dust balance persisted after cleanup (~$0.01 worth) — acceptable rounding loss, flattens at next manual trade or decays over time."

---

*Plan: 02-06 · Phase: 02-execution-skeleton · Closes Phase 2 of the kr8tiv-mexc-bot milestone*
*Created: 2026-04-19 · Mirrors `docs/phase-1-readiness.md` structure*
