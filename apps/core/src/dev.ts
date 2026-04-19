// apps/core/src/dev.ts
// Entry point for `pnpm dev`. Runs boot(), keeps handles alive with the
// executor consumer loop running, awaits SIGINT/SIGTERM for clean shutdown.

import { boot, BootError } from "./boot.js";
import { logger } from "@kr8tiv/logger";
import { closeDatabase } from "@kr8tiv/db";

async function main(): Promise<void> {
  let handles: Awaited<ReturnType<typeof boot>> | undefined;

  try {
    handles = await boot();
    logger.info(
      { armed: handles.executorArmed },
      "dev session started - executor listening on approvals.decided — press Ctrl+C to shut down",
    );
  } catch (err) {
    if (err instanceof BootError) {
      logger.fatal({ stage: err.stage, msg: err.message }, "boot failed");
      const exitCode =
        err.stage === "mexc"
          ? 2
          : err.stage === "stale-state"
            ? 3
            : 1;
      process.exit(exitCode);
    }
    logger.fatal({ err }, "boot failed (unexpected error)");
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    if (handles) {
      // Stop executor FIRST — it unblocks the XREADGROUP BLOCK 5000 loop
      // via consumerRedis.disconnect() + awaits loop exit. Without this,
      // SIGINT followed by redis.quit() races the consumer connection.
      try {
        await handles.stopExecutor();
      } catch {
        /* ignore */
      }
      try {
        await handles.redis.quit();
      } catch {
        /* ignore */
      }
      try {
        closeDatabase(handles.db);
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  // Keep the process alive indefinitely — the executor consumer loop is
  // blocked on XREADGROUP, which holds the event loop busy.
}

void main();
