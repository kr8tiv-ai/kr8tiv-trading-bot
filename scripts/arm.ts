// scripts/arm.ts
// Run via: pnpm arm
//
// Re-arm the executor after a panic (or for the first time at Phase 2 kickoff).
// Writes executor:armed='true' to Redis AND persists to SQLite executor_state
// as a durability backstop per 02-CONTEXT.md §D-02 + §D-05.
//
// Refuses to arm if stale state exists — operator must run `pnpm reconcile`
// first. "Fail closed, require explicit human action" per the kill-switch
// design. Exit codes match the panic CLI conventions:
//   0 = armed successfully
//   1 = stale state present OR Redis/DB error (refusing to arm)
//
// Routes through @kr8tiv/redis-client + @kr8tiv/db + @kr8tiv/executor +
// @kr8tiv/logger only — NO direct ioredis / better-sqlite3 imports.

import { createRedis, pingOrThrow } from "@kr8tiv/redis-client";
import { closeDatabase, openDatabase } from "@kr8tiv/db";
import { logger } from "@kr8tiv/logger";
import {
  applySchema,
  REDIS_KEYS,
  setArmed,
  stalePositionsExist,
} from "@kr8tiv/executor";

async function main(): Promise<void> {
  const log = logger.child({ cmd: "arm" });
  const redis = createRedis();
  const db = openDatabase();

  try {
    // 1. Ensure Redis reachable (fail-closed if not).
    await pingOrThrow(redis);

    // 2. Ensure schema applied (idempotent — safe on every arm).
    applySchema(db);

    // 3. Stale-state safety check — refuse to arm if stale positions/orders
    //    are sitting in Redis. Operator MUST run `pnpm reconcile` first so
    //    Redis mirrors MEXC truth before trading resumes.
    const stale = await stalePositionsExist(redis);
    if (stale) {
      log.error(
        "refusing to arm: stale state detected in Redis (executor:positions:* or executor:orders:* keys present). Run `pnpm reconcile` first.",
      );
      process.stderr.write(
        "REFUSED: stale Redis state detected. Run `pnpm reconcile` first, then re-run `pnpm arm`.\n",
      );
      process.exit(1);
    }

    // 4. Write armed=true to Redis (primary source of truth).
    await setArmed(redis, true);

    // 5. Persist to SQLite executor_state (durability backstop — survives
    //    Redis eviction / crash per EXEC-08). The key is the REDIS_KEYS.ARMED
    //    constant stripped of its `executor:` prefix so the SQLite row name
    //    matches Plan 02-03's panic.ts + boot.ts pattern.
    db.prepare(
      "INSERT OR REPLACE INTO executor_state (key, value, updated_at_ms) VALUES (?, ?, ?)",
    ).run(
      REDIS_KEYS.ARMED.replace("executor:", ""),
      "true",
      Date.now(),
    );

    log.info({ redisKey: REDIS_KEYS.ARMED }, "executor armed");
    process.stdout.write(
      "Executor ARMED. Next approved signal will fire a real order if MEXC_LIVE=1.\n",
    );
    process.exit(0);
  } catch (err) {
    log.fatal({ err }, "arm failed");
    process.exit(1);
  } finally {
    try {
      redis.disconnect();
    } catch {
      /* ignore */
    }
    try {
      closeDatabase(db);
    } catch {
      /* ignore */
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`arm CLI failed unexpectedly: ${String(err)}\n`);
  process.exit(1);
});
