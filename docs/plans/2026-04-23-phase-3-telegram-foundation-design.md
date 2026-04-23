# Phase 3 Telegram Foundation Design

**Date:** 2026-04-23
**Scope:** Build the fail-closed Telegram approval foundation without enabling live Telegram delivery yet.

## Goal

Create the shared contracts and runtime-safe scaffolding for Phase 3 so the later live bot wiring becomes composition work instead of invention.

## Approach

We add a new `@kr8tiv/telegram-bot` workspace package with three layers:

1. Pure policies:
   chat whitelist checks, TTL expiration, daily-cap suppression, reject cooldown, and price-drift evaluation.
2. Pure presentation:
   approval-card rendering, `/status` rendering, and compact callback encoding that fits Telegram's 64-byte limit.
3. Thin runtime wrapper:
   a grammY bot factory that enforces whitelist middleware, immediate `answerCallbackQuery()`, and injected handlers for approve/reject/status/panic.

## Safety posture

- No real Telegram network calls are made by tests.
- No new code path can place an order.
- Missing Telegram config remains non-fatal for today's smoke path.
- Telegram token stays in Windows Credential Manager, not `.env`.

## Non-goals in this slice

- No live polling/webhook startup in `apps/core`
- No Redis-backed Phase 3 state machine yet
- No actual signal-to-Telegram emission yet
- No operator-side live token requirement

## Files added in this slice

- `packages/shared-schemas/src/telegram.ts`
- `packages/telegram-bot/src/*`
- `docs/plans/2026-04-23-phase-3-telegram-foundation-design.md`

## Files extended in this slice

- `packages/config/src/env.ts`
- `scripts/setup-credentials.ts`
- `scripts/verify-env.ts`
- `packages/shared-schemas/src/index.ts`
