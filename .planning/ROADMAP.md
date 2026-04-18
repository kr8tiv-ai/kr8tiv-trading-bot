# Roadmap: kr8tiv-mexc-bot

**Created:** 2026-04-18
**Granularity:** fine (10 phases)
**Core Value:** Make Matt a better trader by surfacing what he already does well and correcting what he consistently does wrong — with a bot that never fires without his approval.

**v1 Scope (weekend target):** Phases 1-5 — ends with first live ETH spot trade approved via Telegram + first computable leak report.
**v2 Scope (post-weekend iteration):** Phases 6-10 — futures write, news/on-chain, ML, dashboards, VPS failover.

## Phases

- [>] **Phase 1: Foundation** — Scaffold + secrets + MEXC read access with two-client separation (4/6 plans complete — 01-01 scaffold+bootstrap, 01-02 config/logger/secrets, 01-03 redis-client/db, 01-04 mexc-spot+futures)
- [ ] **Phase 2: Execution Skeleton** — MEXC spot write path with safety rails ($10-aware sizing)
- [ ] **Phase 3: Telegram Approval Loop** — grammY bot with inline Approve/Reject, 90s TTL, style-conflict card
- [ ] **Phase 4: Style Fingerprint + Rule Signal + First Leak** — EMA/ADX rule signal, revenge-trade detector
- [ ] **Phase 5: Ledger + Reconciler + First Live Trade** — Append-only ledger, boot/wake reconciler, Core Value validator
- [ ] **Phase 6: Futures Write + Full Leak Suite** — MEXC USDT-M write path, 7 leak detectors, weekly Telegram digest
- [ ] **Phase 7: News Veto + On-chain Ingest** — CryptoPanic + CoinGecko veto layer, Solana + Ethereum wallet history
- [ ] **Phase 8: ML Signal (XGBoost/ONNX)** — Python trainer, walk-forward CV, two-target classifier, ONNX inference
- [ ] **Phase 9: Web + CLI Dashboards** — Fastify+React local dashboard, Ink CLI, shared WS stream
- [ ] **Phase 10: VPS Failover** — Hostinger VPS read-only observer, distributed lock, soft failback

## Phase Details

### Phase 1: Foundation
**Goal**: Matt's local environment boots a typed Node monorepo that can read — but not write — both MEXC surfaces through safely-stored credentials, with secret leakage made structurally impossible.
**Depends on**: Nothing (first phase)
**Requirements**: FND-01, FND-02, FND-03, FND-04, FND-05, FND-06, FND-07, FND-08, FND-09, FND-10, FND-11
**Success Criteria** (what must be TRUE):
  1. Running `pnpm dev` boots the core process, which successfully pings both `api.mexc.com` (spot) and `contract.mexc.com` (futures) on startup and fails fast with a clear error message if either is unreachable.
  2. No MEXC API key, secret, or Telegram token appears in any `.env` file, source file, or git history — all secrets are read from Windows Credential Manager through `SecretProvider` on boot.
  3. Attempting to `git commit` a string matching a MEXC key pattern or Telegram token is blocked by the gitleaks pre-commit hook before the commit is created.
  4. Running a test query via `MEXCSpotClient.getAccountInfo()` succeeds and the log output shows API keys redacted to `****` by pino's automatic redaction.
  5. The MEXC API key in use is confirmed trading-only (no withdrawal permission) and IP-whitelisted to Matt's Windows machine when inspected in the MEXC web UI.
**Plans**: 6 plans
- [x] 01-01-PLAN.md — Monorepo scaffold + tooling (pnpm+Turborepo, TS strict, Biome, lefthook+gitleaks); scaffold shared-types + shared-schemas packages (FND-01, FND-10) — SUMMARY written 2026-04-17, bootstrap pending
- [x] 01-02-PLAN.md — @kr8tiv/config + @kr8tiv/secrets (SecretProvider with WindowsCredentialManagerProvider via Zowe) + @kr8tiv/logger (pino redaction) + setup-credentials/verify-env scripts (FND-04, FND-05, FND-09) — SUMMARY 2026-04-18, 3 atomic commits cc1a55f / 6b5af57 / a94e3bd
- [x] 01-03-PLAN.md — @kr8tiv/redis-client (ioredis factory + ping helper) + @kr8tiv/db (better-sqlite3 WAL + synchronous=FULL + foreign_keys=ON) (FND-02, FND-03) — SUMMARY 2026-04-18, 3 atomic commits f6a7532 / c618cc9 / 1be7211; 11 tests green + 2 live-Redis tests conditionally skipped until Memurai install
- [x] 01-04-PLAN.md — @kr8tiv/mexc-spot + @kr8tiv/mexc-futures (two separate CCXT instances, read-only Phase 1 scope, config-driven base URLs, Zod-validated responses) (FND-06, FND-07) — SUMMARY 2026-04-18, 3 atomic commits e2c385c / 84b8c17 / ffbc15a; 20 unit tests green + 3 live tests gated behind MEXC_LIVE=1
- [ ] 01-05-PLAN.md — apps/core boot.ts + smoke.ts + dev.ts; 10-step ordered boot sequence with Promise.allSettled dual-MEXC ping; `pnpm smoke` end-to-end (FND-08)
- [ ] 01-06-PLAN.md — docs/phase-1-readiness.md (FND-11 operator checklist: trading-only + no-withdraw + IP-whitelisted, signed by Matt) + docs/setup-windows.md reproducibility runbook (FND-11)

### Phase 2: Execution Skeleton
**Goal**: The core process can place and kill a real spot order on MEXC for ETHUSDT, with every safety rail (idempotency, server-side stops, minNotional check, daily loss breaker, panic switch) enforced before any order leaves the process — but no signal or approval layer exists yet.
**Depends on**: Phase 1
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06, EXEC-07, EXEC-08, EXEC-09
**Success Criteria** (what must be TRUE):
  1. A manual test-harness order placement for ETHUSDT on MEXC succeeds and results in a fill that carries the bot's `newClientOrderId` — and a second attempt to submit the same `newClientOrderId` is rejected by MEXC as a duplicate.
  2. Every entry order visible in the MEXC web UI has an attached server-side `triggerPrice` stop-loss — attempting to place an entry without one is rejected by the risk manager before the API call.
  3. An attempted order on a pair other than `ETHUSDT` (e.g., `BTCUSDT`, `DOGEUSDT`) is rejected with an explicit "pair not whitelisted" reason.
  4. A simulated $2 cumulative daily loss trips the circuit breaker and the next order request is rejected with "daily loss circuit breaker tripped," until manual reset.
  5. Executing `/panic` (test invocation) cancels all open MEXC orders, flattens any open position, and leaves the executor in a frozen state that refuses new orders until re-armed.
  6. Killing and restarting the core process preserves open positions, pending approvals, and rate-limit buckets in Redis — no state is lost on restart.
**Plans**: TBD

### Phase 3: Telegram Approval Loop
**Goal**: Matt's phone receives signal cards from the bot, taps Approve or Reject, and the decision flows through the system — with TTL, price-drift checks, daily caps, and post-reject cooldowns enforcing the "never fires without approval, never fires on stale data" discipline.
**Depends on**: Phase 2
**Requirements**: APP-01, APP-02, APP-03, APP-04, APP-05, APP-06, APP-07, APP-08, APP-09, APP-10
**Success Criteria** (what must be TRUE):
  1. Matt receives a Telegram card showing asset, side, entry price, stop, target, confidence, regime, funding rate, rationale, live price delta vs card, and USD fee+slippage estimate — and tapping Approve causes the order to fire on MEXC within 5 seconds.
  2. A signal card left un-tapped for 90 seconds auto-edits to "Expired" and the underlying signal is discarded; subsequent Approve taps on the expired card do nothing.
  3. If the ETHUSDT mark price has moved more than 0.3% from the card's entry price at the moment Approve is tapped, the card auto-expires instead of firing — Matt sees "stale price, rejected" in the message.
  4. Sending `/panic` or `/status` from any Telegram chat other than Matt's whitelisted chat ID is silently ignored (no response, no log leak).
  5. After a Reject on ETHUSDT, no new ETHUSDT signal card is emitted for 30 minutes, regardless of how many candidate signals fire.
  6. Running `/status` returns current open positions, today's PnL, today's signal count, circuit-breaker state, and kill-switch armed/disarmed status in a single Telegram message.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Style Fingerprint + Rule Signal + First Leak
**Goal**: Matt's 60+ days of MEXC ETHUSDT trade history is ingested into a unified schema, his trading style is characterized, a rule-based EMA/ADX signal emits type-checked suggestions, and one EV-validated leak detector (revenge trade) attaches a "you'd normally screw this up here" flag to signals that contradict his safe motion.
**Depends on**: Phase 3
**Requirements**: SIG-01, SIG-02, SIG-03, SIG-04, SIG-05, SIG-06, SIG-07, SIG-08
**Success Criteria** (what must be TRUE):
  1. Running a history-ingest command pulls ≥60 days of Matt's MEXC ETHUSDT trades, stores them in the SQLite `trades` table, and the row count matches the count visible in Matt's MEXC trade history tab.
  2. Running a fingerprint command produces a report showing Matt's avg hold time, median position size, hour-of-day expectancy map, win/loss hold asymmetry, and preferred entry time ranges — numbers sanity-checked against his actual pattern.
  3. When ADX on the 15m ETHUSDT candle is below 15, the rule-based generator emits zero signals; when ADX crosses 25 with a fresh EMA20/EMA50 crossover, it emits a typed signal object containing asset, side, entry, stop, target, confidence, rationale, regime, fundingRate, and conflictsWithStyle.
  4. When a candidate signal is placed within 30 minutes of a simulated historical loss on ETHUSDT at size ≥ previous losing size, the revenge-trade leak detector attaches a conflict-with-style flag — but only if the pattern has ≥20 historical samples and negative EV in Matt's data.
  5. A leak-flagged signal is still shown to Matt (not auto-blocked), with the Telegram card containing an explicit "I would normally do X wrong here" note that Matt can read before approving.
  6. Running a leak-report command produces a plain-text digest listing up to 3 top leaks from Matt's history, each citing specific trade IDs and showing projected $ savings if the leak were fixed.
**Plans**: TBD

### Phase 5: Ledger + Reconciler + First Live Trade
**Goal**: Every state change writes to an append-only SQLite ledger; the boot-time and wake-time reconciler repairs state against MEXC truth before the executor accepts new orders; Windows power control prevents sleep during active trading — culminating in the first end-to-end live ETH spot trade approved via Telegram, the project's Core Value validator.
**Depends on**: Phase 4
**Requirements**: LEDG-01, LEDG-02, LEDG-03, LEDG-04, LEDG-05
**Success Criteria** (what must be TRUE):
  1. A complete signal-to-fill cycle produces a linked chain of ledger rows (`signal.emitted` → `approval.pending` → `approval.decided` → `order.submitted` → `order.filled` → `pnl.delta`) queryable from SQLite with correct timestamps and idempotent IDs.
  2. Killing the core process mid-cycle, manually placing a fill on MEXC, then restarting the process results in the boot-time reconciler pulling the last 24h of MEXC fills, detecting the missing ledger entry, and blocking new orders until Matt manually resolves the mismatch.
  3. Closing the Windows laptop lid while a position is open triggers `SetThreadExecutionState` preventing system sleep, OR after the laptop does sleep, the wake-event handler fires the reconciler before any new signal is processed.
  4. Matt receives a Telegram card for a real ETHUSDT signal, taps Approve, the order fires on MEXC, the fill arrives, the ledger records it, the PnL delta is computed, and Matt receives a Telegram confirmation showing the executed price and net PnL — all within a single live session. **This is the v1 Core Value validator.**
  5. The first live trade can be fully replayed from the SQLite ledger alone — Matt can see what was signaled, when he approved, what order was submitted with what idempotency key, what filled, at what price, and what PnL resulted.
**Plans**: TBD

### Phase 6: Futures Write + Full Leak Suite
**Goal**: MEXC USDT-M futures write path goes live (ETHUSDT + BTCUSDT + SOLUSDT, isolated margin, per-asset leverage caps), the full 7-leak detector suite runs with EV validation, and Matt receives a formatted weekly Telegram digest quantifying his top 3 recurring mistakes with dollar evidence.
**Depends on**: Phase 5
**Requirements**: FUT-01, FUT-02, FUT-03, FUT-04, FUT-05, FUT-06, FUT-07
**Success Criteria** (what must be TRUE):
  1. A futures approval card for ETHUSDT at 4x leverage (isolated margin) fires via Telegram approval and the resulting position appears on MEXC at exactly 4x with isolated margin — an attempt to set cross margin or >4x ETH is rejected before the API call.
  2. If MEXC returns 403 on a futures write call (account not permissioned for futures API), the bot degrades gracefully to read-only + Telegram alert instead of crashing, and spot trading continues.
  3. Running the leak detector suite against Matt's history produces reports for all 7 leak types (revenge, FOMO entry, late exit, stop widening, overtrading, ignored stop, time-of-day abuse, size inflation after losses) — each with a sample count, EV validation status, and active/inactive flag.
  4. On Monday morning, Matt receives a Telegram digest showing the week's top 3 leaks with specific trade IDs as evidence and projected-savings-if-fixed dollar amounts per leak.
  5. A futures approval card offers four buttons — Approve, Tighter stop, Half size, Reject — with no "widen stop" option anywhere in the UI.
**Plans**: TBD
**UI hint**: yes

### Phase 7: News Veto + On-chain Ingest
**Goal**: CryptoPanic news and CoinGecko market data act as a veto layer that can downgrade signal confidence but never upgrade it above the underlying model's standalone output, and Matt's Solana (Phantom/Solflare) + Ethereum (MetaMask) wallet swap history is ingested into the same unified trades table for a richer style fingerprint.
**Depends on**: Phase 6
**Requirements**: NEWS-01, NEWS-02, NEWS-03, NEWS-04, NEWS-05, NEWS-06, NEWS-07, NEWS-08, NEWS-09
**Success Criteria** (what must be TRUE):
  1. A simulated bearish headline from Coindesk (whitelisted source) on ETH within the last 15 minutes confirmed by a second whitelisted source (The Block) downgrades a candidate ETH long's confidence — but a single headline or a headline from a non-whitelisted source has zero effect.
  2. No news event ever raises a signal's confidence above what the rule-based or ML model emitted on its own — the veto layer is strictly reducing, never adding.
  3. CryptoPanic polling never exceeds 30 requests/hour and is cached for 5 minutes, verifiable via HTTP call count over a 1-hour observation window.
  4. Running an on-chain ingest command against Matt's Solana wallet addresses pulls parsed transactions via Helius, decodes Jupiter multi-hop swaps as single logical trades, filters out failed transactions, and inserts rows with `venue='solana'` into the unified trades table.
  5. Running the same ingest against Matt's Ethereum wallet via viem + Alchemy `getAssetTransfers` decodes swaps and inserts rows with `venue='ethereum'` — Matt's style fingerprint can now be recomputed across CEX + Solana + Ethereum activity.
**Plans**: TBD

### Phase 8: ML Signal (XGBoost/ONNX)
**Goal**: A Python-trained, heavily regularized XGBoost/LightGBM two-target classifier is exported to ONNX and served by Node at inference time — ready to replace the rule-based signal only if out-of-sample profit factor lands in the 1.3-2.0 sweet spot, otherwise stays behind the rule-based system.
**Depends on**: Phase 7
**Requirements**: ML-01, ML-02, ML-03, ML-04, ML-05, ML-06, ML-07
**Success Criteria** (what must be TRUE):
  1. Running `python apps/trainer-py/train.py` produces an ONNX model file with feature count ≤ `floor(sqrt(n_samples))` and regularization at or above the documented floors (`min_child_samples≥20`, `max_depth≤4`, `num_leaves≤15`, L1/L2 ≥1.0).
  2. The walk-forward cross-validation report shows purge + embargo between train/test folds (de Prado methodology) and reports out-of-sample profit factor, precision, and recall for both targets.
  3. The two-target classifier emits a signal only when both `entry_attractiveness` and `entry_profitable` models agree — disagreement produces no signal, visible in the inference log.
  4. Leak-flagged trades (from Phase 4's revenge detector and Phase 6's full suite) are confirmed masked from the training dataset before fit — sample count visible in the trainer output.
  5. The ONNX model is loaded by the Node core via `onnxruntime-node` at boot (zero runtime Python coupling), and a model version bump requires only dropping a new `.onnx` file and hot-reloading — no Node rebuild.
  6. The ML signal path is gated behind documented OOS profit factor 1.3-2.0 — if the last training run falls outside that band, the bot stays on the Phase 4 rule-based generator and logs why.
**Plans**: TBD

### Phase 9: Web + CLI Dashboards
**Goal**: Matt can open `http://127.0.0.1:3000` in a browser or run a terminal command and see the same live stream of positions, PnL, signal history, leak report, and approval log — both UIs consume the core's WebSocket stream with zero duplicated business logic.
**Depends on**: Phase 8 (or earlier if prioritized — can parallelize with Phase 7-8 post-v1)
**Requirements**: UI-01, UI-02, UI-03
**Success Criteria** (what must be TRUE):
  1. Opening `http://127.0.0.1:3000` in a browser shows open positions, today's PnL, a lightweight-charts price chart with Matt's fills marked, signal history, weekly leak report, and approval log — updating live as new events land.
  2. Running `pnpm dashboard` opens an Ink-rendered terminal UI showing the same positions, PnL, event stream tail, and kill-switch state — updating live from the same WS stream.
  3. The local web dashboard is bound to `127.0.0.1:3000` only and returns ECONNREFUSED when accessed from any other machine on the LAN.
  4. Both dashboards are zero-state — killing and restarting either one loses no data and picks up the live stream on reconnect; the core process is the sole source of truth.
**Plans**: TBD
**UI hint**: yes

### Phase 10: VPS Failover
**Goal**: A Hostinger Ubuntu VPS runs as a read-only observer for ≥1 week of stable local operation, then unlocks write capability behind a single shared-Redis distributed lock with MEXC idempotency keys preventing double-fire — Windows stays primary, VPS takes over on laptop sleep, and Telegram webhook runs from VPS-only to avoid duplicate delivery.
**Depends on**: Phase 9 + ≥1 week of stable v1 live running
**Requirements**: VPS-01, VPS-02, VPS-03, VPS-04, VPS-05, VPS-06
**Success Criteria** (what must be TRUE):
  1. The Hostinger Ubuntu 24.04 VPS boots the same bot binary, loads its encrypted secrets via `age`, and runs for ≥7 days consuming streams but never placing a single order — verifiable in the VPS ledger and MEXC order history.
  2. Closing the Windows laptop lid causes Windows to release the `core.leader` Redis lock; within 30 seconds the VPS acquires it via `SET core.leader NX EX 30` and begins executing approved signals; opening the laptop lid demotes the VPS gracefully without cancelling any in-flight orders.
  3. During a simulated split-brain (network partition where both Windows and VPS briefly think they hold the lock), MEXC rejects the duplicate order with `-2010 duplicate client order id` because both sides emit `newClientOrderId = sha256(signal_id + approval_timestamp)` — at most one order fills.
  4. The Telegram bot's webhook is served from the VPS only — Windows-side bot is in long-polling fallback and ignores callbacks when it doesn't hold the leader lock, so Matt never sees duplicate signal cards.
  5. Killing the shared Redis (simulated outage) causes both Windows and VPS to fail-closed — neither can renew the lock, so neither places new orders until Redis recovers; "missing trades" is acceptable, "double-firing" is not.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 1/6 | In progress (01-01 scaffold authored; bootstrap pending for commits) | - |
| 2. Execution Skeleton | 0/? | Not started | - |
| 3. Telegram Approval Loop | 0/? | Not started | - |
| 4. Style Fingerprint + Rule Signal + First Leak | 0/? | Not started | - |
| 5. Ledger + Reconciler + First Live Trade | 0/? | Not started | - |
| 6. Futures Write + Full Leak Suite | 0/? | Not started | - |
| 7. News Veto + On-chain Ingest | 0/? | Not started | - |
| 8. ML Signal (XGBoost/ONNX) | 0/? | Not started | - |
| 9. Web + CLI Dashboards | 0/? | Not started | - |
| 10. VPS Failover | 0/? | Not started | - |

## Coverage

- **v1 requirements:** 43/43 mapped
- **v2 requirements:** 32/32 mapped
- **Total:** 75/75 requirements mapped to exactly one phase

**v1 split (Phases 1-5):**
- Phase 1: 11 REQs (FND-01..11)
- Phase 2: 9 REQs (EXEC-01..09)
- Phase 3: 10 REQs (APP-01..10)
- Phase 4: 8 REQs (SIG-01..08)
- Phase 5: 5 REQs (LEDG-01..05)

**v2 split (Phases 6-10):**
- Phase 6: 7 REQs (FUT-01..07)
- Phase 7: 9 REQs (NEWS-01..09)
- Phase 8: 7 REQs (ML-01..07)
- Phase 9: 3 REQs (UI-01..03)
- Phase 10: 6 REQs (VPS-01..06)

## Milestones

**Milestone 1 (weekend v1):** Phases 1-5 complete. Matt has a working copilot that reads his MEXC history, generates signals with style-conflict flags, gates every order through Telegram approval, executes live on ETH spot with safety rails, and survives laptop sleep. First live approved trade = Core Value validated.

**Milestone 2 (post-weekend iteration):** Phases 6-10 complete. Full leak suite, futures leverage, news veto, on-chain wallet fingerprint, ML signal, local dashboards, VPS failover. Full PROJECT.md feature set delivered.

---
*Roadmap created: 2026-04-18*
*Last updated: 2026-04-17 after Plan 01-01 execution (scaffold authored; 3 atomic commits pending Matt's bootstrap run)*
