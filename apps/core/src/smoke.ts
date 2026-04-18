// apps/core/src/smoke.ts
// Entry point for `pnpm smoke`. Runs the full boot sequence, logs success,
// cleanly closes handles, exits 0 / 1 / 2 depending on failure type.

import { boot, BootError } from "./boot.js";
import { logger } from "@kr8tiv/logger";
import { closeDatabase } from "@kr8tiv/db";

async function main(): Promise<void> {
  try {
    const { redis, db } = await boot();
    logger.info("smoke test passed");
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
      process.exit(err.stage === "mexc" ? 2 : 1);
    }
    logger.fatal({ err }, "smoke test failed (unexpected error)");
    process.exit(1);
  }
}

void main();
