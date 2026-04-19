import type { Logger } from "pino";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { Redis } from "@kr8tiv/redis-client";
import { env } from "@kr8tiv/config";
import { logger as defaultLogger } from "@kr8tiv/logger";
import {
  WindowsCredentialManagerProvider,
  unsafeReveal,
  type SecretProvider,
} from "@kr8tiv/secrets";
import { createRedis, pingOrThrow } from "@kr8tiv/redis-client";
import { openDatabase } from "@kr8tiv/db";
import { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { MEXCFuturesClient } from "@kr8tiv/mexc-futures";
import type { SecretName } from "@kr8tiv/shared-types";
import {
  applySchema,
  buildApprovalHandler,
  isArmed,
  stalePositionsExist,
  startExecutor,
} from "@kr8tiv/executor";

const REQUIRED_SECRETS: readonly SecretName[] = [
  "mexc-spot-access",
  "mexc-spot-secret",
  "mexc-whitelist-ip",
];

const CLOCK_SKEW_WARN_MS = 3_000;
const IPIFY_TIMEOUT_MS = 2_000;

export interface BootResult {
  redis: Redis;
  db: BetterSqliteDatabase;
  spot: MEXCSpotClient;
  futures: MEXCFuturesClient;
  secrets: SecretProvider;
  /**
   * Call to gracefully stop the executor consumer loop. Idempotent-safe — can
   * be awaited multiple times (second call resolves immediately because the
   * underlying consumerRedis is already disconnected + the loop has exited).
   */
  stopExecutor: () => Promise<void>;
  /**
   * Snapshot of executor:armed at boot time. Informational only — the executor
   * re-reads this on every approval via ensureOrderPossible. Matt inspects
   * this at boot to decide whether to run `pnpm arm` before `pnpm place-order`.
   */
  executorArmed: boolean;
}

export interface BootDependencies {
  /** Override for tests. Default: module-level pino logger. */
  logger?: Logger;
  /** Override for tests. Default: new WindowsCredentialManagerProvider(). */
  secrets?: SecretProvider;
  /** Override for tests. Default: createRedis(). Called TWICE — once for the
   * main Redis handle (Step 5) and once for the dedicated consumerRedis
   * (Step 12, per 02-RESEARCH.md Pitfall 9 — the XREADGROUP BLOCK loop ties
   * up a connection for the entire block window). */
  redisFactory?: () => Redis;
  /** Override for tests. Default: openDatabase(env.SQLITE_PATH). */
  dbFactory?: () => BetterSqliteDatabase;
  /** Override for tests. Default: MEXCSpotClient.create({ secrets }). */
  spotFactory?: (secrets: SecretProvider) => Promise<MEXCSpotClient>;
  /** Override for tests. Default: MEXCFuturesClient.create({ secrets }). */
  futuresFactory?: (secrets: SecretProvider) => Promise<MEXCFuturesClient>;
  /** Override for tests. Default: live fetch to https://api.ipify.org with 2s AbortSignal.timeout. */
  fetchPublicIp?: () => Promise<string>;
  /**
   * Override for tests. Default: the `startExecutor` export from @kr8tiv/executor.
   * Tests inject a fake to avoid spinning up a real Redis Streams consumer loop.
   */
  startExecutorFn?: typeof startExecutor;
  /**
   * Override for tests. Default: the `buildApprovalHandler` export from @kr8tiv/executor.
   * Tests inject a fake to avoid constructing the real handler graph.
   */
  buildApprovalHandlerFn?: typeof buildApprovalHandler;
  /**
   * Override for tests. Default: the `applySchema` export from @kr8tiv/executor.
   * Tests inject a no-op to avoid requiring a real SQLite DDL round-trip.
   */
  applySchemaFn?: typeof applySchema;
  /**
   * Override for tests. Default: the `isArmed` export from @kr8tiv/executor.
   */
  isArmedFn?: typeof isArmed;
  /**
   * Override for tests. Default: the `stalePositionsExist` export from @kr8tiv/executor.
   */
  stalePositionsExistFn?: typeof stalePositionsExist;
}

export class BootError extends Error {
  override readonly name: string = "BootError";
  /** "pre-flight" (exit 1), "mexc" (exit 2), or "stale-state" (exit 3). */
  readonly stage: "pre-flight" | "mexc" | "stale-state";
  constructor(
    message: string,
    stage: "pre-flight" | "mexc" | "stale-state",
  ) {
    super(message);
    this.stage = stage;
  }
}

/**
 * Orchestrates Phase 1 + Phase 2 boot per 01-RESEARCH.md Pattern 4 + 02-RESEARCH.md Example 6.
 *
 * Fails fast. Returns opened handles + executor lifecycle controls on success.
 *
 * Steps 1-9 (Phase 1): logger, env, secrets, pre-flight, Redis, SQLite, MEXC
 * spot client, MEXC futures client, parallel connectivity ping + optional
 * pre-warns (clock skew + IP whitelist).
 *
 * Steps 10-12 (Phase 2):
 *   Step 10: Stale-state refuse-to-start (02-CONTEXT.md D-05). Calls
 *            stalePositionsExist(redis); if true, throws BootError
 *            stage='stale-state' and instructs the operator to run
 *            `pnpm reconcile`.
 *   Step 11: Apply executor SQLite schema (idempotent) + read executor:armed
 *            flag. Logs a warning if unarmed; does NOT throw (the executor's
 *            own risk gate will refuse orders until `pnpm arm` runs).
 *   Step 12: Start the executor Redis Streams consumer loop on a DEDICATED
 *            consumerRedis connection (02-RESEARCH.md Pitfall 9 — a single
 *            shared connection would block GET/SET while XREADGROUP BLOCK
 *            is pending). Returns stopExecutor() for graceful shutdown.
 */
export async function boot(deps: BootDependencies = {}): Promise<BootResult> {
  // Step 1: logger — always first; every subsequent error flows through it
  const log = deps.logger ?? defaultLogger;
  log.info(
    { nodeVersion: process.version, env: env.NODE_ENV },
    "boot starting",
  );

  // Step 2: env is already parsed by the @kr8tiv/config import above.
  // If the Zod schema rejected at import time, we never reached here.

  // Step 3: SecretProvider
  const secrets = deps.secrets ?? new WindowsCredentialManagerProvider();

  // Step 4: Pre-flight — collect ALL missing secrets at once (never one-by-one)
  const presence = await Promise.all(
    REQUIRED_SECRETS.map(async (n) => ({ n, present: await secrets.has(n) })),
  );
  const missing = presence.filter((x) => !x.present).map((x) => x.n);
  if (missing.length > 0) {
    log.fatal(
      { missing },
      "required secrets missing from Windows Credential Manager",
    );
    log.info("Run `pnpm setup:credentials` to provision them.");
    throw new BootError(
      `required secrets missing: ${missing.join(", ")}`,
      "pre-flight",
    );
  }

  // Step 5: Redis (main handle — used by state / risk-manager / ledger, NEVER
  // for the consumer loop; Step 12 creates a second dedicated connection).
  const redisFactory = deps.redisFactory ?? createRedis;
  const redis = redisFactory();
  try {
    await pingOrThrow(redis);
    log.info(
      { url: env.REDIS_URL.replace(/\/\/[^@]*@/, "//***@") },
      "redis connected",
    );
  } catch (err) {
    log.fatal(
      { err },
      "Redis unreachable - is Memurai running? Run `Start-Service Memurai` or `winget install MemuraiDeveloper`",
    );
    throw new BootError(`Redis unreachable: ${String(err)}`, "pre-flight");
  }

  // Step 6: SQLite with WAL + synchronous=FULL + foreign_keys=ON (handled by @kr8tiv/db)
  let db: BetterSqliteDatabase;
  try {
    db = (deps.dbFactory ?? (() => openDatabase(env.SQLITE_PATH)))();
    log.info(
      { path: env.SQLITE_PATH },
      "sqlite opened (WAL, synchronous=FULL, foreign_keys=ON)",
    );
  } catch (err) {
    log.fatal({ err, path: env.SQLITE_PATH }, "sqlite open failed");
    throw new BootError(
      `sqlite open failed at ${env.SQLITE_PATH}: ${String(err)}`,
      "pre-flight",
    );
  }

  // Steps 7 + 8: MEXC clients — parallel construction (no dependency)
  const spotFac =
    deps.spotFactory ??
    ((s: SecretProvider) => MEXCSpotClient.create({ secrets: s }));
  const futuresFac =
    deps.futuresFactory ??
    ((s: SecretProvider) => MEXCFuturesClient.create({ secrets: s }));
  const [spot, futures] = await Promise.all([
    spotFac(secrets),
    futuresFac(secrets),
  ]);

  // Step 9: Parallel smoke — Promise.allSettled so BOTH failures surface
  const pingResults = await Promise.allSettled([spot.ping(), futures.ping()]);
  const [spotResult, futuresResult] = pingResults;

  if (spotResult && spotResult.status === "rejected") {
    log.error(
      { err: spotResult.reason, base: env.MEXC_SPOT_BASE_URL },
      "MEXC spot ping failed",
    );
  } else if (spotResult && spotResult.status === "fulfilled") {
    log.info(
      { serverTime: spotResult.value.serverTime },
      "MEXC spot ping OK",
    );
  }

  if (futuresResult && futuresResult.status === "rejected") {
    log.error(
      { err: futuresResult.reason, base: env.MEXC_FUTURES_BASE_URL },
      "MEXC futures ping failed",
    );
  } else if (futuresResult && futuresResult.status === "fulfilled") {
    log.info(
      { serverTime: futuresResult.value.serverTime },
      "MEXC futures ping OK",
    );
  }

  if (
    (spotResult && spotResult.status === "rejected") ||
    (futuresResult && futuresResult.status === "rejected")
  ) {
    log.fatal("MEXC connectivity smoke test failed");
    throw new BootError("MEXC connectivity smoke test failed", "mexc");
  }

  // Optional pre-warn 1: clock skew (Pitfall 8)
  if (spotResult && spotResult.status === "fulfilled") {
    const delta = Math.abs(spotResult.value.serverTime - Date.now());
    if (delta > CLOCK_SKEW_WARN_MS) {
      log.warn(
        {
          serverTimeMs: spotResult.value.serverTime,
          localMs: Date.now(),
          deltaMs: delta,
        },
        `Local clock is ~${delta}ms off MEXC server time. If this exceeds ${env.MEXC_RECV_WINDOW_MS}ms, requests will fail. Run w32tm /resync in PowerShell.`,
      );
    }
  }

  // Optional pre-warn 2: IP whitelist mismatch (Open Question 3 from 01-RESEARCH.md)
  // Uses unsafeReveal (brand contract — never bare cast) and AbortSignal.timeout
  // so a slow/unreachable ipify cannot block boot indefinitely.
  try {
    const storedIpSecret = await secrets.get("mexc-whitelist-ip");
    const storedIp = unsafeReveal(storedIpSecret).trim();
    const fetchIp =
      deps.fetchPublicIp ??
      (async () => {
        const resp = await fetch("https://api.ipify.org", {
          signal: AbortSignal.timeout(IPIFY_TIMEOUT_MS),
        });
        return (await resp.text()).trim();
      });
    const currentIp = await fetchIp();
    if (storedIp !== currentIp) {
      log.warn(
        {
          storedIp: `${storedIp.slice(0, 4)}***`,
          currentIpLen: currentIp.length,
        },
        "Current public IP does not match the IP stored in mexc-whitelist-ip. MEXC will reject requests unless the key is re-whitelisted or VPN is off.",
      );
    } else {
      log.info("IP whitelist matches current public IP");
    }
  } catch (err) {
    log.warn({ err }, "Could not verify IP whitelist (non-fatal)");
  }

  // ========================================================================
  // Phase 2 additions (Steps 10-12) — boot extension per 02-RESEARCH.md Ex 6
  // ========================================================================

  const stalePositionsExistImpl =
    deps.stalePositionsExistFn ?? stalePositionsExist;
  const isArmedImpl = deps.isArmedFn ?? isArmed;
  const applySchemaImpl = deps.applySchemaFn ?? applySchema;
  const startExecutorImpl = deps.startExecutorFn ?? startExecutor;
  const buildApprovalHandlerImpl =
    deps.buildApprovalHandlerFn ?? buildApprovalHandler;

  // Step 10: Stale-state refuse-to-start (02-CONTEXT.md D-05).
  // The reconciler (scripts/reconcile.ts, Plan 02-04) is the cure.
  if (await stalePositionsExistImpl(redis)) {
    log.fatal(
      { pattern: "executor:positions:* or executor:orders:*" },
      "stale state detected in Redis — run `pnpm reconcile` before starting",
    );
    throw new BootError(
      "stale state detected — run `pnpm reconcile` before starting",
      "stale-state",
    );
  }

  // Step 11: Apply executor SQLite schema (idempotent) + read armed flag.
  // applySchema is a CREATE TABLE IF NOT EXISTS bundle so it's safe to call
  // on every boot even after Plan 02-01 already applied it to the DB.
  applySchemaImpl(db);
  const executorArmed = await isArmedImpl(redis);
  if (!executorArmed) {
    log.warn("executor NOT armed — run `pnpm arm` to enable order placement");
  } else {
    log.info("executor armed");
  }

  // Step 12: Start executor Redis Streams consumer.
  // DEDICATED consumerRedis per 02-RESEARCH.md Pitfall 9 — the XREADGROUP BLOCK
  // 5000 loop ties up the connection for the entire block window; sharing the
  // main `redis` handle would queue every subsequent GET/SET behind it.
  const consumerRedis = redisFactory();
  const handler = buildApprovalHandlerImpl({ spot, redis, db, log });
  let stopExecutor: () => Promise<void>;
  try {
    stopExecutor = await startExecutorImpl(consumerRedis, handler, log);
  } catch (err) {
    log.fatal(
      { err },
      "executor failed to start — Redis Streams unavailable?",
    );
    try {
      consumerRedis.disconnect();
    } catch {
      /* ignore */
    }
    throw new BootError(
      `executor start failed: ${String(err)}`,
      "stale-state",
    );
  }
  log.info("executor listening on approvals.decided");

  log.info("Phase 2 boot complete - all systems ready");

  return {
    redis,
    db,
    spot,
    futures,
    secrets,
    stopExecutor,
    executorArmed,
  };
}
