// scripts/reconcile.ts
// Run via: pnpm reconcile
//
// Manual boot-time stale-state repair per 02-CONTEXT.md §D-05.
//   1. Pull live truth from MEXC: fetchOpenOrders(ETHUSDT) + getAccountInfo.
//   2. Delete all existing executor:orders:* and executor:positions:* Redis keys.
//   3. Re-populate from MEXC truth (orders hashes + position hash).
//   4. Write executor_state key='reconciled_at' with current ms timestamp.
//
// Phase 5 replaces this CLI with an automated boot-time reconciler plus
// crash-recovery edge cases. Phase 2 ships the minimal happy-path version —
// the operator invokes it manually after a crash, laptop sleep, or before
// `pnpm arm` on a fresh session.
//
// Exit codes:
//   0 = reconcile succeeded — Redis now mirrors MEXC truth
//   1 = MEXC query failed OR Redis/DB error (partial-update note logged)
//
// Routes through @kr8tiv/secrets + @kr8tiv/redis-client + @kr8tiv/db +
// @kr8tiv/mexc-spot + @kr8tiv/logger + @kr8tiv/executor only — NO direct
// ccxt / ioredis / better-sqlite3 imports (Plan 02-03 invariant).

import { closeDatabase, openDatabase } from "@kr8tiv/db";
import {
  ALLOWED_PAIRS,
  applySchema,
  REDIS_KEYS,
} from "@kr8tiv/executor";
import { logger } from "@kr8tiv/logger";
import { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { createRedis, pingOrThrow, type Redis } from "@kr8tiv/redis-client";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";

/**
 * Wipe all executor:orders:* and executor:positions:* keys via SCAN
 * (NOT KEYS — SCAN is cursor-based and non-blocking; matches the
 * stalePositionsExist discipline from Plan 02-03 state.ts).
 *
 * Returns the number of keys deleted across both prefix scans.
 */
async function clearStaleState(
  redis: Redis,
  logCtx: Pick<typeof logger, "info">,
): Promise<number> {
  let deleted = 0;
  for (const pattern of [
    `${REDIS_KEYS.ORDER_PREFIX}*`,
    `${REDIS_KEYS.POSITION_PREFIX}*`,
  ]) {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    await new Promise<void>((resolve, reject) => {
      stream.on("data", async (keys: string[]) => {
        if (keys.length === 0) return;
        try {
          stream.pause();
          const n = await redis.del(...keys);
          deleted += n;
          stream.resume();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      stream.on("end", () => resolve());
      stream.on("error", (err) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    });
  }
  logCtx.info({ deleted }, "reconcile: wiped stale Redis keys");
  return deleted;
}

interface ReconcileReport {
  openOrdersByPair: Record<string, number>;
  balances: Record<string, number>;
  deletedStaleKeys: number;
  reconciledAtMs: number;
}

async function main(): Promise<void> {
  const log = logger.child({ cmd: "reconcile" });
  log.info("reconcile: starting");

  const secrets = new WindowsCredentialManagerProvider();
  const redis = createRedis();
  const db = openDatabase();
  // Definite-assignment assertion — see matching comment in scripts/panic.ts.
  // The bootstrap try/catch either assigns `spot` or exits 1 (never-returning),
  // so the subsequent main try block always sees an initialized value.
  let spot!: MEXCSpotClient;

  try {
    await pingOrThrow(redis);
    applySchema(db);
    spot = await MEXCSpotClient.create({ secrets });
  } catch (err) {
    log.fatal({ err }, "reconcile: bootstrap failed");
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

  const report: ReconcileReport = {
    openOrdersByPair: {},
    balances: {},
    deletedStaleKeys: 0,
    reconciledAtMs: 0,
  };

  try {
    // 1. Wipe stale state FIRST — fresher state is safer than partial overwrites.
    report.deletedStaleKeys = await clearStaleState(redis, log);

    // 2. For each whitelisted pair (Phase 2 = ETHUSDT only; Phase 6 expands),
    //    pull open orders from MEXC and rehydrate Redis.
    for (const pair of ALLOWED_PAIRS) {
      const open = await spot.fetchOpenOrders(pair);
      report.openOrdersByPair[pair] = open.length;

      for (const order of open) {
        // MEXC returns origClientOrderId in the raw info; CCXT's unified
        // clientOrderId should match on Plan 02-02 orders that set
        // newClientOrderId, but fall back to info.origClientOrderId or the
        // exchange orderId to guarantee a non-empty key suffix.
        const info = order.info as { origClientOrderId?: string } | undefined;
        const coid =
          order.clientOrderId ??
          info?.origClientOrderId ??
          order.id ??
          "unknown";
        const key = `${REDIS_KEYS.ORDER_PREFIX}${coid}`;
        await redis.hset(key, {
          pair,
          side: order.side,
          status: String(order.status ?? "open"),
          exchangeOrderId: String(order.id ?? ""),
          reconstructed: "true",
        });
        // 48h TTL matches recordOrder from state.ts — long enough for
        // overnight-crash recovery, bounded to prevent key leakage.
        await redis.expire(key, 48 * 60 * 60);
      }

      log.info({ pair, count: open.length }, "reconcile: hydrated open orders");
    }

    // 3. Pull balances — base + quote assets for Phase 2 (ETH + USDT).
    const bal = await spot.getAccountInfo();
    const totals = bal.total as Record<string, number>;
    report.balances = {
      USDT: totals.USDT ?? 0,
      ETH: totals.ETH ?? 0,
    };

    // 4. Write position hash for any non-zero ETH balance. Phase 2 only tracks
    //    the ETHUSDT position; futures / other spot pairs enter Phase 6+.
    const ethQty = totals.ETH ?? 0;
    if (ethQty > 0) {
      const posKey = `${REDIS_KEYS.POSITION_PREFIX}ETHUSDT`;
      await redis.hset(posKey, {
        qty: String(ethQty),
        updatedAt: String(Date.now()),
        source: "reconcile",
      });
      log.info({ pair: "ETHUSDT", qty: ethQty }, "reconcile: hydrated position");
    }

    // 5. Stamp reconciled_at in SQLite so boot.ts (Plan 02-05) can assert a
    //    fresh reconciliation preceded the current session if desired.
    report.reconciledAtMs = Date.now();
    db.prepare(
      "INSERT OR REPLACE INTO executor_state (key, value, updated_at_ms) VALUES (?, ?, ?)",
    ).run("reconciled_at", String(report.reconciledAtMs), report.reconciledAtMs);

    log.info({ report }, "reconcile: complete");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    log.fatal(
      { err },
      "reconcile: FAILED — Redis state may be partially updated. Inspect manually before next arm.",
    );
    process.stdout.write(
      `${JSON.stringify({ ...report, error: String(err) }, null, 2)}\n`,
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
  process.stderr.write(`reconcile CLI failed unexpectedly: ${String(err)}\n`);
  process.exit(1);
});
