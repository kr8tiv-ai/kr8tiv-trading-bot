# Feature Research

**Domain:** Personal trading copilot — MEXC execution, style-learning ML, leak detection, Telegram approval loop
**Researched:** 2026-04-17
**Confidence:** MEDIUM-HIGH (HIGH on ecosystem patterns and Telegram/risk features; MEDIUM on leak-detection specifics since the "Trader's Second Brain" style leak map is emergent; HIGH on MEXC account/API mechanics)

---

## How This Product Is Different

Before the feature lists: every generic crypto bot (3Commas, Cornix, Coinrule, Cryptohopper, Gunbot, WunderTrading) is a **strategy configurator** — the user picks a strategy and the bot executes it. That is not what we are building.

This is a **personal copilot** — it starts by ingesting Matt's own 60-day history and reverse-engineering his strategy, then augments it. The closest competitors are:

1. **A.I. Oscar (OCBC Securities)** — learns from customer history, delivers 15 personalised stock ideas/week. Closed, stocks only.
2. **Trader's Second Brain** — "Leak Map" product that scans your journal for FOMO/revenge/overtrading/cooldown violations. Journal tool, not an executor.
3. **TradingAgents-Dashboard (jiwoomap/GitHub)** — AI stock bot with Obsidian Memory designed explicitly because "most AI trading tools are stateless — they analyze and forget."
4. **Freqtrade FreqAI** — open-source, Python, self-hosted ML trading. No style-preservation, no approval loop, no leak detection. Closest in architecture, far from intent.

**The gap in the market:** no existing product combines (a) "learn from MY history, not the textbook" + (b) leak-detection + (c) news/fundamental veto + (d) Telegram approval-loop + (e) self-custody execution on a specific CEX the user already trades on. That gap is what this project fills.

**This changes feature prioritization.** Anything that makes the copilot *more personal* or *more correcting of Matt's specific mistakes* is a P1 differentiator. Anything that treats Matt as a generic user is an anti-feature.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features the copilot cannot ship without. Missing any of these = product is useless or unsafe.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| MEXC Spot API read + write (order placement, cancel, balances, positions) | You can't be a copilot if you can't execute. Base: `api.mexc.com`. | MEDIUM | Auth scheme: HMAC-SHA256, `X-MEXC-APIKEY`. Rate limits ~20 req/s per IP. Windows Cred Manager for key storage (per PROJECT.md). |
| MEXC USDT-M Futures API read + write | BTC/ETH/SOL leverage is explicit in scope. Base: `contract.mexc.com` (different base + auth scheme than spot). | MEDIUM-HIGH | Separate endpoint, separate rate limits, separate auth. minVol is 1 contract; BTCUSDT contract = 0.0001 BTC. At $10 bankroll with price data, only ETH contracts are consistently affordable — binding constraint. |
| MEXC trade history ingestion (spot + futures, ≥60 days) | Core Value *is* history ingestion. Without it there's no style to learn. | MEDIUM | Paginated APIs; watch for API-only orders vs web trades distinction; normalize fills not orders. |
| Solana on-chain swap ingestion (Phantom/Solflare wallets) | Matt trades on-chain; skipping it gives a distorted style fingerprint. | MEDIUM | Solscan API free tier (strict rate limits); decode swap programs (Jupiter, Raydium, Orca). |
| Ethereum on-chain swap ingestion (MetaMask wallets) | Same — on-chain DEX activity is part of his motion. | MEDIUM | Etherscan API free tier 5 req/s; decode Uniswap v2/v3, 1inch, 0x. |
| Unified trade schema (timestamp, pair, side, size, price, fee, venue, pnl) | Every downstream feature reads this — without it, nothing analyzable. | LOW-MEDIUM | Flatten CEX fills and DEX swaps into one table. Needs USD price at fill time for cross-venue normalization. |
| Telegram bot with inline Approve/Reject buttons | The hard constraint: no order without approval. This IS the safety rail. | LOW-MEDIUM | `InlineKeyboardMarkup` with `callback_data`. Keep callback payloads under 64 bytes — hash trades to 12-byte ID + 4-byte nonce. |
| Approval-loop expiration (time-boxed staleness) | Signals rot. An "approve" 10 minutes later at a different price is dangerous. Standard in signal bots: expire the callback. | LOW | Suggest 60-120s expiration for entries, longer for exits. Edit the original message to show "EXPIRED" status. |
| Position-aware state (open positions, PnL, orders, reconciliation) | Without this the bot proposes duplicates/stacking and can't manage exits. | MEDIUM | Redis for hot state (per PROJECT.md). Reconcile with exchange on boot + wake-from-sleep (Windows laptop scenario). |
| Per-asset position caps + leverage ceiling (5x BTC / 4x ETH / 3x SOL) | Already in PROJECT.md Key Decisions. $10 cannot survive a wick at max leverage. | LOW | Hard-coded ceilings; reject orders that exceed before user even sees them. |
| Daily loss circuit breaker | Industry standard: stop trading at -3% to -5% daily drawdown. For $10, a fixed dollar floor ($2 cumulative loss) may be more useful than percentages. | LOW | Flips a "TRADING_HALTED" flag in Redis; next signal rejected with reason. Manual reset required. |
| Panic kill-switch (`/panic` or equivalent) | Non-negotiable for live-funded bots. Cancels all orders, flattens all positions, halts bot. | LOW | Bound to a single Telegram command + confirmation. |
| Signal rationale / explainability in approval message | "Buy ETH at 3200" is not approvable. User needs *why* to decide. | MEDIUM | Each suggestion must include: trigger (which feature fired), confidence, conflict-with-style flag, key levels (stop/target), news context. |
| Basic PnL + position dashboard (one of Telegram, web, CLI — not all three for v1) | Need to see state; the three-UI goal in PROJECT.md is revisit-flagged. | LOW-MEDIUM | `/status` in Telegram is the MVP. Web dashboard and CLI are v1.x. |
| Secret storage in Windows Credential Manager | Explicit constraint. API keys must not be in `.env` files. | LOW | Node bindings exist; keys never written to disk in plaintext. |

### Differentiators (Competitive Advantage)

Features that make Matt's copilot materially better than any off-the-shelf bot. These are where the product earns its existence.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Style fingerprint extraction** | Per-user profile: avg hold time, preferred pairs, entry-time bias, typical size, TP:SL ratio realized, win/loss hold-time asymmetry. Signal model is biased *toward* this fingerprint. | HIGH | The Core Value. Compute from history: median hold (winners vs losers), hour-of-day profit curve, size distribution, ATR-normalized stop distances, streak patterns. Feed these back into the ML model as user-style features. |
| **Leak-map report (weekly)** | Top 3 recurring mistakes *with evidence from specific trades*. Not "you trade too much" — "you took 4 revenge trades after BTC losses on 2026-03-11, 03-17, 03-22, 03-30; combined PnL -$X." | HIGH | Specific detectors below. Must cite trade IDs. This is the feature that compounds for Matt. Every existing tool stops at generic advice. |
| **Leak detector: revenge trade** | Trade #2 placed within N minutes of a loss, same or larger size, often on same pair. 41% of FOMO trades spawn another impulsive trade within 30 min per trading-psychology literature. | MEDIUM | Rule: `time_since_loss < 30min AND size >= prev_size AND pair == prev_pair` → flag. Post-hoc confirm with PnL — revenge trades underperform baseline. |
| **Leak detector: FOMO entry** | Entry on a candle that broke >X ATRs away from a moving average in the last M bars — Matt chased a pump. | MEDIUM | Rule: `entry_price > MA20 + 2*ATR` within 3 bars of a vertical move. Also flag "no stop set at entry" as a FOMO signature. |
| **Leak detector: late exit (bag-holding)** | Winner held past median winner-hold-time until it gave back >50% of unrealized gain. The classic "I should've sold at the top" pattern. | MEDIUM | Compute per-user: median winner hold, max-favorable-excursion vs exit price. Flag when MFE:exit ratio > threshold. |
| **Leak detector: stop widening** | Stop moved *against* position (further from entry) after being set — the "give it more room" rationalization. | LOW-MEDIUM | Diff stop-order history per position. Any adverse stop modification triggers the flag. Distinct from trailing stops (which only move favorably). |
| **Leak detector: overtrading** | Trade frequency > 130% of personal baseline over a rolling window. Research: 30%+ over baseline correlates with sharp drawdown acceleration. | LOW | Rolling 7-day trade count vs 60-day baseline. Warn in real time (before approval) when threshold exceeded today. |
| **Leak detector: ignored-stop** | Entries placed without a stop order, or stop outside rational range (>3 ATR). | LOW | Easy rule. Could be surfaced as a pre-approval warning. |
| **Leak detector: time-of-day bias abuse** | Matt has a "best hour" from history (e.g., 14:00-17:00 UTC positive expectancy). Trades outside it show negative expectancy. Flag off-hours trades. | LOW | Compute hour-of-day PnL curve from history. Warn when proposed suggestion fires in a known-loss window. |
| **Style-aware signal generation** | The model's output format: `{entry, stop, target, confidence, rationale, conflicts_with_style: boolean, conflict_reason: string | null}`. Every suggestion is labeled against Matt's style. | HIGH | Two parallel outputs: "this is Matt's style" vs "this is textbook optimal." If they diverge, flag it — user learns when to trust which. |
| **News as confirmation-or-veto layer** | ML signal fires → query CryptoPanic (last 60 min) + CoinGecko (unusual dev/social deltas) → if materially bearish news on that asset, veto or downgrade confidence. Does NOT *generate* signals from news. | MEDIUM | Veto rules: high-impact negative news <60 min old on the target asset blocks longs (and vice versa). Bullish news upgrades confidence by a clamped amount. Source weight: CryptoPanic upvote-weighted. |
| **KOL starter list proposer** | From Matt's 60-day history, cluster his pair/timing choices against known KOL post-timestamps. Propose a starter list of 10-15 KOLs whose posts correlate with his trades. | MEDIUM-HIGH | Novel feature. Uses Tweetscout-style social weight + temporal correlation. Doesn't auto-follow — proposes, Matt confirms. |
| **On-chain exchange-flow signal** | Large whale deposits into CEXs = potential sell pressure. Large withdrawals = accumulation. Feed as a categorical feature. | MEDIUM | Arkham/Etherscan/Solscan free tiers. Threshold-based (e.g., >$5M deposit to a known CEX hot wallet). Daily or hourly aggregation. Low-frequency feature. |
| **Regime-gated strategy switching** | ADX < 15 → range tactics (or don't trade). ADX 15-25 → transitional (reduce confidence). ADX > 25 → trend tactics. For crypto, typical textbook ADX 20/25 thresholds are too high — use 15/25. | MEDIUM | Gates which part of the ML model's prediction distribution gets acted on. Pairs with Bollinger Band Width percentile (squeeze detection). |
| **Funding rate filter** | USDT-M futures only. Extreme positive funding (>+0.1%/8h) warns of crowded longs — downgrade long confidence. Extreme negative (<-0.1%/8h) warns of crowded shorts. | LOW | Available in MEXC futures API. Contrarian feature, not primary driver. Useful as a veto. |
| **Semi-auto order flow: draft → approve → fire within window** | The signature UX. Order has an expiration; if user approves after expiration the bot re-fetches market and either adjusts or rejects. | MEDIUM | State machine: DRAFTED → PENDING_APPROVAL → APPROVED → SUBMITTED → FILLED/CANCELLED/EXPIRED. |
| **Conflict-with-style flag in approval UI** | When the bot recommends against Matt's usual motion (e.g., "you'd usually widen the stop here — I'm recommending you don't"), explicitly annotate it. | LOW | String field in the Telegram card. Makes the learning loop visible. |
| **Approve-and-modify flow (not just approve/reject)** | User gets inline buttons: Approve | Tighter stop | Smaller size | Reject. Advanced modifications via reply-text parsing. | MEDIUM | Differentiator vs generic signal bots. Lets Matt inject judgment without losing bot's risk structure. |
| **Multi-timeframe exit PnL replay ("what if")** | Per-trade retrospective: "if you had held 1h, 4h, 24h longer, PnL would be X." Feeds leak report. | MEDIUM | TradesViz has this feature for retail journals. Computable from OHLCV after-the-fact. |
| **MEXC zero-fee futures promo awareness** | When MEXC is running a zero-fee promo on a tradable pair, the model downweights fee penalties in expected-value math. Matters disproportionately at $10. | LOW | Config flag or scraped from MEXC campaigns page. Not critical but a nice-to-have optimization. |
| **Separate MEXC sub-account for bot API keys** | Isolation: if bot keys leak, main account is safe. MEXC supports API-only sub-accounts with no login — designed for this. | LOW (infra), but MEDIUM (initial setup) | Main→sub transfers for capital, sub has its own API keys, trade data still consolidates. Strong recommendation — no additional bot logic, just setup hygiene. |
| **Signal cooldown enforcement** | After a rejected approval or a losing trade, enforce an N-minute cooldown before the next signal on the same pair. Blocks the revenge trade spiral at the source. | LOW | 30-min cooldown aligns with the "41% FOMO→revenge within 30 min" research. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that sound useful but are actively wrong for this project.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Fully autonomous execution (no approval)** | "Just let the bot trade while I sleep" — saves user time. | Violates PROJECT.md constraint. $10 bankroll + emotional-leak-prone trader + new ML model = autonomy is reckless. Approval is the *value*, not the friction. | Keep semi-auto in v1. A future "trusted strategy" track (e.g., mechanical funding-farm) may unlock auto-execute in a later milestone, but gate it by recorded track record. |
| **Generic strategy marketplace (copy a top trader)** | Common on 3Commas/Cornix: pick from a list of published strategies. | Project is explicitly "learn from Matt's OWN history." Copying someone else's style defeats the Core Value. | Use his 60-day history only. No imported strategies. |
| **Backtesting engine with optimization UI** | "Tune the strategy on past data." | Massive scope creep (backtest frameworks are their own multi-week projects). Also encourages overfitting, which is *the* classical-ML trap. | Forward-test live with $10 as the validation. PROJECT.md explicitly rejects paper mode — same argument applies to elaborate backtesting UI. Minimal walk-forward check in the ML training pipeline only. |
| **Paper-trading mode** | Standard safety pattern. | PROJECT.md explicitly out of scope: "$10 IS the test." Adding a simulation ledger doubles execution code paths. | Live from day 1 on $10; scale only after leak reduction is measurable. |
| **Mobile app (React Native / iOS)** | Most retail products have mobile. | Telegram already runs on mobile. Native app = 10x effort for duplicate functionality. | Telegram bot is the mobile surface (explicit in PROJECT.md Out of Scope). |
| **Tax / accounting / portfolio reporting** | "Show me my YTD PnL by asset for taxes." | Explicitly out of scope. Ledger exists internally for bot logic, not as a user-facing tax product. | Export raw trade history to CSV if needed; real tax work uses Koinly/CoinTracker. |
| **News-driven primary signals (news pumps an entry)** | "Bot trades the news!" sounds powerful. | News is lagging, ambiguously sentimented, and trivially front-run by faster algos. Optimizing on news → chasing pumps → FOMO leak *by design*. | News as confirmation/veto only. ML signal must fire first. |
| **Copy-trading / mirror trading** | Social feature, common on Bybit/Bitget. | Defeats style preservation. Copying someone else's trades is literally the opposite of "learn from your own history." | Out of scope. |
| **Multi-exchange routing / smart order router** | "Execute on whichever exchange has best price." | PROJECT.md: MEXC-only in v1. Keeping to one venue makes state management tractable. | Single-venue execution; multi-venue history (read-only) is already planned. |
| **Deep learning / transformer models** | "SOTA models are transformers now!" | CPU-only constraint in PROJECT.md. Also: tabular financial data is where XGBoost/LightGBM *beat* deep learning in most published research. | XGBoost or LightGBM; consider CatBoost for categorical-heavy features. |
| **LLM-based signal generation** | "Ask the LLM what to trade." | CPU-only + no-cloud-inference constraint. Also unreliable for quantitative tasks. | Classical ML only. Use Claude/GPT for the *build process* (this project), not the runtime. |
| **Real-time tick-data streaming everywhere** | "We need sub-second data!" | Expensive (rate limits, storage, compute). Matt isn't HFT. Candle-close bars (1m/5m/15m) are sufficient for a semi-auto approval-loop copilot. | WebSocket for position/order updates; REST polling on 1m/5m bars for signals. |
| **Unlimited asset coverage (trade everything MEXC lists)** | MEXC lists 3000+ pairs — "why not trade them all?" | Liquidity is terrible on the long tail; slippage destroys $10 accounts; model training data is thin. | BTC / ETH / SOL only in v1 (explicit in PROJECT.md). Expand only after leak-reduction is proven. |
| **"Trust score" auto-upgrade to full autonomy** | "After N good trades, let the bot go auto." | Dangerous drift from the copilot framing. Matt's discipline is the edge. Removing him from the loop removes the edge. | Gate any future autonomy unlock behind explicit per-strategy review + hardcoded leverage/loss caps. Deliberately slow path. |
| **Social features / leaderboard / sharing trades** | "Competition motivates users." | Social features leak alpha, amplify FOMO (seeing others win pumps impulse trading), and drag focus from Matt's own improvement. | Keep it private. Optional: weekly self-comparison to Matt's *own* prior weeks. |
| **Real-time everything dashboard with 20 charts** | "I want to see all the data." | Signal-to-noise collapses; user stares at dashboard instead of trading. | Minimal dashboard: open positions, today's PnL, pending approvals, most-recent leak flag. That's it. |
| **Stop-loss overrides by user in approval UI (wider stop)** | "Let me widen the stop if I think it'll come back." | **Stop widening is itself a flagged leak.** Permitting it via UI undercuts the whole leak-detection loop. | Approve/Reject/*Tighter* stop only. Never a "widen" button. If user wants to widen, they can manage on the exchange UI — the bot will flag it next report. |
| **Auto-tuning / continuous online learning** | "Bot gets smarter as it trades." | Online learning on $10 data = overfitting to noise. Known failure mode. | Weekly offline retrain at most. Never per-trade parameter adjustment. |

---

## Leak Detector Catalog (detailed)

The leak-detection feature set is the heart of the differentiator. Each detector needs: (a) a quantitative rule, (b) cited evidence from the trade history, (c) a severity/frequency count, and (d) an actionable suggestion.

| Leak | Detection Rule | Evidence Required | Severity Signal |
|------|----------------|-------------------|-----------------|
| Revenge trade | Entry within 30 min of a loss, same pair, size ≥ prev | Trade ID of loss + trade ID of revenge trade, time delta, size ratio | Count frequency + avg PnL of revenge trades vs baseline |
| FOMO entry | Entry >2 ATR above MA20 during a >3-bar vertical move | Candle snapshot + entry timestamp + ATR/MA context | Count frequency + comparison to planned-entry baseline |
| Late exit (bag hold) | Winner held past 1.5x median winner-hold; gave back >50% MFE | Position lifecycle + MFE curve | Total $ left on table vs "sold at MFE*0.7" counterfactual |
| Stop widening | Stop order modified to move further from entry, post-entry | Stop-order modification log | Count incidents + $ impact vs "original stop held" |
| Overtrading | 7-day trade count > 1.3x 60-day baseline | Trade count timeseries | Days exceeded + PnL on those days vs normal-frequency days |
| Ignored stop | Entry placed without a stop order within 60s | Order-placement log | Count + drawdown on stop-less positions |
| Time-of-day abuse | Entries in personally negative-expectancy hours | Hour-of-day PnL curve + trade hour | Hours flagged + aggregate PnL drag from those hours |
| Chasing pumps | Entry on >5% up-move in last 3 bars | Price action at entry | Count + subsequent 24h PnL of chase entries |
| Size inflation after losses | Size > baseline 1.5x after 2+ consecutive losses | Session trade sequence + sizes | Count + PnL of inflated trades |
| Weekend/off-hours binge | Trade frequency spike during unfocused windows (e.g., late night) | Timestamp clustering | Comparison to focused-hours PnL |

**Delivery cadence:** One "leak report" per week via Telegram + dashboard. Max 3 leaks surfaced per report (avoid overwhelming). Keep the tone constructive: "Here's one thing to work on this week."

---

## Approval-Loop UX Specification

This is the most user-facing feature and the most easily screwed up. Details matter.

**The card (Telegram message):**

```
🟢 LONG ETH/USDT @ ~3200
Size: 1 contract (~$0.32 notional × 4x = $1.28 exposure)
Stop: 3150 (-1.56%)  |  Target: 3290 (+2.81%)
RR: 1.8  |  Confidence: 0.72  |  Regime: TREND (ADX 28)

Why: 15m EMA crossover + orderbook imbalance +
     CryptoPanic +2 bullish (ETF inflow story, 12min old)

⚠️  Conflict with your style: you usually wait for a pullback here.
     Historically your "pullback wait" entries outperform by +0.4R.

Expires in 90s.

[ ✅ Approve ] [ 🎯 Tighter stop (3170) ] [ 📉 Half size ] [ ❌ Reject ]
```

**State machine:**
1. `DRAFTED` — ML fires, news check clears, leak check clears → compose card
2. `PENDING_APPROVAL` — card sent to Telegram, 60-120s countdown starts
3. `APPROVED` | `MODIFIED` | `REJECTED` | `EXPIRED` → terminal for approval
4. `SUBMITTED` — order goes to MEXC
5. `FILLED` | `CANCELLED` | `PARTIAL` — terminal for execution

**Rules:**
- Callback data: 12-byte hash + 4-byte nonce; server lookup (Telegram 64-byte limit).
- On expiry: edit the original message to show "EXPIRED" (not a new message — keeps chat clean).
- On approve: edit to "APPROVED → submitting" → "FILLED @ price" or "FAILED: reason."
- On reject: 30-min cooldown on same pair. Visible in next /status.
- If market moved >0.3% during approval window: re-draft or auto-reject with "stale price."
- User never sees raw errors; exchange errors get translated to plain English.

**Commands:**
- `/status` — current positions, today's PnL, pending approvals
- `/panic` — confirmation prompt, then cancel-all + flatten-all + HALT
- `/resume` — clears the HALT flag (after circuit breaker)
- `/leaks` — show this week's leak report
- `/style` — show current style fingerprint

---

## Feature Dependencies

```
[Trade ingestion: MEXC + Solana + Ethereum]
    └──requires──> [Unified schema]
        └──requires──> [Style fingerprint extraction]
            └──requires──> [Style-aware signal generation]
                └──enhances──> [Conflict-with-style flag]

[Unified schema]
    └──requires──> [Leak detectors]
        └──requires──> [Weekly leak report]

[MEXC Spot + Futures API]
    └──requires──> [Position-aware state]
        └──requires──> [Panic kill-switch]
        └──requires──> [Circuit breaker]

[ML signal generation]
    └──requires──> [Regime detection (ADX)]
    └──enhances──> [News veto layer]
    └──enhances──> [Funding rate filter]
    └──enhances──> [On-chain flow signals]

[Telegram bot]
    └──requires──> [Approval card rendering]
        └──requires──> [Expiration + state machine]
        └──requires──> [Callback data hashing]

[Approval flow]
    └──requires──> [Signal rationale/explainability]
    └──requires──> [Conflict-with-style flag]
    └──requires──> [Leak pre-check (warn on revenge/overtrading at draft time)]

[KOL proposer]
    └──requires──> [Style fingerprint + X/Twitter scraping]
    └──is_blocked_by──> [X API access constraints — may need scraping]
```

### Dependency Notes

- **Style fingerprint blocks everything downstream.** If we can't extract a useful fingerprint from 60 days, the whole differentiator story breaks. This must be validated *early* — literal week-1 work.
- **Unified schema is the central data contract.** Everything — leaks, style, signals — reads from it. Design once, carefully; churning it later is expensive.
- **News veto depends on reliable news feed.** CryptoPanic free tier has rate limits; monitor for outages. Fallback: skip the check (don't block trades on news outage — fail open, since ML+style is primary).
- **Leak detectors depend on rich trade metadata** — fills *and* order modifications, not just closed trades. Stop-widening detection needs the modification log specifically.
- **Regime detection (ADX) gates strategy selection** — must be computed before signal generation runs, not after.
- **Panic kill-switch conflicts with rate-limited APIs.** Flattening everything may hit cancel-all rate limits; batch properly.
- **Approval expiration conflicts with slow Telegram delivery.** If user's notification arrives 30s late, the remaining 60s window may be too short. Monitor Telegram delivery latency.

---

## MVP Definition

### Launch With (v1 — Weekend Target)

The thin vertical slice that validates the core thesis: *can Matt's 60-day history produce a useful style fingerprint and a single approvable trade?*

- [ ] **MEXC spot history ingest** (single asset: ETH — it's the only consistently tradeable contract at $10)
- [ ] **MEXC spot API write** with a single order type (market or limit)
- [ ] **Unified trade schema** (even if minimal: timestamp, pair, side, size, price, fee, PnL)
- [ ] **Basic style fingerprint**: avg hold, median size, hour-of-day expectancy, win/loss hold asymmetry. Nothing fancier.
- [ ] **One signal generator** (even a simple rule-based EMA crossover) as the ML scaffold — prove the pipeline before investing in XGBoost training.
- [ ] **Telegram bot with Approve/Reject** (no modify buttons yet) and 90s expiration
- [ ] **Rationale string** in the card (why this signal fired, what levels)
- [ ] **One leak detector**: *revenge trade* (it's the easiest to detect, highest frequency, most damaging). Proves the leak-report feature path.
- [ ] **Position-aware state** (Redis: open positions, pending approvals)
- [ ] **Panic kill-switch** via `/panic`
- [ ] **Daily loss circuit breaker** ($2 absolute or -20% of bankroll)
- [ ] **Windows Credential Manager integration** for secrets
- [ ] **Leverage cap** (4x ETH per PROJECT.md)
- [ ] **Conflict-with-style flag** (even if primitive: "you don't usually trade this hour")
- [ ] **`/status` command** for positions + today's PnL
- [ ] **One live approved trade executed end-to-end on $10**

This is the minimum that validates the learning loop. Hit this and the project has already succeeded per PROJECT.md Core Value.

### Add After Validation (v1.x)

Once v1 is running live and the first trade is approved+executed, expand in this order:

- [ ] **ETH futures API write** (not just spot) — enables leverage, proper $10 utility
- [ ] **BTC and SOL support** — expand universe after ETH loop is proven
- [ ] **On-chain history ingest** (Solana + Ethereum wallets) — richer fingerprint
- [ ] **Full leak detector suite**: late exit, stop widening, overtrading, FOMO, time-of-day, chasing, ignored stop, size inflation
- [ ] **Weekly leak report** (Telegram + simple markdown export)
- [ ] **CryptoPanic news veto layer**
- [ ] **XGBoost or LightGBM model** replacing rule-based signal (offline-trained on history)
- [ ] **ADX regime gating** (block trades in squeeze; trend/range strategy switch)
- [ ] **Funding rate filter**
- [ ] **Modify-in-approval buttons**: Tighter stop, Half size
- [ ] **Local web dashboard** (one of the three UIs in PROJECT.md; pick based on what Matt actually uses)
- [ ] **Signal cooldown enforcement** (30min post-reject or post-loss on same pair)
- [ ] **Approval-expiration price-drift re-check**
- [ ] **Hostinger VPS failover deployment**

### Future Consideration (v2+)

Defer until core value is demonstrated over multiple weeks.

- [ ] **CLI dashboard** — only if web/Telegram aren't enough
- [ ] **KOL starter list proposer** — needs X/Twitter access solved; potentially expensive
- [ ] **On-chain exchange-flow signal** — Arkham/Solscan integration; low-priority feature
- [ ] **Multi-timeframe exit "what-if" analysis** in leak report
- [ ] **CoinGecko dev-activity / social-stats features**
- [ ] **Additional ML models** (ensemble, CatBoost)
- [ ] **Automatic model retraining pipeline** (weekly walk-forward)
- [ ] **Additional assets beyond BTC/ETH/SOL**
- [ ] **"Trusted strategy" auto-execute track** for mechanical funding-farm-like setups (very carefully, with hardcoded limits)
- [ ] **MEXC zero-fee promo detection**
- [ ] **Sub-account setup automation** (manual sub-account is fine for v1; automating is deferred)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| MEXC spot API read+write | HIGH | MEDIUM | P1 |
| MEXC futures API read+write | HIGH | MEDIUM-HIGH | P1 (needed for leverage) |
| Trade history ingest (MEXC) | HIGH | MEDIUM | P1 |
| Unified schema | HIGH | LOW-MEDIUM | P1 |
| Telegram Approve/Reject bot | HIGH | LOW-MEDIUM | P1 |
| Approval expiration | HIGH | LOW | P1 |
| Panic kill-switch | HIGH | LOW | P1 |
| Leverage ceiling | HIGH | LOW | P1 |
| Daily loss circuit breaker | HIGH | LOW | P1 |
| Style fingerprint (basic) | HIGH | MEDIUM | P1 |
| Rule-based signal (placeholder) | MEDIUM | LOW | P1 |
| One leak detector (revenge) | HIGH | MEDIUM | P1 |
| Signal rationale string | HIGH | LOW | P1 |
| Conflict-with-style flag (basic) | HIGH | MEDIUM | P1 |
| Position-aware state (Redis) | HIGH | MEDIUM | P1 |
| Windows Credential Manager | HIGH | LOW | P1 |
| On-chain ingest (Sol + Eth) | MEDIUM | MEDIUM | P2 |
| Full leak detector suite | HIGH | MEDIUM-HIGH | P2 |
| Weekly leak report | HIGH | MEDIUM | P2 |
| XGBoost/LightGBM model | HIGH | HIGH | P2 |
| ADX regime gating | MEDIUM | MEDIUM | P2 |
| CryptoPanic news veto | MEDIUM | MEDIUM | P2 |
| Funding rate filter | MEDIUM | LOW | P2 |
| Modify buttons in approval | MEDIUM | MEDIUM | P2 |
| Local web dashboard | MEDIUM | MEDIUM | P2 |
| Signal cooldown post-reject | HIGH | LOW | P2 |
| Sub-account setup (manual) | MEDIUM | LOW | P2 |
| Hostinger VPS failover | MEDIUM | MEDIUM | P2 |
| CLI dashboard | LOW | MEDIUM | P3 |
| KOL proposer | MEDIUM | HIGH | P3 |
| On-chain exchange-flow signal | MEDIUM | MEDIUM | P3 |
| Multi-timeframe "what-if" | LOW | MEDIUM | P3 |
| CoinGecko social/dev features | LOW | MEDIUM | P3 |
| MEXC zero-fee promo detection | LOW | LOW | P3 |
| "Trusted strategy" auto-execute | MEDIUM | HIGH | P3 (risky) |

**Priority key:**
- P1: MVP — must ship to validate the concept
- P2: v1.x — strong differentiators or standard-table-stakes added once P1 is alive
- P3: v2+ — nice-to-have; revisit after 4+ weeks of live running

---

## Competitor Feature Analysis

| Feature | 3Commas | Cornix | Coinrule | Cryptohopper | Freqtrade (OSS) | **This Copilot** |
|---------|---------|--------|----------|--------------|-----------------|------------------|
| Learns from user's own history | No | No | No | Partial ("learning trades") | No | **Yes — core feature** |
| Style fingerprint | No | No | No | No | No | **Yes — differentiator** |
| Leak detection | No | No | No | No | No | **Yes — differentiator** |
| Weekly leak report | No | No | No | No | No | **Yes — differentiator** |
| Telegram approval loop | Notifications only | Signals→auto-execute | Notifications | Yes (partial) | Plugin | **Yes — core UX** |
| Approve-and-modify (tighter stop, half size) | No | No | No | No | No | **Yes — differentiator** |
| News as veto (not primary) | No | No | No | No | No | **Yes — differentiator** |
| Generic strategy templates | Extensive | Extensive | Extensive | Extensive | User-built | **None — by design** |
| Paper-trading mode | Yes | Yes | Yes | Yes | Yes | **No — out of scope** |
| Copy-trading | Yes | Yes (signals) | No | Yes | No | **No — anti-feature** |
| Multi-exchange | 15+ | 10+ | 10+ | 15+ | 5+ | **MEXC only in v1** |
| Backtesting UI | Yes | Yes | Yes | Yes | Yes | **Minimal/none** |
| Cloud-hosted | Yes | Yes | Yes | Yes | Self-host | **Self-host (local+VPS)** |
| Self-custody execution | Partial | Partial | Partial | Partial | Yes | **Yes — local keys** |
| Conflict-with-style flag | N/A | N/A | N/A | N/A | N/A | **Yes — unique** |

**Key insight:** Every generic bot competes on "more exchanges / more strategies / more features." This copilot competes on "more *you* — specifically tuned to your history, actively correcting your mistakes." It does *less* than 3Commas on purpose; the value is depth on one user, not breadth across users.

---

## Recommendations for the Roadmap

Six phases, optimized for the "ship v1 by weekend" aspiration and the Core Value (leak identification + style preservation).

1. **Phase 1: Data foundation** — MEXC history ingest + unified schema + Windows Credential Manager. Everything reads from here.
2. **Phase 2: Execution skeleton** — MEXC spot API write + position-aware state + leverage caps + circuit breaker + panic kill-switch. Prove you can place and kill orders safely.
3. **Phase 3: Telegram approval loop** — card rendering + state machine + expiration + Approve/Reject. This plus Phase 2 is already a live "manual semi-auto" system.
4. **Phase 4: Style fingerprint + basic signal** — compute fingerprint; ship a rule-based signal generator; wire to approval flow; include rationale + conflict-with-style flag. **End of Phase 4 = MVP: first live approved trade.**
5. **Phase 5: Leak detector v1** — start with revenge-trade detector; wire to pre-approval warning and weekly report stub. Proves the learning loop.
6. **Phase 6: ML signal + news veto + more leaks + futures** — XGBoost model, ADX regime gating, CryptoPanic veto, remaining leak detectors, MEXC futures write path.

Phases 1-5 are the MVP. Phase 6 is v1.x — everything else falls further out.

---

## Sources

### Trading psychology / leak detection
- [Trader's Second Brain — leak map product](https://traderssecondbrain.com/) — primary reference for leak taxonomy (HIGH confidence on pattern list; MEDIUM on specific thresholds)
- [FOMO Trading Guide 2026](https://traderssecondbrain.com/guides/fomo-trading) — cited 41% FOMO→revenge-within-30-min stat and 90-second reset protocol
- [BloFin Academy — Trading Psychology](https://blofin.com/en/academy/education/crypto-trading-psychology) — FOMO, loss aversion, revenge trading cascade
- [Maverick Trading — Mastering FOMO & Revenge](https://mavericktrading.com/mastering-fomo-and-revenge-trading-a-traders-guide/) — definitional + pattern evidence
- [TradesViz — Trading Psychology](https://www.tradesviz.com/trading-psychology/) — per-trader pattern recognition approach
- [TradesViz Multi-Timeframe Exit Analysis](https://www.tradesviz.com/blog/multi-timeframe-exit-pnl/) — exit-timing "what if" analysis precedent
- [Katoshi Blog — Automated Trade Journaling](https://katoshi.ai/blog/automated-trade-journaling-leveraging-analytics-for-continuous-strategy-improvement) — journal→analytics pipeline patterns
- [AnalyzeMyTrades](https://www.analyzemytrades.com/) — AI-powered trade journal analysis

### Competitor trading bots
- [Coinrule — vs 3Commas vs Cornix comparison](https://coinrule.com/versus/3commas-vs-cornix-vs-coinrule/)
- [CoinGabbar — Top 10 Crypto Trading Bots 2026](https://www.coingabbar.com/en/crypto-blogs-details/crypto-trading-bots-top-10-picks-reviewed-and-compared-for-2026)
- [altFINS — Best Crypto Trading Bots 2025](https://altfins.com/knowledge-base/best-crypto-tradings-bots-2025/)
- [CryptoAdventure — Trading Bots Wars](https://cryptoadventure.com/trading-bots-wars-3commas-vs-wundertrading-vs-coinrule-vs-tradesanta/)
- [NFTPlazas — 10 Best Crypto Trading Bots 2026](https://nftplazas.com/best-crypto-trading-bot/)

### Personal / style-aware trading assistants
- [altFINS AI Copilot](https://altfins.com/knowledge-base/altfins-ai-copilot/) — natural-language screener
- [Jenova — AI Stock Trading Copilot](https://www.jenova.ai/en/resources/ai-stock-trading-copilot) — research/alerts without execution (semi-auto philosophy)
- [OCBC A.I. Oscar](https://www.globalbankingandfinance.com/revolutionizing-tradingmeet-ocbc-securities-a-i-oscar-your-personalized-ai-trading-assistant/) — learns from customer history (closest conceptual precedent)
- [BetterTrader AI-Trader Copilot](https://blog.bettertrader.co/2025/01/05/meet-ai-trader-copilot-your-ultimate-trading-assistant-from-bettertrader-co/)
- [TradingAgents-Dashboard (GitHub)](https://github.com/jiwoomap/TradingAgents-Dashboard) — stateful per-user trading AI architecture
- [Ventureburn — 15 AI Trading Bots 2026](https://ventureburn.com/how-to-use-ai-for-crypto-trading-overview-of-15-ai-trading-bots-in-2026/)

### Telegram bot / approval-loop UX
- [Telegram Bot API — official](https://core.telegram.org/bots/api)
- [Telegram Bot Buttons docs](https://core.telegram.org/api/bots/buttons)
- [Bitders — Telegram Keyboard Types Guide](https://bitders.com/blog/telegram-bot-keyboard-types-a-complete-guide-to-commands-inline-keyboards-and-reply-keyboards) — callback_data limits, inline keyboard patterns
- [Telegram Inline Keyboard UX Design](https://wyu-telegram.com/blogs/444/) — edit-existing-message best practice
- [EODHD — Telegram Trading Bot Step-by-Step](https://eodhd.medium.com/telegram-trading-bot-step-by-step-guide-433a61dbf557)
- [Alertatron — Signals Lite Trading from Telegram](https://alertatron.com/docs/signals-lite/trading-from-telegram) — signal-to-order timing patterns

### News / sentiment / fundamentals
- [CryptoPanic — News Aggregator](https://cryptoslate.com/companies/cryptopanic/)
- [CryptoPanic News Scraper](https://apify.com/trev0n/cryptopanic-news-scraper)
- [EAK Digital — Top 10 Crypto News APIs 2026](https://eakdigital.com/top-10-crypto-news-apis-real-time-data-for-trading/)
- [FalconScrape — Scraping CryptoPanic for Sentiment](https://www.falconscrape.com/blog/how-to-scrape-cryptopanic-news)

### ML / signal generation
- [Stefan Jansen — ML for Trading (Gradient Boosting)](https://stefan-jansen.github.io/machine-learning-for-trading/12_gradient_boosting_machines/) — canonical XGBoost/LightGBM-for-trading reference
- [arXiv — Crypto Price Prediction with XGBoost+LSTM](https://arxiv.org/html/2506.22055v1) — 2026 empirical study; XGBoost R²=0.808 on BTC, ~0.84 on ETH
- [MDPI — Algorithmic Trading & AI Forecasting](https://www.mdpi.com/2227-7390/10/18/3302)
- [Medium (2026) — Ultimate Python Quant Trading Ecosystem](https://medium.com/@mahmoud.abdou2002/the-ultimate-python-quantitative-trading-ecosystem-2025-guide-074c480bce2e)
- [Freqtrade FreqAI docs](https://www.freqtrade.io/en/stable/freqai/) — OSS self-hosted ML trading

### Regime detection / indicators
- [Thrive — Crypto Market Regime Detection](https://thrive.fi/blog/trading/crypto-market-regime-detection)
- [Regime Signals — Adaptive Multi-Strategy](https://www.regimesignals.com/)
- [PyQuantLab — Regime Filtered Trend Strategy](https://pyquantlab.com/article.php?file=Regime+Filtered+Trend+Strategy+A+Market-Adaptive+Trend-Following+System.html)
- [ChartWiseHub — ADX 2026 Guide](https://chartwisehub.com/adx-average-directional-index-tradingview-guide/)
- [Altrady — ADX for Crypto](https://www.altrady.com/crypto-trading/technical-analysis/average-directional-index-adx)

### Funding rates / on-chain
- [Phemex Academy — Funding Rate Signals](https://phemex.com/academy/what-is-funding-rate-in-crypto-futures)
- [Metamask — Monitoring Perp Funding Trends](https://metamask.io/news/monitoring-perps-funding-rate-trends-signals)
- [CryptoQuant — Funding Rates User Guide](https://userguide.cryptoquant.com/cryptoquant-metrics/market/funding-rates)
- [Solscan — Solana blockchain explorer + API](https://solscan.io/apis)
- [Arkham Intel — Solana](https://intel.arkm.com/explorer/token/solana)
- [MEXC — 8 Best Crypto Transaction Trackers](https://www.mexc.com/news/941032)

### MEXC specifics
- [MEXC Futures API docs](https://www.mexc.com/api-docs/futures/market-endpoints)
- [MEXC Spot API docs](https://www.mexc.com/api-docs/spot-v3/introduction)
- [MEXC Sub-Account Endpoints](https://www.mexc.com/api-docs/spot-v3/subaccount-endpoints) — API-only sub-accounts
- [MEXC Sub-Account Management (Learn)](https://www.mexc.com/learn/article/17827791510597)
- [MEXC 0-Fee Fest campaign](https://www.mexc.com/zero-fee)
- [MEXC Trading Fees reference](https://www.mexc.com/fee)
- [Bitdegree — MEXC Fees 2026](https://www.bitdegree.org/crypto/tutorials/mexc-fees)
- [MEXC Futures minimum contract sizes (contract_v1_en)](https://mexcdevelop.github.io/apidocs/contract_v1_en/)
- [pymexc — Python client reference](https://pypi.org/project/pymexc/) — useful for API-shape understanding
- [Socket.dev — MEXC API key theft warning](https://socket.dev/blog/malicious-chrome-extension-steals-mexc-api-keys) — reinforces sub-account isolation case

### Risk management / position sizing
- [3Commas — AI Trading Bot Risk Management 2025](https://3commas.io/blog/ai-trading-bot-risk-management-guide-2025) — circuit breakers, daily limits
- [Vantixs — Crypto Trading Bot Safety 2026](https://vantixs.com/blog/crypto-trading-bot-safety-guide-2026)
- [LBank — Kelly Criterion for Crypto Risk](https://www.lbank.com/explore/mastering-the-kelly-criterion-for-smarter-crypto-risk-management) — fractional Kelly recommendation for volatile assets
- [Matthew Downey — Fractional Kelly Simulations](https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html)
- [CryptGambling — Fractional vs Full Kelly](https://cryptogambling.com/guides/sports-betting/fractional-kelly-practical)
- [Coin Bureau — Trading Bot Mistakes to Avoid](https://coinbureau.com/guides/crypto-trading-bot-mistakes-to-avoid)

### KOL / social-weight analysis
- [CoinLaunch — KOL Database](https://coinlaunch.space/influencers/twitter/)
- [Tweetscout — Web3 Social Analytics](https://tweetscout.io/)

---

*Feature research for: kr8tiv-mexc-bot — personal trading copilot with style-preservation, leak-detection, and Telegram approval loop on MEXC*
*Researched: 2026-04-17*
