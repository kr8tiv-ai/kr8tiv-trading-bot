# Pitfalls Research

**Domain:** Personal trading copilot (MEXC spot + USDT-M futures, small-sample ML, semi-auto via Telegram, live $10 bankroll)
**Researched:** 2026-04-17
**Confidence:** HIGH (MEXC-specific findings verified against official MEXC docs + recent announcements; ML pitfalls verified against ML/quant-finance literature)

> Severity legend: **PROJECT-KILLER** (v1 fails or money lost beyond the $10 stake) • **PAINFUL** (forces rewrite or multi-day debug) • **MINOR** (annoying, recoverable same-day)

---

## Critical Pitfalls

### Pitfall 1: Treating MEXC spot and futures as one API

**Severity:** PROJECT-KILLER
**What goes wrong:**
The spot base (`api.mexc.com`) and the futures base (`contract.mexc.com` / `wbs-api.mexc.com` for WS) are effectively two different products — different host, different auth header names, different signature payload assembly (spot signs query-string, futures signs `query + body` concatenation), different rate-limit buckets, different error-code families (spot uses `-11xx` / `700003`; futures uses `30005`, `88004`, `88015`, etc.), different WebSocket channel naming and different ping semantics. MEXC is also migrating futures to a new access domain on Jan 12, 2026 — if the code hardcodes `contract.mexc.com`, the bot silently stops executing futures one morning.

**Why it happens:**
Third-party "MEXC API" tutorials conflate the two. Devs build a single `MEXCClient` with one auth interceptor and one rate-limiter and expect it to work for both surfaces.

**How to avoid:**
- Build two separate client classes (`MEXCSpotClient`, `MEXCFuturesClient`) from day one with separate base URLs, signers, rate-limit buckets, and typed error enums.
- Put both base URLs in config (not source), default to current values but overridable — so the Jan 2026 domain migration is a one-line change.
- Write a `mexc-connectivity-smoke-test` script that hits `/api/v3/ping` (spot) and `/api/v1/contract/ping` (futures) and prints both responses. Run it as the first thing on startup.
- Note: MEXC officially states futures API trading is "institutional only" in multiple places. The public futures API works in practice but MEXC may revoke write access on personal accounts. Design the futures path to **degrade to read-only-plus-alert** if a write call returns a permission-denied error rather than crashing the bot.

**Warning signs:**
- Signature errors on one surface but not the other (`700002 invalid signature` only on futures = you're signing it like spot).
- `404 Not Found` after a MEXC announcement (domain migration happened).
- Orders working in testing, then bot suddenly can't place futures orders (MEXC revoked personal-account futures API write).

**Phase to address:** Phase 1 (MEXC connectivity + read-only sanity). Two clients must exist before any order code is written.

---

### Pitfall 2: Overfitting on 60 days of one user's trades

**Severity:** PROJECT-KILLER (for the signal-generation goal; the copilot still works as a leak reporter even if the ML is garbage)
**What goes wrong:**
60 days at Matt's real trading cadence is likely **80–300 samples, not rows of bars**. Gradient-boosted trees with default hyperparameters on that few samples will memorize the training set, produce a beautiful in-sample backtest, and emit suggestions with 0.9 confidence that are noise. Combined with MEXC's fees + slippage, an overfit model on $10 is guaranteed to bleed.

**Why it happens:**
XGBoost/LightGBM defaults are designed for 10k+ rows. LightGBM grows leaf-wise, which is especially greedy on small data. Devs see great train/test split numbers (because the split isn't time-aware) and ship.

**How to avoid:**
- **Do not use the ML model as the primary decision-maker in v1.** Use it as a *vote* alongside rule-based regime filters (ADX trend/range) and the leak-detector's "don't do what you usually do wrong" veto. The system should still produce signals without the ML.
- Force heavy regularization from the start: `min_child_samples >= 20` (or `min_data_in_leaf >= 20`), `max_depth <= 4`, `num_leaves <= 15`, `reg_alpha >= 1.0`, `reg_lambda >= 1.0`, `subsample = 0.7`, `colsample_bytree = 0.7`.
- Validate with **purged, embargoed walk-forward** CV (de Prado): train on weeks 1–6, embargo week 7 entirely, test on week 8, then roll. Report out-of-sample metrics, never in-sample.
- Keep the feature count small: no more features than `sqrt(n_samples)`. For 200 samples, that's ~14 features max. Engineer deliberately (EMA spread, RSI, ATR, regime flag, time-of-day bucket, funding rate, user-specific style tag), don't auto-generate 200.
- Require out-of-sample profit factor between **1.3 and 2.0** to ship a model. Anything over 3.0 is almost certainly overfit and must be thrown away.
- Log every prediction with features + outcome. If after 2 weeks of live trading the model's out-of-sample accuracy drops below coin-flip, disable it and fall back to rules + leak-veto.

**Warning signs:**
- Train accuracy >> test accuracy (gap > 15%).
- Any single feature has > 40% feature importance (model is riding one variable).
- Backtest Sharpe > 3 on $10 of bars (too good to be true).
- Live predictions cluster at 0.0 or 1.0 confidence (the model is overconfident because it memorized).

**Phase to address:** Phase 3 (ML training pipeline). Phase 2 (leak detection) must land and be useful *without* the ML, so the project succeeds even if ML never does.

---

### Pitfall 3: MEXC minimum notional eats the $10 bankroll

**Severity:** PROJECT-KILLER (for "execute a trade this weekend")
**What goes wrong:**
MEXC USDT-M futures use a "contracts" abstraction. `BTC_USDT` contract size is `0.0001 BTC` — at $65k BTC, 1 contract = $6.50 notional. With $10 equity at 5x leverage you have ~$50 notional headroom, which is ~7 BTC contracts max — fine. But `SOL_USDT` has a larger contract multiplier and at 3x leverage cap, $10 only affords 1–2 contracts. Spot minimums are quote-currency minimums (typically 1 USDT notional) which work, but **spot fees + slippage on $10 at 0.1% round-trip = $0.02 — you need +0.2% move just to break even.** If the bot naively sizes positions as a % of equity without checking each pair's `minVol` and contract size, it will spray `30005 Oversold` / `InsufficientFunds` errors all weekend.

**Why it happens:**
Devs assume a unified "position sizer" based on % of equity. They don't model per-pair `contractSize`, `minVol`, and `priceScale` from MEXC's `contract_detail` endpoint.

**How to avoid:**
- Before every order, pull `contract_detail` (cached, refreshed daily) and compute: `minimum_notional_usd = minVol * contractSize * markPrice`. Reject the trade if `minimum_notional_usd * 2` (for entry + stop) > `available_margin`.
- For v1, **whitelist only ETHUSDT futures** for live trading. ETH contract size (typically 0.01 ETH) produces the smallest viable notional at $10. Add BTC and SOL as the account grows.
- Assume **fees + slippage = 0.15% round-trip even during zero-fee promos** (slippage alone eats this). Reject any signal with expected move < 0.4% — the math doesn't work.
- Use `postOnly` / maker orders wherever possible to capture the maker-taker spread.
- Display "this trade will cost you $X in fees + slippage; PnL expected after costs: $Y" in the Telegram approval message. Matt must see the cost, not just the signal.

**Warning signs:**
- Repeated `30005` or `88015` errors in the order log.
- Weekly PnL is negative by roughly the sum of fees paid (you're just paying rent to MEXC).
- Every trade clears in < 30 seconds (you're taking, not making).

**Phase to address:** Phase 4 (Execution + risk manager). The per-pair sizing logic must exist before the first live order.

---

### Pitfall 4: Windows Credential Manager secrets break on VPS and service-account

**Severity:** PAINFUL (blocks the failover story in the PROJECT doc)
**What goes wrong:**
WinCredMan stores creds encrypted with DPAPI keyed to the **specific user SID on the specific machine**. The Hostinger VPS (Linux) literally cannot read them. Even on Windows, if the bot is ever launched as Local System or a different user (e.g., running as a scheduled task under `NT AUTHORITY\SYSTEM` for auto-start after reboot), the credentials are invisible. Moving the laptop to a new machine and restoring creds "works" only if the user profile is migrated with the right DPAPI master keys — which usually doesn't happen.

**Why it happens:**
PROJECT.md mandates WinCredMan for secrets (Matt's explicit choice) AND Hostinger VPS as backup. Those two are structurally incompatible.

**How to avoid:**
- Build a `SecretProvider` abstraction with two concrete implementations: `WindowsCredentialManagerProvider` (local primary) and `EncryptedFileProvider` (file encrypted with a passphrase Matt types / pastes from a password manager on VPS startup). The bot code only talks to the abstraction.
- On the VPS: use a root-owned `0600` file encrypted with `age` or `sops`, unlocked at boot by a passphrase Matt pastes via SSH (acceptable: VPS reboots are rare).
- **Never run the bot as Local System or as a service on Windows.** Run under Matt's user with Task Scheduler set to "Run whether user is logged on or not" + store password (DPAPI user-scoped still works because the task runs under Matt's SID).
- Document the exact boot procedure for VPS in `runbook.md` with the passphrase retrieval steps. Secrets must never be committed; `.gitignore` must include the encrypted file by name and a pre-commit hook must scan for creds (see Pitfall 10).
- Dev/test locally using a `.env.local` in `.gitignore` with **only test keys** — never production keys — so you can iterate without prompting WinCredMan 50 times.

**Warning signs:**
- Bot works when you're logged in, breaks after reboot.
- `CredRead` returns `ERROR_NOT_FOUND` (1168) for a credential you can see in `control.exe /name Microsoft.CredentialManager`.
- VPS deployment "just won't start" and logs say nothing because secret load fails before logging is configured.

**Phase to address:** Phase 1 (Platform + secrets). The abstraction must be in place before any MEXC client code; don't commit to WinCredMan-only APIs.

---

### Pitfall 5: Primary + VPS both fire, MEXC gets double orders

**Severity:** PROJECT-KILLER (real money, real duplicate fills)
**What goes wrong:**
Matt's Windows laptop and the Hostinger VPS are both running the same bot for "24/7 coverage." Network partition happens (laptop Wi-Fi drops for 90 seconds), or the laptop sleeps without cleanly handing off. VPS decides laptop is dead, takes leadership, fires the trade. Laptop wakes up, sees the approved signal in Redis wasn't marked executed (it missed the update), fires the same trade. MEXC now has two identical positions. At $10 of equity this can instantly liquidate.

**Why it happens:**
"Primary + backup" without an explicit leader election protocol defaults to split-brain. Redis alone doesn't prevent this — both nodes can write.

**How to avoid:**
- **Only one instance executes at a time. Ever.** The VPS runs in "hot-standby, read-only" mode by default. Matt explicitly promotes it via a `/switch-to-vps` Telegram command or a manual CLI flag.
- Implement an **idempotency key on every order** = `sha256(signal_id + approval_timestamp + user_chat_id)` passed as MEXC `newClientOrderId` (spot) / `externalOid` (futures). MEXC will reject the second submission with a duplicate-order-id error. This is the seatbelt; leader election is the brake.
- Add a **MEXC side check** before placing: query open orders for the symbol; if an order exists with the same `clientOrderId` prefix within the last 5 minutes, abort.
- After every Telegram approval, write `approval_id -> executed_at` to Redis with a TTL of 1 hour. Both instances must `SET NX` this key before executing; whoever loses the race must log "peer executed, skipping" and move on.
- Run Redis on one machine (the primary's local Redis), with the VPS reading over TLS — not two separate Redis instances. Single source of truth for state.
- Kill switch: if the bot sees two distinct `executed_at` values for one approval ID, **lock the entire bot** and page Matt.

**Warning signs:**
- Two recent MEXC orders with nearly identical timestamps.
- Redis shows two different `instance_id` values having claimed the same approval.
- Position size on MEXC = 2x what the ledger expects.

**Phase to address:** Phase 4 (Execution) AND Phase 6 (VPS deployment). VPS must not ship as write-enabled in v1 unless the idempotency + leader-claim is proven.

---

### Pitfall 6: Laptop sleep = stale model, stale positions, orphan orders

**Severity:** PAINFUL
**What goes wrong:**
Laptop sleeps at 2am. MEXC fills a limit order at 4am while the bot is unconscious. Bot wakes at 9am; its in-memory view says "no position" but MEXC says "long 1 ETH contract from 4am." Next signal tries to open a new long, bot reports the position as fresh, risk manager doesn't know about the already-open position, leverage creeps above 5x, stop-loss was also never placed because the bot was asleep at fill time. Now you're in a hyper-leveraged position with no stop.

**Why it happens:**
The bot assumes continuous uptime. Its "position" is held in RAM or worse, ignored across restarts. Nothing reconciles local state with MEXC's reality on wake.

**How to avoid:**
- **Reconciliation is a first-class startup phase.** Every time the bot boots (or resumes — listen to Windows power events `WM_POWERBROADCAST` / `POWERBROADCAST_SETTING`), it must: pull all open orders + positions from MEXC spot and futures, pull recent fills (last 24h), diff against Redis, and reconcile. Any discrepancy blocks trading until resolved manually via a Telegram prompt.
- Attach **server-side stop-losses + take-profits** on every futures entry (MEXC supports `triggerPrice` orders). If the bot is asleep, MEXC still enforces the stop. Client-side stops are fiction.
- Add `trade_count_since_last_sync` in Redis. If `reconciliation_lag_seconds > 300` on boot, print a loud banner and pause autoexec.
- Set Windows power plan (programmatically on bot start) to prevent sleep while Matt is "actively trading mode" — `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`. Reset on bot exit.
- On the VPS-backup, if the laptop has been silent for > N minutes and Matt approves via Telegram while laptop is asleep, the VPS should be allowed to execute — but this requires Pitfall 5's leader election done right.
- **Stale model:** timestamp every model artifact. If the model is older than 7 days, refuse to emit high-confidence signals until retrained.

**Warning signs:**
- On boot, Redis positions != MEXC positions.
- Orders exist on MEXC that the bot has no record of.
- The "last model trained at" is a week ago but nobody noticed.

**Phase to address:** Phase 1 (State + Redis persistence), Phase 4 (Execution), Phase 5 (Wake/reconciliation).

---

### Pitfall 7: Telegram approval UX creates alert fatigue or stale approvals

**Severity:** PAINFUL (directly attacks the Core Value: "never fires without approval")
**What goes wrong:**
Three variants:
1. **Alert fatigue:** Bot fires 40 signals a day, Matt starts mashing "approve" without reading. The copilot becomes the loser-filter it was supposed to prevent.
2. **Stale approvals:** Signal generated at 14:00 with entry 3500, Matt notices the Telegram ping at 14:45, taps approve. Price is now 3550. Bot market-buys at the worse price. The trade thesis is broken.
3. **Silent callback drop:** `answerCallbackQuery` not called, user sees the 15-second loading clock, re-taps, now two approvals hit.

**Why it happens:**
No explicit signal-quality threshold before alerting. No approval TTL. Missing `answerCallbackQuery` (known Telegram Bot API foot-gun — it doesn't count against rate limit but silence degrades UX).

**How to avoid:**
- **Cap signals to ≤ 5/day.** If the ML model wants to emit more, the top-K filter selects the best. This is the single most valuable discipline enforcer.
- **Approval TTL = 90 seconds** (futures) / 5 minutes (spot). Beyond that, the approval message auto-edits to "EXPIRED" and the bot refuses to execute. Clear UX, no stale fills.
- Every approval message includes: **current price vs signal price delta, time since signal generated, and fee + slippage estimate in USD.** Matt sees degradation before tapping.
- Always call `answerCallbackQuery` within 50ms of receiving the callback. Non-negotiable.
- Rate limit: Telegram allows ~30 msg/s per bot globally. At 5 signals/day we're nowhere near, but alerts + status + panic responses can spike — use a 1-msg-per-second outbound queue with a private "waiting" state, not a naive loop.
- "**Cooldown after rejection**": if Matt rejects a signal on asset X, suppress further signals on X for 30 min. Prevents "please please please" nagging.
- Daily summary at 22:00 local: "5 signals today, you approved 2, approved ones were +$0.13, rejected ones would have been -$0.04. Leak of the day: late exits on ETH." This reinforces the copilot framing.

**Warning signs:**
- Approval-to-fill delay > 10s regularly.
- Approval rate > 80% AND signal count > 10/day (you're rubber-stamping).
- Approval rate < 10% (Matt isn't trusting / reading; reduce quantity, improve quality).

**Phase to address:** Phase 5 (Telegram UI). The TTL + cap must be hardcoded before first live signal.

---

### Pitfall 8: "Leak detector" flags winning patterns as leaks

**Severity:** PAINFUL (directly attacks the Core Value)
**What goes wrong:**
The naive leak heuristic says "exits later than mean = late-exit leak." But Matt's most profitable pattern might *be* holding winners longer than he holds losers (textbook correct behavior; reverse of loss-aversion). The detector flags this as a leak, the signal generator corrects for it, and Matt's edge is destroyed. Another case: "revenge trade" is flagged anytime two losses are followed by a larger position — but if the larger position is a planned-average-down on a high-conviction mean-reversion setup that works, flagging it kills the strategy.

**Why it happens:**
Leak patterns defined purely behaviorally (size/timing signatures) without conditioning on outcome.

**How to avoid:**
- **Every candidate "leak" must be validated with expected value.** The leak is only real if `E[PnL | pattern=X] < E[PnL | pattern=not_X]` across ≥ 20 instances. Rule: no leak without evidence of negative EV.
- Show Matt the classification alongside 3 example trades from his history, **before** baking the leak into the signal generator. He must approve each leak. Human-in-the-loop defense against false positives.
- Tier leaks by confidence: "Strong" (p < 0.01, ≥ 30 samples) vs "Weak" (suggestive, low sample). Only Strong leaks get to veto signals in v1.
- Re-evaluate leaks monthly. A leak valid in Feb may be neutralized by April (Matt learned; or regime changed). Automatically expire leaks when the sample recency falls.
- Distinguish "leak" (bad habit) from "missing discipline" (e.g., didn't set stop) — different remediation.

**Warning signs:**
- A "leak correction" changes the signal distribution by > 30% (you broke the model).
- Matt reviews the leak report and says "that's not actually bad."
- Post-correction backtest PnL drops vs Matt's raw history.

**Phase to address:** Phase 2 (Behavioral analysis). Must be built before Phase 3 (ML) because the ML consumes style + leak features.

---

### Pitfall 9: News/sentiment layer amplifies pump-and-dump and fake news

**Severity:** PAINFUL
**What goes wrong:**
CryptoPanic aggregates — it doesn't verify. Fake "ETF approved" news pumps a coin, CryptoPanic's sentiment score spikes to `positive`, the bot confirms an already-technically-strong long, Matt approves, bot enters at the top of the pump, news is corrected, reversal, stop hit. Pump-and-dump groups increasingly use media seeding to trigger algorithmic bots. Additionally, CryptoPanic free-tier is ~50–200 requests/hour — a polling bot hitting it every 60s consumes the budget inside 2 hours.

**Why it happens:**
Devs trust aggregated sentiment as signal. They don't source-rank, don't cross-check, don't time-decay.

**How to avoid:**
- **News is a veto, not a driver** (PROJECT.md already says this — enforce it in code: the signal's `rationale.confidence` can only be *reduced* by news, never increased above the ML's standalone output).
- Source-rank: whitelist known outlets (Coindesk, The Block, Bloomberg, Reuters, official project Twitter verified accounts). Aggregator hits from unknown blogs = ignore.
- Require **≥ 2 independent sources** for a sentiment flip to affect trading. One headline = noise.
- Time-decay: news impact halves every 15 minutes. 2-hour-old news has near-zero influence.
- Cache CryptoPanic responses 5 min; poll rate = 1 request per 2 minutes (= 30/hour) — well under free-tier cap.
- **Hard veto on explicit pump words**: "x100", "moonshot", "next 100x" in the title or copy → score = 0, never a signal driver.
- KOL Twitter monitoring: begin with Matt's approval on a starter list. Auto-proposed list from his trade history must be reviewed by him before being live.

**Warning signs:**
- Sentiment score flipped by a single source.
- News-confirmed trades have worse win rate than ML-only trades.
- CryptoPanic returns `429 Too Many Requests` (you're over budget).

**Phase to address:** Phase 3 (News layer, after ML is producing signals).

---

### Pitfall 10: Secrets in git, logs, error messages, screenshots

**Severity:** PROJECT-KILLER (leaked MEXC API key = emptied account in minutes)
**What goes wrong:**
- `.env` accidentally committed; GitHub secret-scanners harvest within 5 minutes.
- Stack traces include `axios` request objects with `X-MEXC-APIKEY` header in stdout or log files.
- Matt screen-shares the Telegram UI to a Discord channel; the `/status` response has a truncated API key.
- `console.log(mexcClient)` prints the client with credentials inside.
- Error responses from MEXC echo back the timestamp + signature, which some devs log, which is fine, but a human reading logs starts copy-pasting error blocks to ChatGPT — pasting secrets to third parties.

**Why it happens:**
No redaction at the logging layer. No pre-commit hook. No CI scan.

**How to avoid:**
- **Gitleaks as a pre-commit hook**, non-negotiable. Block the commit if any secret pattern matches. Also run in CI.
- **Global log redactor**: central `logger.ts` that recursively walks any object and redacts keys matching `/api.?key|secret|token|password|seed|mnemonic|private.?key/i` to `****`. All other logging must route through this.
- API keys never in a string variable named `key` or `apiKey` — always in a `Secret<T>` wrapper type that throws on direct `toString()`.
- `.gitignore` includes `.env*`, `credentials*`, `secrets*`, `wallet*.json`, `*.key`, and the encrypted-secrets file by name.
- In Telegram `/status` responses, mask the last 4 chars of API key, never show the rest.
- MEXC API keys: **trading-only, no withdraw permission, IP-whitelist both the laptop's public IP and the VPS's.** If a key leaks, the attacker still cannot withdraw.
- Rotate keys after any suspected exposure. Have a "panic rotate" runbook pre-written so it takes 5 min to execute, not an hour.
- Never use Claude / ChatGPT to "debug" a live error by pasting raw logs; sanitize first.

**Warning signs:**
- GitHub secret-scanning bot emails Matt.
- MEXC security email: "unusual login from new IP."
- Unexpected balance drop.

**Phase to address:** Phase 1 (Platform setup). Redaction + gitleaks + IP whitelist + trading-only keys before any live code.

---

### Pitfall 11: WebSocket silent disconnect, missed fills, no resubscribe

**Severity:** PAINFUL
**What goes wrong:**
MEXC WS connection is valid for max 24h; server disconnects if no subscription for 30s or no data for 60s. MEXC spot has no explicit heartbeat — if the network silently drops (common on laptops, trivially common on VPS networking blips), the WS client thinks it's still connected for minutes while the bot sees no ticks. The bot's internal mark price drifts from reality. A filled order's update never arrives; bot thinks order is open, submits another.

**Why it happens:**
Devs use raw `ws` library without application-level ping/pong + version-gap detection.

**How to avoid:**
- Send PING every 15s, expect PONG within 5s. 2 missed pongs = force-reconnect.
- On reconnect: **resubscribe all previous channels + pull a REST snapshot** of positions/orders to fill the gap.
- Track `lastVersion` on depth streams. Packet loss detected by `fromVersion != lastVersion + 1` → reinitialize from snapshot.
- Rotate WS connection **proactively at 23h of uptime**, not waiting for 24h forced-close.
- Every 60s, log "WS alive, N messages in last minute." If N < expected for the channel, alarm.
- Max 30 subscriptions per connection — shard across 2 connections early rather than finding out at limit.

**Warning signs:**
- Position diverged from MEXC truth by > 0 at reconciliation.
- WS message counter stalled.
- Reconnect loop (more than 1 reconnect per hour).

**Phase to address:** Phase 1 (MEXC client) — WS must handle reconnect before Phase 4 (execution) ships.

---

### Pitfall 12: MEXC zero-fee promo economics change without warning

**Severity:** PAINFUL
**What goes wrong:**
The bot's position sizing assumes ~0% fees because MEXC futures is currently zero-fee on BTC/ETH/SOL. Matt travels to a region on the newly-excluded list (MEXC changed this in April 2025 and August 2025). Fees silently apply. Bot's threshold for "signal must be profitable" still assumes zero fees. Every trade now bleeds 0.04% round-trip. Bankroll drains.

**Why it happens:**
Fee assumption baked in as a constant, not queried from MEXC.

**How to avoid:**
- Compute fee rate dynamically: query `/api/v1/private/account/risk/limit` or parse the user's VIP tier on startup and cache for 24h. Assume **non-zero fees as the default** and treat zero-fee as a bonus.
- `requiredEdge` = `slippage + fee * 2` recomputed per trade.
- Pull MEXC announcements RSS once a day; flag any announcement containing "fee" in the title to Matt.
- **Never advertise zero-fee in the UI** — the moment you do, it'll become a user expectation that breaks.

**Warning signs:**
- A trade that back-tests to +$0.05 actually fills at -$0.02.
- Matt's account page shows a fee line item where there was none last week.

**Phase to address:** Phase 4 (Execution).

---

### Pitfall 13: Regression to the mean + style copy = bot just copies Matt's losers

**Severity:** PAINFUL
**What goes wrong:**
Matt's 60-day history includes his bad trades (that's why leak detection exists). The style-preserving ML, trained on label = "Matt's next trade," learns to predict Matt's next trade — losers included. It's a style mimic, not a style improver. Over time, the bot just becomes a slower, more hesitant Matt.

**Why it happens:**
Target label = `did_matt_trade` instead of `did_matt_trade_AND_outcome_positive`.

**How to avoid:**
- Define two targets: `entry_attractiveness` (classifier on all Matt's entries vs. engineered non-entry samples) and `entry_profitable` (classifier on entry with outcome > threshold). Only trade where **both** agree.
- Weight training samples by outcome: profitable entries get higher weight than losers. Losing entries still included (for style preservation) but at 0.5x weight.
- Explicitly **mask out trades that are flagged leaks.** Don't learn from behavior you already know is bad.
- Synthetic "anti-examples": for each Matt entry, add the same features 1 hour earlier and 1 hour later as non-entries. This teaches timing.
- Post-training check: **on held-out data, does the model's recommended trade-set outperform Matt's actual trade-set?** If not, the model is a worse Matt — reject and retrain with different target construction.

**Warning signs:**
- Bot win rate ≤ Matt's historical win rate on identical data.
- Bot often recommends entries Matt would already have made naturally.
- Bot doesn't suggest anything Matt wouldn't have done himself.

**Phase to address:** Phase 3 (ML design, specifically target definition).

---

### Pitfall 14: On-chain parsing confuses decimals, counts failed swaps, misses MEV-sandwich losses

**Severity:** MINOR → PAINFUL (distorts style fingerprint)
**What goes wrong:**
- SPL tokens have varying decimals (USDC = 6, most SPLs = 9). Parsing `tokenAmount` without dividing by `10^decimals` inflates Matt's "position size" by factor 1000. His style fingerprint shows him as a whale.
- Ethereum tx `status=0` (reverted) are counted as executed trades. Matt's stats say he takes 40 entries/day; reality is 25 + 15 failed.
- MEV sandwich attacks on Matt's swaps cost him slippage he didn't account for in PnL; his actual win rate is overstated.
- Wrapped SOL / WETH confuse "I sold SOL" vs "I unwrapped SOL."
- Jupiter aggregator routes through multiple pools; parsing the raw swap logs misses that "one Jupiter tx = multi-hop trade" and counts it as 3 separate trades.

**Why it happens:**
On-chain parsing is a whole domain of its own. Helius / Bitquery / custom — all have gotchas. Public RPC rate limit (~40 req / 10s on Solana) throws 429s.

**How to avoid:**
- Use **Helius parsed transactions** (Solana) and **Etherscan parsed transactions** (Eth) rather than raw RPC. They handle decimals + program-specific parsing. Pay the $99/mo Helius Developer if volume demands — it's cheaper than debugging parsing bugs on $10 of capital.
- Filter `status = success` before counting trades.
- Cache mint/token metadata (symbol, decimals, logoURI) in Redis once. Never refetch per tx.
- Treat a Jupiter tx as a single logical trade (in → out), not the multi-hop intermediate.
- For wrapped-token events, collapse wrap/unwrap into the underlying asset.
- Flag probable MEV sandwiches: if Matt's tx is immediately preceded by a large same-direction swap in the same pool and followed by the opposite, subtract the sandwich slippage from PnL in the ledger.
- Use dedicated RPC (Helius / QuickNode free tier, ~10 req/s). Public `api.mainnet-beta.solana.com` will 429.

**Warning signs:**
- Style fingerprint says Matt's avg position is $500k (decimal bug).
- Lots of "trades" with `pnl = 0` (failed txs counted).
- Wallet history shows negative fees (you're parsing the `fee` field as signed when it's unsigned).

**Phase to address:** Phase 2 (Data ingestion / on-chain parsing).

---

### Pitfall 15: MEXC delistings hit open positions

**Severity:** PAINFUL
**What goes wrong:**
MEXC tags a token "ST" (special treatment) and delists 3 days later. If Matt has a long on that token — spot or futures — and the bot isn't monitoring MEXC announcements, position gets force-closed at a terrible price. Or worse, the altcoin gets delisted and converted to USDT at "delisting price" (i.e., zero if nobody's bidding).

**Why it happens:**
v1 focuses on BTC/ETH/SOL only (PROJECT.md), so this is low-risk for v1 — but if Matt adds altcoins later, it becomes real.

**How to avoid:**
- v1: **hard-whitelist only BTCUSDT, ETHUSDT, SOLUSDT (spot + futures).** No other pairs at all.
- For future milestones: scrape MEXC's delisting announcements RSS once an hour. Any match against active positions → immediate Telegram alert + halt new entries on that pair.
- Hold time policy: if a position is on a pair where an ST warning is active, the bot auto-proposes exit within 24h.

**Warning signs:**
- MEXC sends Matt an email about a pair he has open.
- Order book suddenly thins.

**Phase to address:** Phase 1 (pair whitelist); Phase N+1 when altcoins are added.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single `MEXCClient` class for spot+futures | Ship one module instead of two | Signature bugs, mixed rate-limit buckets, domain migration pain, rewrite needed | Never — two auth schemes ≠ one client |
| Storing secrets in `.env` committed to "private" repo | 10-minute setup | Repo becomes public / team-shared → key exfil; GitHub scanners find it in minutes regardless | Never |
| Hardcoded `fees = 0` because of current zero-fee promo | Back-tests look great | Promo ends unannounced; all sizing broken | Never (query dynamically) |
| `console.log(client)` for debugging | Fast iteration | Key leaks to stdout, then to log files, then to screenshare | Only with a redacting logger shim |
| Using public Solana RPC (mainnet-beta.solana.com) | Free | 429 rate limits on backfill; incomplete history | MVP only for < 100 tx backfill; switch to Helius before live |
| Single Redis instance with no AOF | Fast, simple | Power loss = lose open orders, approvals, ledger | Only for local dev; prod requires AOF |
| No idempotency key on orders | "It works, shipping" | Double fills on retry; unrecoverable at $10 scale | Never for live trading |
| ML model with default LightGBM params on 200 samples | Ships quickly | Overfit, bleeds money, erodes trust in the whole bot | Never for signal generation; acceptable for diagnostic/offline explore only |
| Running bot as Windows service under Local System | Auto-start after reboot | Cannot read WinCredMan user creds; silent failure | Never — run under user account via Task Scheduler |
| "We'll add reconciliation later" | Ships faster this weekend | First laptop-sleep = corrupted state → real $ loss | Never for live exec |
| Telegram approval with no TTL | Simple | Stale fills at worse prices | Never for v1 |
| No leak-validation against EV | Faster leak report | Flags winning patterns as leaks; destroys Matt's edge | Never for production leak corrections |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| MEXC Spot auth | Sign only query string, forget to lowercase the HMAC output | HMAC-SHA256 → `.toLowerCase()`; include timestamp + recvWindow in the signed string |
| MEXC Futures auth | Sign like spot (query only) | Sign `query_string + body_json_string` (concat, no separator), put signature in `Signature` header, API key in `ApiKey` header |
| MEXC Futures base URL | Hardcode `contract.mexc.com` | Config-driven; note Jan 12, 2026 domain migration; interface unchanged, base changes |
| MEXC futures contract size | Treat "1 contract" as "1 BTC" | 1 BTC contract = 0.0001 BTC; pull from `contract_detail` per symbol |
| MEXC position mode | Assume one-way (most Binance-style tutorials do) | Query + set explicitly: `one-way` for v1 simplicity; hedge adds duplicate-position confusion |
| MEXC margin mode | Switch cross → isolated via API | MEXC only supports **isolated → cross**, not reverse. Pick cross by mistake and you're stuck until the position closes |
| MEXC recvWindow | Default 60000 ("more forgiving") | Use ≤ 5000; higher increases replay window; error `700005` if > 60000 |
| MEXC client order ID | Reuse or omit | Always pass a fresh `newClientOrderId` (spot) / `externalOid` (futures) = idempotency key |
| MEXC WebSocket | Connect and forget | 24h hard limit, 30s/60s silent-disconnect; must PING every 15s and track version gaps |
| CryptoPanic API | Poll every 30s | Cap to 1 req / 2 min (= 30/hr); cache 5 min; free tier caps at ~50-200/hr |
| Solana public RPC | Use mainnet-beta.solana.com in prod | Hit 40 req / 10s cap; use Helius or QuickNode; return 429 / 403 under load |
| Jupiter swaps | Parse raw program logs | Use Helius "Enhanced Transactions" parsed output; treat one Jupiter tx = one logical trade |
| Ethereum tx parsing | Count `status=0` reverted tx as trades | Filter `status = success`; sandwich reverts ≠ user intent |
| Token decimals | Hardcode 9 or 18 | Read from SPL Token / ERC20 metadata; cache in Redis |
| Telegram `answerCallbackQuery` | Forget it | Call within 50ms of every callback; silent drop = 15s loading clock |
| Telegram `sendMessage` | Spam all updates | Global 30/s cap; queue outbound, rate-limit to 1/s per chat |
| WinCredMan | Assume cross-user access | Cred owned by user SID; Local System / VPS cannot read; abstraction needed |
| Redis | Run without AOF | Power loss = lose all state; enable `appendonly yes`, `appendfsync everysec` |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Polling MEXC REST for fills instead of WS user-stream | 1–3s latency to detect fills; wasted rate-limit | Subscribe to private user-data WS; REST only for startup snapshot and reconciliation | At any frequency (real-time matters for approval UX) |
| Unbounded Redis signal queue | OOM on laptop; slow reads | Cap queue length to 100; TTL expired signals after 30 min | After 1 week of continuous running |
| XGBoost/LightGBM inference in-loop without batching | 30ms per prediction × N signals × N pairs = seconds | Batch predictions; cache feature computations 1s | When pair count > 3 |
| Writing full trade history to disk every order | Disk I/O spikes, sleep/wake triggers sync bugs | Use Redis AOF; flush to cold storage (parquet) hourly | At high frequency, though $10 bankroll won't generate it |
| Full-history re-ingestion on every restart | Minutes of boot time; MEXC rate-limit 429s | Incremental since-last-seen-trade; persist `last_trade_id_seen` | Immediately at > 1k trades history |
| Re-parsing on-chain history on every startup | Solana RPC 429s in 30s; hours wasted | Incremental; cache parsed txs by signature | Immediately at > 100 txs |
| Refetching token metadata per tx | Solana RPC floods | Cache in Redis indefinitely; invalidate on explicit mint change | Immediately |
| Single WS connection > 30 subscriptions | Silent subscribe-failure on 31st | 2+ connections, sharded by symbol | As soon as > 30 symbols tracked (not v1, but add later) |
| ML model loaded per prediction call | GC thrash; latency | Load once at boot, hot-swap on retrain via atomic pointer | Immediately |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| MEXC API key with withdraw permission enabled | Attacker drains account in one call | Create keys trading-only, no withdraw, no transfer; verify in key settings UI |
| API key without IP whitelist | Any credential leak = usable from anywhere | Whitelist laptop's public IP + Hostinger VPS IP; accept that changing ISP requires regenerating |
| Secrets in source + private repo | Repo could become public; GitHub scans private repos too | Gitleaks pre-commit + CI; never commit `.env`; use encrypted secret file outside repo |
| Wallet private keys near bot | Compromise = loss of entire wallet, not just trade history | Bot reads **addresses only, no private keys, ever.** On-chain parsing is read-only. Trading on-chain is out of scope for v1 |
| Telegram bot token leaked | Anyone can impersonate your bot, send fake approvals to you | Store in WinCredMan; rotate via BotFather on any suspected leak |
| Logging full request/response objects | Headers contain `X-MEXC-APIKEY`, `Signature`, etc. | Central redactor strips any key matching secret-regex before write |
| Clicking Telegram-approve from an unrecognized device | Session hijack = attacker approves real trades | Only approve from Matt's known devices; Telegram 2FA on the account |
| Running bot as admin | Compromise = whole machine | Run under regular user account; least privilege |
| Untrusted npm dependencies with wallet keys in scope | Supply-chain attack → exfil wallet addresses (read-only but still privacy) | `npm audit` in CI; lockfile committed; review new dependencies; prefer well-known libs (ccxt) over random MEXC wrappers |
| Public telegram bot (can be started by anyone) | Strangers trigger approvals / drain rate limit | Restrict bot to Matt's chat ID; reject callbacks from any other chat |
| Debug builds shipped to VPS | Verbose logging includes secrets, opens debug ports | Single `NODE_ENV=production` check; CI blocks dev deps in prod |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Approval buttons without price-delta | Matt approves stale signals; fill at worse price | Show `entry: 3500 / now: 3525 (+0.7%)` in button message |
| "Approve" as default / big button | Muscle-memory approves bad trades | Two buttons same size; "Review" / "Approve" — plus required 2-tap for any size > daily risk budget |
| 30-signal-per-day firehose | Alert fatigue → rubber-stamp or mute | Hard cap at 5; require the bot to pick its best |
| No "undo" window | Accidental tap = irrecoverable | 5-second "tap-to-cancel" countdown on every approved order before submission to MEXC |
| Leak report in raw JSON | Matt doesn't read it | Weekly digest in Telegram: "Top leak this week: X. Evidence: 3 trades. Projected savings if fixed: $Y." |
| "/status" shows balances only | Matt doesn't see risk position | Show: balance, open pos, unrealized PnL, leverage, distance to liquidation, signals pending |
| Error messages leak internals | Scary for user; also security risk | "Unable to place order (code: E_MEXC_88015)" not "InsufficientFunds: actual=7.3 required=10.0 Bearer xxxx..." |
| Silent callback | Loading clock, user taps again | Always `answerCallbackQuery`; show toast "Approved, placing order…" |
| Multiple UIs drift out of sync | CLI says balance X, web says Y | Single source of truth (Redis); all UIs read live; no UI-local state |
| No emergency stop discoverable | Panic during live trade → Matt hunts for button | `/panic` Telegram command; `q` in CLI; red button top-right on web dashboard — all cancel all open orders, close all positions, suspend bot |

---

## "Looks Done But Isn't" Checklist

- [ ] **MEXC spot orders:** Often missing `newClientOrderId` (idempotency) — verify every order request includes a unique deterministic ID derived from `signal_id`.
- [ ] **MEXC futures orders:** Often missing explicit leverage + margin mode set **before** order — verify bot does `POST /position/change_leverage` and verifies `marginType` each session.
- [ ] **WebSocket:** Often "works in testing" but drops silently in prod — verify app-layer PING every 15s + reconnect resubscribes ALL prior channels.
- [ ] **Laptop wake:** Often missing reconciliation — verify on `POWERBROADCAST` / restart, bot pulls MEXC state and DIFFS against local before enabling exec.
- [ ] **Secrets:** Often loaded but never rotated — verify key rotation runbook exists and was rehearsed.
- [ ] **Redis:** Often in RAM only — verify `CONFIG GET appendonly` returns `yes`.
- [ ] **Telegram:** Often forgets `answerCallbackQuery` — verify every callback path calls it (grep test).
- [ ] **Stop-loss:** Often client-side only — verify stops are placed on MEXC server-side as conditional orders.
- [ ] **ML model:** Often shipped without walk-forward validation — verify OOS profit factor between 1.3–2.0 is documented before going live.
- [ ] **Leak detector:** Often flags winning patterns — verify every leak has ≥ 20 samples and negative EV confirmation.
- [ ] **Position sizing:** Often ignores per-pair minNotional — verify pre-order check against `contract_detail`.
- [ ] **Fee estimation:** Often hardcoded 0 — verify fee rate is queried dynamically.
- [ ] **On-chain parsing:** Often includes failed tx — verify `status=success` filter.
- [ ] **Deduplication:** Often trusts internal state — verify idempotency key is sent on **every** order and MEXC duplicate-rejection is caught as success, not error.
- [ ] **VPS:** Often writes-enabled on day 1 — verify VPS is **read-only / alert-only** until leader election + idempotency are proven over ≥ 1 week.
- [ ] **Logging:** Often uncensored — grep the logs for any substring of API keys (you have the plaintext, search for its last 6 chars).
- [ ] **Git:** Often has history leaks — run `gitleaks detect --log-opts="--all"` against full history before first push.
- [ ] **Pair whitelist:** Often silently accepts any symbol — verify attempting `DOGEUSDT` is rejected by a hardcoded allowlist in v1.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| MEXC API key leaked | LOW (5 min) if caught fast | 1. Log into MEXC → Account → API Management → Delete key. 2. Check open orders + positions. 3. Generate new key with trading-only, IP whitelist. 4. Update WinCredMan + VPS secret. 5. Review MEXC transaction log for unauthorized activity. 6. Rotate git history if any git leak, force-push protected branch. |
| Double order (both laptop + VPS fired) | MEDIUM ($ depends on size) | 1. Close the duplicate position immediately (market order if safety requires). 2. Disable VPS exec until root-cause found. 3. Verify idempotency key logic. 4. Audit Redis `approval_id -> executed_at` for the missing SETNX. |
| Overfit model going live | MEDIUM (lose $ while discovering) | 1. Hit `/panic` to halt bot. 2. Roll back to previous model artifact. 3. Disable ML path; fall back to rule-based signals only. 4. Re-run walk-forward validation; retrain with harder regularization. |
| Laptop slept through a fill, state corrupt | LOW (minutes) | 1. Run reconciliation script: pull open pos + fills from MEXC, overwrite Redis. 2. If reconciliation detects a position without a stop, immediately set stop-loss via REST. 3. Resume bot only after full match. |
| WebSocket silently dropped, positions drifted | LOW | 1. Reconnect WS. 2. Hit reconciliation. 3. Find root cause (ping intervals, network, OS sleep). |
| False-positive leak has destroyed edge | MEDIUM (loss of PnL since leak activated) | 1. Deactivate the offending leak rule. 2. Re-run backtest without it vs with it. 3. If removing the leak restores Matt's baseline, accept the leak was wrong. 4. Require stricter EV threshold (p < 0.001) before re-activating. |
| Fee assumption wrong after promo end | LOW | 1. Query current fee rate. 2. Update `requiredEdge` constant. 3. Recompute open-signal thresholds. |
| Redis data lost (power cut, no AOF) | HIGH ($ = reconciliation pain) | 1. Enable AOF immediately. 2. Rebuild state from MEXC API (positions + fills last 7 days) + on-chain parsers for wallets. 3. Manually review all partial fills during the gap. |
| CryptoPanic rate-limited during a news event | LOW | 1. Fallback to cached last-known sentiment. 2. Reduce polling cadence. 3. Consider paid tier if events > 1/week. |
| MEXC futures API access revoked on personal account | MEDIUM | 1. Futures path degrades to read-only (reconciliation still works). 2. Trade spot-only via UI approvals OR migrate to an exchange whose futures API is public (Bybit, Binance) — PROJECT.md's MEXC-only constraint may need revisit. |
| Pump-and-dump news-driven loss | MEDIUM | 1. Tighten source whitelist (remove aggregator). 2. Raise confirmation threshold to ≥ 2 sources. 3. Add the event to the test set for future regression. |
| MEXC maintenance window hits mid-trade | LOW–MEDIUM | 1. MEXC announces in advance; subscribe RSS. 2. Bot must halt new entries 30 min pre-maintenance; keep existing stops active on server side. 3. Reconcile post-maintenance. |
| Decimal bug inflated Matt's style fingerprint | LOW | 1. Fix parser (divide by 10^decimals). 2. Re-run fingerprint. 3. Leak report must be re-validated on corrected data before shipping. |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Spot+futures conflation | Phase 1 (MEXC client) | Two separate client classes + separate rate-limit buckets; smoke test against both bases |
| 2. ML overfitting on 60 days | Phase 3 (ML pipeline) | Walk-forward CV reports OOS profit factor; ML is secondary (rules work without it) |
| 3. Minimum notional eats bankroll | Phase 4 (Execution sizing) | Pre-order check vs `contract_detail`; ETHUSDT-only whitelist |
| 4. WinCredMan cross-user break | Phase 1 (Platform/secrets) | `SecretProvider` abstraction passes on both Windows (user ctx) and Linux (file) |
| 5. Split-brain duplicate orders | Phase 4 + Phase 6 (VPS) | Idempotency key on every order; VPS starts read-only; leader-claim via Redis SETNX |
| 6. Laptop sleep orphaned orders | Phase 4 (state) + Phase 5 (resume) | Reconciliation script + server-side stops; wake-up diff vs MEXC |
| 7. Telegram approval UX | Phase 5 (Telegram) | Signal cap ≤ 5/day; 90s TTL; price delta in message; `answerCallbackQuery` grep test |
| 8. Leak false positives | Phase 2 (Behavioral) | Every leak has ≥ 20 samples + negative-EV validation; Matt approves each leak |
| 9. News pump-and-dump | Phase 3 (News) | Multi-source confirmation; veto-only; source whitelist; time decay |
| 10. Secret leakage | Phase 1 (Platform) | Gitleaks pre-commit + CI; log redactor; trading-only + IP-whitelist keys |
| 11. WS silent disconnect | Phase 1 (MEXC client) | App-level ping/pong; reconnect resubscribes; version-gap detection |
| 12. Zero-fee promo ends | Phase 4 (Execution) | Fee rate queried dynamically; `requiredEdge` recomputed per trade |
| 13. Style copy becomes loser copy | Phase 3 (ML target def) | Two-target classifier (attractive + profitable); outcome-weighted samples; OOS check bot > Matt |
| 14. On-chain parsing bugs | Phase 2 (Data ingest) | Unit tests with known-tx fixtures; decimal & wrap/unwrap & failed-tx cases; Helius parsed output |
| 15. MEXC delisting hits position | Phase 1 (pair whitelist) | Hard whitelist: only BTC/ETH/SOL v1; delisting RSS watch on later phases |

---

## Sources

### MEXC-specific (HIGH confidence — official docs & announcements)

- [MEXC Spot API — General Info (recvWindow, rate limits, signing)](https://www.mexc.com/api-docs/spot-v3/general-info)
- [MEXC Futures API — Integration Guide (HMAC signing, headers)](https://www.mexc.com/api-docs/futures/integration-guide)
- [MEXC Futures API — WebSocket docs (30s/60s disconnect, 24h max, 30 subscriptions)](https://www.mexc.com/api-docs/futures/websocket-api)
- [MEXC Futures API — Error codes (700003, 30005, 88004, 88015)](https://www.mexc.com/api-docs/futures/error-code)
- [MEXC Spot API — Websocket market streams (keepalive rules, depth version gap)](https://www.mexc.com/api-docs/spot-v3/websocket-market-streams)
- [MEXC API Updates & Technical Changes Announcements](https://www.mexc.com/announcements/api-updates)
- [MEXC to Adjust API Spot Order Rate Limit (effective March 25, 2025)](https://www.mexc.com/announcements/article/mexc-to-adjust-api-spot-order-rate-limit-effective-mar-25-2025-17827791522801)
- [MEXC Futures Trading Fee Adjustment in Select Regions (April 30, 2025)](https://www.mexc.com/announcements/article/mexc-futures-trading-fee-adjustment-in-select-regions-effective-april-30-2025-17827791523725)
- [MEXC Futures Trading Fee Adjustment in Select Regions (August 8, 2025)](https://www.mexc.com/announcements/article/mexc-futures-trading-fee-adjustment-in-select-regions-effective-august-8-2025-17827791528661)
- [MEXC Futures Position Limits & Maximum Order Quantities for BTC/ETH/SOL (Nov 2024)](https://www.mexc.com/announcements/article/mexc-futures-has-adjusted-the-position-limits-and-maximum-single-order-quantities-for-btc-eth-and-sol-usdt-margined-futures-november-7-17827791519576)
- [MEXC Perpetual Futures Trading Model (position modes, margin modes, leverage)](https://www.mexc.com/learn/article/fully-understand-the-mexc-perpetual-futures-trading-model-to-help-you-better-formulate-trading-strategies/1)
- [MEXC Isolated vs Cross Margin Mode Differences (no reverse conversion)](https://blog.mexc.com/isolated-and-cross-mode-differences/)
- [MEXC Token Delisting Notices](https://www.mexc.com/announcements/delistings)
- [MEXC Delistings: Withdrawal Period & ST Warning Rules](https://www.mexc.com/support/articles/17827791524557)
- [MEXC API Withdrawal Settings & Whitelist](https://www.mexc.com/support/articles/17327472571161)
- [MEXC Account Security Best Practices (IP whitelist, trading-only keys)](https://www.mexc.com/learn/article/six-methods-to-better-secure-your-account/1)
- [MEXC Restricted Countries List (US banned, VPN violates ToS)](https://rankfi.com/mexc-supported-countries/)
- [CCXT Issue: MEXC WebSocket unstable connections (Jan 2025)](https://github.com/ccxt/ccxt/issues/25193)
- [Mastering MEXC API Errors Developer Guide (Medium)](https://medium.com/@bxiixkana33/mastering-mexc-api-errors-a-developers-guide-to-troubleshooting-d2ce838e4c14)

### ML / quant-finance pitfalls (HIGH confidence)

- [LightGBM Parameter Tuning (regularization, small-data guidance)](https://lightgbm.readthedocs.io/en/latest/Parameters-Tuning.html)
- [Understanding LightGBM Parameters (Neptune AI)](https://neptune.ai/blog/lightgbm-parameters-guide)
- [Hyperparameter Tuning to Reduce Overfitting — LightGBM (Towards Data Science)](https://towardsdatascience.com/hyperparameter-tuning-to-reduce-overfitting-lightgbm-5eb81a0b464e/)
- [Backtesting Traps: Common Errors to Avoid (LuxAlgo)](https://www.luxalgo.com/blog/backtesting-traps-common-errors-to-avoid/)
- [Common Pitfalls in Backtesting: Comprehensive Guide for Algo Traders](https://medium.com/funny-ai-quant/ai-algorithmic-trading-common-pitfalls-in-backtesting-a-comprehensive-guide-for-algorithmic-ce97e1b1f7f7)
- [Backtesting Mistakes That Kill Quant Strategies](https://hedgefundalpha.com/education/backtesting-mistakes-kill-quant-strategies-guide/)
- [Look-Ahead Bias and How to Avoid It in Trading Strategies](https://www.marketcalls.in/machine-learning/understanding-look-ahead-bias-and-how-to-avoid-it-in-trading-strategies.html)
- [Backtesting AI Crypto Strategies: Avoiding Overfitting, Lookahead Bias, Data Leakage](https://www.blockchain-council.org/cryptocurrency/backtesting-ai-crypto-trading-strategies-avoiding-overfitting-lookahead-bias-data-leakage/)
- [IBM: What is Data Leakage in Machine Learning](https://www.ibm.com/think/topics/data-leakage-machine-learning)
- [Leakage (machine learning) — Wikipedia](https://en.wikipedia.org/wiki/Leakage_(machine_learning))
- [Model Drift in ML / Financial ML (Aerospike)](https://aerospike.com/blog/model-drift-machine-learning/)
- [Concept Drift in Finance — Managing AI Model Drift](https://www.fintechweekly.com/magazine/articles/ai-model-drift-management-fintech-applications)
- [Evolving Strategies in ML: Systematic Review of Concept Drift Detection](https://www.mdpi.com/2078-2489/15/12/786)

### Infrastructure & operational pitfalls (HIGH confidence)

- [Idempotency Keys to Prevent Duplicate Crypto Orders](https://www.tokenmetrics.com/blog/idempotency-keys-order-placement)
- [Common Pitfalls When Building Your First Crypto Trading Bot (Coin Bureau)](https://coinbureau.com/guides/crypto-trading-bot-mistakes-to-avoid)
- [Concurrency, State Management, and Fault Tolerance in Trading Bots (Medium)](https://medium.com/@halljames9963/concurrency-state-management-and-fault-tolerance-in-stock-trading-bots-da774736c58c)
- [Nautilus Trader — Live Execution Reconciliation Docs](https://nautilustrader.io/docs/latest/concepts/live/)
- [Failover, Split Brain, and Leader Election Mechanics](https://www.systemoverflow.com/learn/replication-consistency/leader-follower-replication/failover-split-brain-and-leader-election-mechanics)
- [Split-Brain Scenarios in HA PostgreSQL Clusters (prevention patterns)](https://stormatics.tech/blogs/understanding-split-brain-scenarios-in-highly-available-postgresql-clusters)
- [Redis Persistence: RDB vs AOF](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis Persistence Dive Deep — Trade-offs Performance vs Durability](https://engineeringatscale.substack.com/p/redis-persistence-aof-rdb-crash-recovery)
- [Windows Credentials — Cross-user / Service Account Limitations](https://learn.microsoft.com/en-us/windows-server/security/windows-authentication/credentials-processes-in-windows-authentication)
- [GitHub: 13M Leaked API Credentials in Public Repos (exploitation timeline)](https://medium.com/@instatunnel/github-secret-leaks-the-13-million-api-credentials-sitting-in-public-repos-1a3babfb68b1)
- [Gitleaks — Find Secrets in Git Repos](https://github.com/gitleaks/gitleaks)

### Telegram / external integrations (HIGH confidence)

- [Telegram Bots FAQ — Rate Limits & Broadcasting](https://core.telegram.org/bots/faq)
- [Solving Rate Limit Errors from Telegram Bot API](https://gramio.dev/rate-limits)
- [Telegram Callback Query Handling Best Practices](https://core.telegram.org/bots/api)
- [Solana Clusters and Public RPC Endpoints (rate limits)](https://solana.com/docs/references/clusters)
- [How to Parse Solana Transactions Efficiently](https://baransel.dev/post/parse-solana-transactions-efficiently/)
- [Jupiter Self-Hosted API & Rate Limits](https://station.jup.ag/docs/apis/self-hosted)
- [CryptoPanic Developer API](https://cryptopanic.com/developers/api/)

### Market-integrity pitfalls (MEDIUM confidence — journalistic + research)

- [Whales, Wash Trading & Fake Pumps: Crypto Market Manipulation (CCN)](https://www.ccn.com/education/crypto/crypto-market-manipulation-whales-wash-trading-fake-pumps-explained/)
- [Revert-Based MEV on Fast-Finality Rollups (arXiv, 2025)](https://arxiv.org/html/2506.01462v4)
- [Sandwich Attacks in DeFi — CoinGecko Learn](https://www.coingecko.com/learn/sandwich-attacks-prevention-crypto)
- [Behavioral Finance for Traders (DayTrading.com)](https://www.daytrading.com/behavioral-finance)
- [Revenge Trading — Aron Groups Explanation](https://arongroups.co/technical-analyze/revenge-trading/)

### Personal experience / known issues (MEDIUM confidence)

- Matt's explicit constraints in `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\.planning\PROJECT.md` (Windows + VPS topology, $10 bankroll, CPU-only ML, WinCredMan, semi-auto via Telegram).

---

*Pitfalls research for: Personal trading copilot on MEXC (spot + USDT-M futures), $10 live bankroll, local CPU-only ML on 60 days of one user's history, semi-auto via Telegram.*
*Researched: 2026-04-17*
