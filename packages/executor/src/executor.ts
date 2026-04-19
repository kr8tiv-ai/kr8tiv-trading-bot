import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { Redis } from "@kr8tiv/redis-client";
import type { Logger } from "pino";
import { makeClientOrderId } from "./idempotency.js";
import { writeAcceptedOrRejected, writeSubmitted } from "./ledger.js";
import { ensureOrderPossible, RiskError } from "./risk-manager.js";
import { recordOrder } from "./state.js";
import type { ApprovalDecidedEvent, OrderIntent } from "./types.js";
import { EXECUTOR_CONSUMER_GROUP, STREAMS } from "./types.js";

const STREAM = STREAMS.APPROVALS_DECIDED;
const GROUP = EXECUTOR_CONSUMER_GROUP;

/**
 * Known MEXC error codes that indicate a duplicate clientOrderId rejection.
 * See 02-RESEARCH.md Pitfall 1: MEXC docs are silent on the exact code, but
 * empirically the Binance-lineage code set applies. The end-of-phase D-04 live
 * proof will confirm the exact observed value for this table.
 */
const DUPLICATE_ERROR_CODES = new Set(["-2010", "30001", "30002", "30003"]);

export type ApprovalHandler = (event: ApprovalDecidedEvent) => Promise<void>;

/**
 * Start the executor's Redis Streams consumer. Returns a stop() function for
 * graceful shutdown.
 *
 * The `consumerRedis` client MUST be dedicated to this loop (Pitfall 9) — the
 * XREADGROUP BLOCK ties up the connection for the entire block window.
 *
 * Lifecycle:
 *   1. Idempotent `XGROUP CREATE approvals.decided executor-v1 $ MKSTREAM`.
 *      BUSYGROUP is tolerated; any other error is rethrown.
 *   2. Drain the PEL with `XREADGROUP ... STREAMS approvals.decided 0` —
 *      replays any entries this consumer owned from a previous crash (the
 *      idempotency key ensures MEXC rejects duplicate orders).
 *   3. Main loop: `XREADGROUP ... BLOCK 5000 COUNT 10 STREAMS approvals.decided >`.
 *      Each entry is parsed, filtered (approved=false -> skip), handed to the
 *      injected handler. Handler errors are caught + logged; XACK runs either
 *      way so the stream doesn't back up (02-RESEARCH.md Pattern 4).
 *   4. stop(): sets stopping=true, disconnects the consumer client (unblocks
 *      XREADGROUP immediately), awaits loop exit.
 *
 * EXEC-09 architectural invariant: this function is the ONLY place the executor
 * calls xreadgroup, and it only ever names STREAMS.APPROVALS_DECIDED.
 */
export async function startExecutor(
  consumerRedis: Redis,
  handler: ApprovalHandler,
  log: Logger,
): Promise<() => Promise<void>> {
  const consumerName = `executor-${process.pid}-${Date.now()}`;

  // Idempotent group creation.
  try {
    await consumerRedis.xgroup("CREATE", STREAM, GROUP, "$", "MKSTREAM");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("BUSYGROUP")) throw err;
  }

  let stopping = false;

  // Drain PEL first (crash recovery).
  await drainPendingEntries(consumerRedis, consumerName, handler, log);

  const loop = (async () => {
    while (!stopping) {
      let entries: unknown;
      try {
        entries = await consumerRedis.xreadgroup(
          "GROUP",
          GROUP,
          consumerName,
          "COUNT",
          10,
          "BLOCK",
          5000,
          "STREAMS",
          STREAM,
          ">",
        );
      } catch (err) {
        // disconnect() during shutdown trips an error here — loop exits cleanly.
        if (stopping) break;
        log.error({ err }, "executor: xreadgroup errored — retrying in 1s");
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!entries) continue; // BLOCK timeout

      for (const [, messages] of entries as Array<[string, Array<[string, string[]]>]>) {
        for (const [id, fieldsKV] of messages) {
          const event = parseApprovalDecided(fieldsKV);
          try {
            if (event.approved) {
              await handler(event);
            } else {
              log.info(
                { signalId: event.signalId },
                "executor: ignoring rejected approval",
              );
            }
          } catch (err) {
            // Log + continue; the handler's own ledger writes capture the
            // failure, and the idempotency key protects re-tries. DO NOT throw
            // — an uncaught error kills the loop.
            log.error({ err, id, event }, "executor: handler failed — XACKing anyway");
          }
          try {
            await consumerRedis.xack(STREAM, GROUP, id);
          } catch (err) {
            log.error({ err, id }, "executor: XACK failed");
          }
        }
      }
    }
  })();

  return async () => {
    stopping = true;
    consumerRedis.disconnect();
    await loop;
  };
}

async function drainPendingEntries(
  redis: Redis,
  consumer: string,
  handler: ApprovalHandler,
  log: Logger,
): Promise<void> {
  const entries = await redis.xreadgroup(
    "GROUP",
    GROUP,
    consumer,
    "STREAMS",
    STREAM,
    "0",
  );
  if (!entries) return;
  for (const [, messages] of entries as Array<[string, Array<[string, string[]]>]>) {
    for (const [id, fieldsKV] of messages) {
      const event = parseApprovalDecided(fieldsKV);
      try {
        if (event.approved) await handler(event);
      } catch (err) {
        log.error({ err, id }, "executor: PEL replay handler failed");
      }
      try {
        await redis.xack(STREAM, GROUP, id);
      } catch (err) {
        log.error({ err, id }, "executor: PEL replay XACK failed");
      }
    }
  }
}

/**
 * Parse an XREADGROUP flattened-KV array into a typed event. Redis returns the
 * fields as alternating [key, value, key, value, ...] strings.
 */
export function parseApprovalDecided(fieldsKV: string[]): ApprovalDecidedEvent {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fieldsKV.length; i += 2) {
    const k = fieldsKV[i];
    const v = fieldsKV[i + 1];
    if (k !== undefined && v !== undefined) obj[k] = v;
  }
  const side = obj.side === "sell" ? "sell" : "buy";
  return {
    signalId: obj.signal_id ?? "",
    approved: obj.approved === "true",
    pair: obj.pair ?? "",
    side,
    notionalUsdt: Number(obj.notional_usdt ?? "0"),
    approvalTsMs: Number(obj.approval_ts ?? "0"),
  };
}

/**
 * Compose the canonical approval-handling flow:
 *   makeClientOrderId -> ensureOrderPossible -> writeSubmitted ->
 *   placeMarketBuy -> writeAcceptedOrRejected -> recordOrder.
 *
 * If the risk gate rejects, we log + return without writing a submitted row or
 * calling MEXC (Pitfall 10 flow is "submit BEFORE MEXC call"; if the gate says
 * no, no order is happening).
 *
 * If MEXC rejects with a duplicate-like error code, writeAcceptedOrRejected
 * records a 'rejected' row tagged DUPLICATE_CLIENT_ORDER_ID so the end-of-phase
 * D-04 live proof can assert the idempotency behavior.
 *
 * Phase 2 scope: side='sell' approvals skip without calling MEXC — the test
 * harness only emits side='buy'; real sells enter in Phase 4 exit-signals.
 */
export function buildApprovalHandler(deps: {
  spot: MEXCSpotClient;
  redis: Redis;
  db: BetterSqliteDatabase;
  log: Logger;
}): ApprovalHandler {
  const { spot, redis, db, log } = deps;

  return async (event: ApprovalDecidedEvent): Promise<void> => {
    const clientOrderId = makeClientOrderId(event.signalId, event.approvalTsMs);

    if (event.side === "sell") {
      log.warn(
        { signalId: event.signalId, side: event.side },
        "executor: side=sell not implemented in Phase 2 harness path — skipping",
      );
      return;
    }

    // 1. Risk gate (may throw RiskError)
    try {
      await ensureOrderPossible(spot, redis, db, {
        pair: event.pair,
        side: event.side,
        notionalUsdt: event.notionalUsdt,
      });
    } catch (err) {
      if (err instanceof RiskError) {
        log.warn(
          { signalId: event.signalId, code: err.code, msg: err.message },
          "executor: risk gate rejected",
        );
        return;
      }
      throw err;
    }

    // 2. Submit ledger row (Pitfall 10: write submitted BEFORE MEXC call)
    const intent: OrderIntent = {
      pair: event.pair,
      side: "buy",
      type: "market",
      clientOrderId,
      signalId: event.signalId,
      approvalTsMs: event.approvalTsMs,
      quoteOrderQty: String(event.notionalUsdt),
    };
    writeSubmitted(db, intent);

    // 3. Call MEXC
    try {
      const result = await spot.placeMarketBuy({
        symbol: event.pair,
        clientOrderId,
        quoteOrderQty: String(event.notionalUsdt),
      });
      writeAcceptedOrRejected(db, clientOrderId, result, null);
      await recordOrder(redis, intent, result);
      log.info(
        { signalId: event.signalId, clientOrderId, exchangeOrderId: result.id },
        "executor: order accepted",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDuplicate =
        /duplicate/i.test(msg) ||
        Array.from(DUPLICATE_ERROR_CODES).some((c) => msg.includes(c));
      const reason = isDuplicate
        ? `DUPLICATE_CLIENT_ORDER_ID: ${msg}`
        : `UNKNOWN_ERROR: ${msg}`;
      writeAcceptedOrRejected(db, clientOrderId, null, reason);
      log.error(
        { signalId: event.signalId, clientOrderId, reason },
        "executor: order rejected by MEXC",
      );
      // Do not rethrow — the consumer loop's try/catch would XACK anyway; logging
      // + ledger write here keeps the intent explicit.
    }
  };
}
