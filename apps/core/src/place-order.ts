// apps/core/src/place-order.ts
// Run via: pnpm place-order --side buy --notional 5
//
// CLI test harness for the Phase 2 Redis Streams pipeline per 02-CONTEXT.md D-01.
// Synthesizes a full signal+approval chain end-to-end:
//
//   signals.candidate  (Phase 4 ML origin — stubbed here)
//     -> signals.filtered  (Phase 7 news-veto layer — stubbed as 'pass')
//       -> approvals.pending  (Phase 3 Telegram prompt — stubbed here)
//         -> approvals.decided  (executor's only subscription — EXEC-09)
//
// The executor (started at boot Step 12) consumes approvals.decided via
// XREADGROUP and fires the order — gated by its own risk manager (EXEC-01..06)
// and by the executor:armed=true flag (EXEC-07). A real MEXC call happens ONLY
// if the executor process is running + armed; default test runs without an
// executor process just populate the streams (useful for pipeline integration
// tests).
//
// For the Plan 02-06 live proof, Matt will:
//   1. `pnpm arm` (setArmed=true via scripts/arm.ts)
//   2. `pnpm dev` (starts boot + executor consumer in a session)
//   3. `MEXC_LIVE=1 pnpm place-order --side buy --notional <2*minNotional>`
//   4. Observe MEXC order via `pnpm place-order` output + MEXC web UI
//   5. `pnpm panic` to cancel+flatten (scripts/panic.ts)
//
// Exit codes:
//   0 = all 4 stream entries emitted
//   1 = Redis error or bad CLI args
//
// Invariants preserved:
//   - No direct ccxt / ioredis / better-sqlite3 imports — routes through
//     @kr8tiv/redis-client and @kr8tiv/executor only.
//   - MAXLEN ~ 1000 on every XADD per 02-RESEARCH.md Pitfall 4 (unbounded
//     PEL growth mitigation).
//   - Uses STREAMS constants from @kr8tiv/executor (not hardcoded strings)
//     so a stream rename in types.ts flows through without a text edit here.

import { randomUUID } from "node:crypto";
import { createRedis } from "@kr8tiv/redis-client";
import { logger } from "@kr8tiv/logger";
import { STREAMS } from "@kr8tiv/executor";

export interface PlaceOrderArgs {
  readonly side: "buy" | "sell";
  readonly notional: number;
}

/**
 * Parse argv for the --side + --notional flags. Exported for unit testing.
 *
 * Throws a descriptive Error on missing / invalid input; main() translates
 * that into an exit-1 with usage hint.
 */
export function parseArgs(argv: readonly string[]): PlaceOrderArgs {
  let side: "buy" | "sell" | undefined;
  let notional: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    const next = argv[i + 1];
    if (cur === "--side" && next !== undefined) {
      if (next === "buy" || next === "sell") {
        side = next;
      } else {
        throw new Error(`--side must be 'buy' or 'sell', got '${next}'`);
      }
      i++;
    } else if (cur === "--notional" && next !== undefined) {
      const v = Number(next);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`--notional must be positive number, got '${next}'`);
      }
      notional = v;
      i++;
    }
  }
  if (side === undefined) {
    throw new Error("missing required arg: --side buy|sell");
  }
  if (notional === undefined) {
    throw new Error("missing required arg: --notional <usdt>");
  }
  return { side, notional };
}

export interface PipelineEmitResult {
  readonly signalId: string;
  readonly approvalTsMs: number;
  readonly streamIds: {
    readonly candidate: string;
    readonly filtered: string;
    readonly pending: string;
    readonly decided: string;
  };
}

/**
 * Minimal structural interface for the one Redis command place-order needs.
 * Exported-typed so tests can inject a simple `{ xadd: vi.fn() }` without
 * needing a full @kr8tiv/redis-client Redis instance.
 *
 * Matches ioredis's xadd signature — alternating string args, resolves to the
 * stream entry ID like `"1712345678-0"`.
 */
export type XAddableRedis = {
  xadd: (...args: string[]) => Promise<string>;
};

/**
 * Emit the 4-stage pipeline. Exported for unit testing (the CLI `main()`
 * wraps this with createRedis() + logger + exit-code handling).
 *
 * Each stage uses MAXLEN ~ 1000 per 02-RESEARCH.md Pitfall 4 so the streams
 * never grow unbounded. The same signalId (randomUUID) propagates across all
 * 4 stages — Phase 4 (ML origin) and Phase 3 (Telegram approval) will preserve
 * this shape but replace the origin + approval-decided producers.
 *
 * Timestamps are synthesized in-order (now, now+1, now+2, now+3) so the
 * stream entries arrive in the pipeline ordering even when the XADDs execute
 * within the same millisecond.
 */
export async function runPipeline(
  redis: XAddableRedis,
  args: PlaceOrderArgs,
): Promise<PipelineEmitResult> {
  const signalId = randomUUID();
  const now = Date.now();
  const approvalTs = now + 3;

  // Stage 1: signals.candidate — origin layer (Phase 4 ML replaces).
  const candidate = await redis.xadd(
    STREAMS.SIGNALS_CANDIDATE,
    "MAXLEN",
    "~",
    "1000",
    "*",
    "signal_id",
    signalId,
    "pair",
    "ETHUSDT",
    "side",
    args.side,
    "notional_usdt",
    String(args.notional),
    "source",
    "test-harness",
    "ts",
    String(now),
  );

  // Stage 2: signals.filtered — news-veto layer (Phase 7 replaces).
  const filtered = await redis.xadd(
    STREAMS.SIGNALS_FILTERED,
    "MAXLEN",
    "~",
    "1000",
    "*",
    "signal_id",
    signalId,
    "filter_result",
    "pass",
    "ts",
    String(now + 1),
  );

  // Stage 3: approvals.pending — approval prompt (Phase 3 Telegram consumes).
  const pending = await redis.xadd(
    STREAMS.APPROVALS_PENDING,
    "MAXLEN",
    "~",
    "1000",
    "*",
    "signal_id",
    signalId,
    "approval_timeout_ms",
    "90000",
    "ts",
    String(now + 2),
  );

  // Stage 4: approvals.decided — executor's sole subscription (EXEC-09).
  const decided = await redis.xadd(
    STREAMS.APPROVALS_DECIDED,
    "MAXLEN",
    "~",
    "1000",
    "*",
    "signal_id",
    signalId,
    "approved",
    "true",
    "pair",
    "ETHUSDT",
    "side",
    args.side,
    "notional_usdt",
    String(args.notional),
    "approval_ts",
    String(approvalTs),
  );

  return {
    signalId,
    approvalTsMs: approvalTs,
    streamIds: { candidate, filtered, pending, decided },
  };
}

async function main(): Promise<void> {
  const log = logger.child({ cmd: "place-order" });
  let args: PlaceOrderArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `${String(err)}\n\nUsage: pnpm place-order --side buy|sell --notional <usdt>\n`,
    );
    process.exit(1);
  }

  const redis = createRedis();
  try {
    // ioredis Redis type has an overloaded xadd signature; our XAddableRedis
    // minimal shape matches the string-args variant. Cast narrows the signature.
    const result = await runPipeline(
      redis as unknown as XAddableRedis,
      args,
    );
    log.info(
      result,
      "pipeline emitted — executor fires if running + armed + MEXC_LIVE=1",
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (err) {
    log.fatal({ err }, "place-order: pipeline emit failed");
    process.exit(1);
  } finally {
    try {
      redis.disconnect();
    } catch {
      /* ignore */
    }
  }
}

// Invoke main() only when tsx runs this file directly (not when vitest
// imports it as a module for testing). The path compare accommodates
// Windows/Unix + .ts/.js suffixes.
const invokedPath = process.argv[1] ?? "";
const normalized = invokedPath.replace(/\\/g, "/");
if (
  normalized.endsWith("place-order.ts") ||
  normalized.endsWith("place-order.js")
) {
  void main();
}
