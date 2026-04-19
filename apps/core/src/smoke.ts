// apps/core/src/smoke.ts
// Entry point for `pnpm smoke`. Runs the full boot sequence, logs success,
// cleanly stops the executor consumer loop + closes handles, exits with a
// typed code:
//   0 = success
//   1 = pre-flight failure (missing secrets, Redis unreachable, SQLite open)
//   2 = MEXC connectivity failure (spot or futures ping)
//   3 = stale-state failure (executor:positions:* / executor:orders:* non-empty;
//       run `pnpm reconcile`)

import { boot, BootError } from "./boot.js";
import { logger } from "@kr8tiv/logger";
import { closeDatabase } from "@kr8tiv/db";

async function main(): Promise<void> {
  try {
    const { redis, db, stopExecutor } = await boot();
    logger.info("smoke test passed");
    try {
      await stopExecutor();
    } catch {
      /* ignore */
    }
    try {
      await redis.quit();
    } catch {
      /* ignore */
    }
    try {
      closeDatabase(db);
    } catch {
      /* ignore */
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof BootError) {
      logger.fatal(
        { stage: err.stage, msg: err.message },
        "smoke test failed",
      );
      const exitCode =
        err.stage === "mexc"
          ? 2
          : err.stage === "stale-state"
            ? 3
            : 1;
      process.exit(exitCode);
    }
    logger.fatal({ err }, "smoke test failed (unexpected error)");
    process.exit(1);
  }
}

void main();
