// scripts/panic.ts
// Run via: pnpm panic
//
// PANIC kill-switch CLI per EXEC-07 + 02-CONTEXT.md §D-02.
// Cancels all open orders on ETHUSDT, flattens any open ETH position, and
// writes executor:armed=false to freeze the executor. Idempotent — re-running
// when already-frozen + nothing open is a no-op that still returns exit 0.
//
// Routes exclusively through workspace packages — NO direct ccxt / ioredis /
// better-sqlite3 imports here (preserves Plan 02-03's invariants).
//
// Exit codes:
//   0 = panic sequence completed (even with partial flatten — details in report.errors)
//   1 = catastrophic failure (could not set armed=false; manual intervention required)

import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import { createRedis } from "@kr8tiv/redis-client";
import { openDatabase, closeDatabase } from "@kr8tiv/db";
import { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { logger } from "@kr8tiv/logger";
import { panic } from "@kr8tiv/executor";

async function main(): Promise<void> {
  const log = logger.child({ cmd: "panic" });
  log.warn(
    "PANIC triggered — cancelling all orders, flattening position, freezing executor",
  );

  const secrets = new WindowsCredentialManagerProvider();
  const redis = createRedis();
  const db = openDatabase();
  // Definite-assignment assertion: the catch block calls process.exit(1) which
  // returns `never`, so `spot` is unambiguously initialized on every code path
  // that reaches the next try. TS 5.7's narrowing does follow `never` but the
  // `!` makes it explicit — keeps the file readable without leaning on the
  // type-checker's control-flow analysis.
  let spot!: MEXCSpotClient;
  try {
    spot = await MEXCSpotClient.create({ secrets });
  } catch (err) {
    log.fatal({ err }, "PANIC: failed to construct MEXC spot client");
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
    process.exit(1);
  }

  try {
    const report = await panic(spot, redis, db, log);
    log.warn({ report }, "PANIC complete");
    // Print the report as JSON to stdout for operator + test-harness inspection.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    // If setArmed failed catastrophically, exit 1 — Matt needs to act manually.
    if (!report.frozen) {
      log.fatal(
        "PANIC: armed=false was NOT persisted — manual intervention required",
      );
      process.exit(1);
    }
    // Partial-flatten + cancel-error cases are recorded in report.errors but
    // still exit 0 — operator can re-run pnpm panic (it's idempotent).
    process.exit(0);
  } catch (err) {
    log.fatal(
      { err },
      "PANIC failed unexpectedly — manual intervention may be required on MEXC UI",
    );
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
  // Top-level safety net — logger may not be initialized if imports failed.
  process.stderr.write(`panic CLI failed unexpectedly: ${String(err)}\n`);
  process.exit(1);
});
