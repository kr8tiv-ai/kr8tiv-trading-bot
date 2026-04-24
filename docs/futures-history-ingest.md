# Futures history ingest + Telegram approvals — runbook

Created 2026-04-24 as part of the futures-first MVP. This turns `pnpm trade:app`
into a full loop:

1. Live BTC/ETH/SOL scanner pulls structure from MEXC every 30s.
2. Any plan you save shows style conflicts (pink) based on **your** last ~60
   days of futures trades — not a generic heuristic.
3. When Telegram is wired, "Review + save + Telegram" also sends the plan card
   to your phone. Approve/reject there, the cockpit row flips in SQLite, and
   the Telegram card rewrites itself with the decision stamp.

The cockpit runs without any of this (public scanner + accountability engine
need no creds). This runbook walks you through the two gates that unlock the
higher-signal product: **history ingest** and **Telegram approvals**. They are
independent — you can do either one first.

---

## 0. Preflight

- Windows 11, Node 22+, pnpm 9+ — already set up if Phase 1 signed.
- A MEXC "all-access" API key pair **with futures read permission**. If you
  only have spot creds from Phase 1, regenerate an all-access pair in the
  MEXC web UI. The key does **not** need withdraw/transfer permissions; the
  cockpit is read-only for futures account state.
- (For Telegram only) A BotFather token + your numeric chat id.

---

## 1. Provision futures creds in Windows Credential Manager

The credential provider tries two TargetName shapes on read (Phase 1 update):

1. Zowe combined `kr8tiv-mexc-bot/<secret-name>` — what `pnpm setup:credentials` writes.
2. Bare-service `kr8tiv-mexc-bot/<secret-name>` stored via cmdkey or the WCM
   UI — what the Win32 fallback in `packages/secrets/src/win32-fallback.ts`
   reads.

Either path works. The lowest-friction option is cmdkey:

```powershell
# Run a regular (non-admin) PowerShell. Replace the placeholder values.
cmdkey /generic:kr8tiv-mexc-bot/mexc-futures-access /user:MEXC_FUTURES_ACCESS /pass:mx0abcd...
cmdkey /generic:kr8tiv-mexc-bot/mexc-futures-secret /user:MEXC_FUTURES_SECRET /pass:<the secret>
```

Then verify:

```powershell
pnpm futures:status
```

Expected output (yours will differ):

```
MEXC futures account status
USDT total 104.23 | free 88.17 | used 16.06

Open BTC/ETH/SOL positions:
- BTCUSDT long 75x | contracts 0.0001 | notional 7.76 USDT | entry 77550 | mark 77620 | uPnL 0.07 USDT
```

If you see `MEXCFuturesClient requires mexc-futures-access` instead, the creds
didn't land — recheck the TargetName spelling above (`kr8tiv-mexc-bot` then
a slash then the secret-name in kebab-case).

---

## 2. Pull the last 60 days of futures trades

```powershell
pnpm history:ingest --days 60
```

This pages `fetchMyTradesPage` for BTC/ETH/SOL through MEXC and upserts into
the `trades` table via the `(venue, market, source_trade_id)` unique key — so
repeated runs are idempotent.

Output looks like:

```
Futures history ingest complete
BTCUSDT: 142 rows across 3 page(s)
ETHUSDT:  87 rows across 2 page(s)
SOLUSDT:  23 rows across 1 page(s)
```

If you want only one symbol first:

```powershell
pnpm history:ingest --days 60 --symbols BTCUSDT
```

### Sanity check

```powershell
pnpm style:fingerprint
```

You'll see per-symbol stats: sample count, avg/median hold, win rate, preferred
UTC hours, and per-hour expectancy. If `sampleCount < 10` for all three, the
style engine flags "Style evidence is still thin, so conflicts are advisory
only right now." — which is correct; the fingerprint sharpens as you trade.

---

## 3. (Optional) Enable Telegram approvals

This is the semi-auto gate: the cockpit only sends the card after you hit
"Review + save + Telegram". You approve on your phone, the SQLite row flips
`approval_status` from `pending` → `approved`, and the journal pill in the
cockpit turns green. This is how CLAUDE.md's "bot must never place an order
without explicit Telegram approval" rule is enforced.

### 3a. BotFather

1. In Telegram, open `@BotFather`.
2. `/newbot` → pick a name + username (must end in `_bot`).
3. Copy the HTTP API token BotFather gives you.

### 3b. Find your chat id

Send your new bot any message, then in a browser:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Look for `"chat":{"id":<YOUR_ID>,...}`. That integer is your chat id.

### 3c. Wire it

```powershell
# Store the token in WCM (same bare-service convention as above)
cmdkey /generic:kr8tiv-mexc-bot/telegram-bot-token /user:TELEGRAM_BOT_TOKEN /pass:<bot-token>

# Set your chat id in .env.local (non-secret — safe to keep in the repo root)
Add-Content -Path .env.local -Value "TELEGRAM_CHAT_ID=<YOUR_ID>"
```

### 3d. Boot the cockpit

```powershell
pnpm trade:app
```

On success you'll see:

```
Trader cockpit listening at http://127.0.0.1:3020
Telegram approvals enabled for chat 123456789
```

In the top-right of the cockpit, the `telegram off` pill flips to `telegram on`.

### 3e. Smoke-test the loop

1. In the cockpit, click **Scan live BTC/ETH/SOL model** (or wait — it auto-scans every 30s).
2. Click **Use this plan** on any model plan card. The intake form fills with that plan.
3. Tweak the thesis + note if you want, then hit **Review + save + Telegram**.
4. Watch Telegram — you should see a card like:

   ```
   TJ#7 • BTCUSDT LONG 75x (sniper)

   Entry  77550
   Stop   77190
   Target 78400
   Margin 12.00 USDT
   Max loss 3.36 USDT → reward 8.40 USDT (2.50R)

   Why: scalp long bias: price is above the 20 ema...
   Note: Loaded from live model; review invalidation before saving.

   [Approve]  [Reject]
   ```

5. Tap **Approve**. The card rewrites to:

   ```
   TJ#7 APPROVED (2026-04-24 14:03:55 UTC)
   BTCUSDT LONG 75x sniper
   
   Matt approved this plan. Next step: Matt fires the order on MEXC
   (firing is still manual while futures write path ships in Phase 6).
   ```

6. Back in the cockpit, the journal sidebar now shows an `approved` pill next
   to TJ#7.

If the Telegram card doesn't arrive, check the cockpit log — most likely
`TelegramConfigError: telegram-bot-token is empty` (WCM target name typo) or
`Unauthorized` (token was revoked by BotFather).

---

## 4. Where we are now vs what's next

| Layer | Status | Next |
|---|---|---|
| Public signal scanner | **live** | Add more strategies (funding, OI, liquidation cascade) as Phase 4 lands |
| Accountability engine | **live** | Tune thresholds once we have 60 days of closed trades |
| Style conflicts in cockpit | **live** | Add hour-bucket heat-map visual when `sampleCount >= 30` |
| Telegram approvals | **live (semi-auto)** | Wire futures write path so Approve actually places the order (Phase 6) |
| Futures history ingest | **live** | Auto-rerun nightly via Task Scheduler |

Approving a card today sets a paper-approval record in `trade_journal`. The
cockpit does not yet fire an order on MEXC — that ships with Phase 6 (futures
write path + EXEC-06 pair whitelist expansion). Until then, this is a
disciplined journal + signal feed, not an auto-trader.
