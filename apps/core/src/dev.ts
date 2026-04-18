// apps/core/src/dev.ts
// Entry point for `pnpm dev`. Runs boot(), keeps handles alive,
// awaits SIGINT/SIGTERM for clean shutdown.

import { boot, BootError } from "./boot.js";
import { logger } from "@kr8tiv/logger";
import { closeDatabase } from "@kr8tiv/db";

async function main(): Promise<void> {
  let handles: Awaited<ReturnType<typeof boot>> | undefined;

  try {
    handles = await boot();
    logger.info("dev session started - press Ctrl+C to shut down");
  } catch (err) {
    if (err instanceof BootError) {
      logger.fatal({ stage: err.stage, msg: err.message }, "boot failed");
      process.exit(err.stage === "mexc" ? 2 : 1);
    }
    logger.fatal({ err }, "boot failed (unexpected error)");
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    if (handles) {
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

  // Keep the process alive indefinitely — Phase 2+ supervisors replace this.
}

void main();
