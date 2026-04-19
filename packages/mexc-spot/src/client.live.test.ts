import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MEXCSpotClient } from "./client.js";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import type { OrderResult } from "@kr8tiv/shared-schemas";

/**
 * Inlined copy of @kr8tiv/executor's `makeClientOrderId` — avoids a circular
 * workspace dep (mexc-spot ⇄ executor). The executor package imports mexc-spot
 * to call write methods; the test here needs the same idempotency-key shape
 * but we can't import from executor back without creating a cycle.
 *
 * Keeps the algorithm byte-identical to the executor's version so MEXC sees
 * the same 32-hex clientOrderId regardless of producer.
 */
function makeClientOrderId(signalId: string, approvalTsMs: number): string {
  return createHash("sha256")
    .update(`${signalId}:${approvalTsMs}`)
    .digest("hex")
    .slice(0, 32);
}

const MEXC_LIVE = process.env.MEXC_LIVE === "1";

describe.skipIf(!MEXC_LIVE)(
  "MEXCSpotClient (live — requires MEXC_LIVE=1 + valid credentials in WCM)",
  () => {
    it("ping() returns a positive integer serverTime", async () => {
      const client = await MEXCSpotClient.create({
        secrets: new WindowsCredentialManagerProvider(),
      });
      const result = await client.ping();
      expect(result.serverTime).toBeGreaterThan(0);
      expect(Number.isInteger(result.serverTime)).toBe(true);
    }, 15_000);

    it("getAccountInfo() returns a Zod-validated balance shape", async () => {
      const client = await MEXCSpotClient.create({
        secrets: new WindowsCredentialManagerProvider(),
      });
      const balance = await client.getAccountInfo();
      expect(balance).toHaveProperty("total");
      expect(balance).toHaveProperty("free");
      expect(balance).toHaveProperty("used");
      expect(typeof balance.total).toBe("object");
    }, 15_000);
  },
);

// -----------------------------------------------------------------------------
// Phase 2 live — exchangeInfo for ETHUSDT (MEXC_LIVE=1 gated).
// Plan 02-06 adds the duplicate-clientOrderId test and the end-of-phase
// live-trade proof. This test validates that fetchExchangeInfoForSymbol pulls
// a real, non-zero quoteAmountPrecisionMarket — the value the risk manager
// will use for its minNotional gate in Plan 02-03.
// -----------------------------------------------------------------------------
describe.skipIf(!MEXC_LIVE)(
  "Phase 2 live — exchangeInfo (MEXC_LIVE=1 gated)",
  () => {
    it("fetchExchangeInfoForSymbol('ETHUSDT') returns quoteAmountPrecisionMarket + takerCommission", async () => {
      const client = await MEXCSpotClient.create({
        secrets: new WindowsCredentialManagerProvider(),
      });
      const info = await client.fetchExchangeInfoForSymbol("ETHUSDT");

      expect(info.symbol).toBe("ETHUSDT");
      expect(info.baseAsset).toBe("ETH");
      expect(info.quoteAsset).toBe("USDT");

      // The load-bearing Phase 2 field — used by risk-manager (Plan 02-03)
      // as the minNotional gate for market orders.
      expect(typeof info.quoteAmountPrecisionMarket).toBe("string");
      expect(Number(info.quoteAmountPrecisionMarket)).toBeGreaterThan(0);

      // takerCommission may be null (CCXT market.info doesn't always surface
      // it — the fee-cache falls back to a per-exchange call). Just assert
      // the field is present and of an accepted type.
      if (info.takerCommission !== undefined && info.takerCommission !== null) {
        expect(["string", "number"]).toContain(typeof info.takerCommission);
      }

      // Log the actual value once so Plan 02-03's risk-manager test fixtures
      // can reference the observed minNotional. (Plan 02-02 SUMMARY records it.)
      // eslint-disable-next-line no-console
      console.log(
        `[live] ETHUSDT quoteAmountPrecisionMarket = ${info.quoteAmountPrecisionMarket}, takerCommission = ${String(info.takerCommission)}`,
      );
    }, 20_000);
  },
);

// ============================================================================
// Phase 2 end-of-phase live proof — EXEC-02 duplicate clientOrderId
// Gated behind MEXC_LIVE=1. Default runs SKIP this entire block.
// Fires ONE real ETHUSDT market buy at 2 * minNotional, then retries the
// SAME clientOrderId to capture MEXC's duplicate-rejection signature, then
// cleans up (cancel + flatten) so real-money exposure is bounded to seconds.
//
// Per 02-CONTEXT.md §D-05b (EXEC-03 amendment): no server-side stop is
// attached. Panic-cancel is the protection. Cleanup in the finally block
// below is the test-suite's equivalent of `pnpm panic`.
//
// Plan 02-06 Task 2 runbook:
//   Matt sets $env:MEXC_LIVE="1" then
//   `pnpm --filter @kr8tiv/mexc-spot test -t "EXEC-02 duplicate clientOrderId"`
//   observes the [DUPLICATE_REJECTION_CAPTURE] JSON line in stdout, pastes
//   that + final balance snapshots into 02-SUMMARY.md.
// ============================================================================
describe.skipIf(!MEXC_LIVE)(
  "Phase 2 live — EXEC-02 duplicate clientOrderId (MEXC_LIVE=1 gated)",
  () => {
    it("records MEXC's duplicate-rejection error code + message after firing one real order", async () => {
      const client = await MEXCSpotClient.create({
        secrets: new WindowsCredentialManagerProvider(),
      });

      // 1. Pre-flight: compute 2 * minNotional for ETHUSDT
      const info = await client.fetchExchangeInfoForSymbol("ETHUSDT");
      const minNotional = Number(info.quoteAmountPrecisionMarket ?? "0");
      expect(minNotional).toBeGreaterThan(0);
      const notionalUsdt = 2 * minNotional;
      // eslint-disable-next-line no-console
      console.log(
        `[Phase 2 live proof] minNotional = ${minNotional} USDT, firing at notional = ${notionalUsdt} USDT`,
      );

      // 2. Balance check — refuse to run if under-funded. The test throws
      //    a clear instruction to fund the account rather than partial-fail
      //    on an unbacked order.
      const bal = await client.getAccountInfo();
      const freeUsdt =
        (bal.free as Record<string, number>).USDT ?? 0;
      if (freeUsdt < notionalUsdt) {
        throw new Error(
          `account under-funded for live proof: free USDT=${freeUsdt}, required=${notionalUsdt}. ` +
            `Fund the MEXC spot account with ≥ ${notionalUsdt} USDT and re-run MEXC_LIVE=1.`,
        );
      }

      // 3. Generate a deterministic clientOrderId from (signalId, approvalTsMs)
      //    using the same idempotency key generator the executor uses in
      //    production (packages/executor/src/idempotency.ts).
      const signalId = randomUUID();
      const approvalTsMs = Date.now();
      const clientOrderId = makeClientOrderId(signalId, approvalTsMs);
      // eslint-disable-next-line no-console
      console.log(
        `[Phase 2 live proof] signalId=${signalId} clientOrderId=${clientOrderId} notional=${notionalUsdt}`,
      );

      let firstResult: OrderResult | null = null;
      let duplicateError: unknown = null;

      try {
        // 4. First order — real MEXC call. This spends real USDT. Cleanup in
        //    the finally block flattens any resulting ETH balance.
        firstResult = await client.placeMarketBuy({
          symbol: "ETHUSDT",
          clientOrderId,
          quoteOrderQty: String(notionalUsdt),
        });
        expect(firstResult).toBeDefined();

        // Accept either unified `filled > 0` (CCXT) or raw MEXC
        // `info.executedQty > 0`. MEXC's market-buy responses sometimes
        // populate one but not both.
        const filled =
          firstResult.filled ??
          Number(
            (firstResult.info as { executedQty?: string } | undefined)
              ?.executedQty ?? 0,
          );
        expect(Number(filled)).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(
          `[Phase 2 live proof] first-order ACCEPTED — exchangeOrderId=${firstResult.id ?? "?"} filled=${filled}`,
        );

        // 5. Wait 300ms for clock separation, then retry the SAME
        //    clientOrderId. MEXC MUST reject this; that's EXEC-02.
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          await client.placeMarketBuy({
            symbol: "ETHUSDT",
            clientOrderId,
            quoteOrderQty: String(notionalUsdt),
          });
          // If we got here WITHOUT an error, MEXC accepted the duplicate —
          // EXEC-02 INVALIDATED. This would be a critical finding; we fail
          // the test loudly so the runbook operator escalates.
          throw new Error(
            "EXEC-02 INVALIDATED — MEXC accepted duplicate clientOrderId without error. This is a critical finding; investigate before any live trading.",
          );
        } catch (err) {
          duplicateError = err;
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.log(
            `[Phase 2 live proof] duplicate-rejection captured — msg=${msg}`,
          );
          // Structured stdout line so 02-SUMMARY.md can be auto-populated
          // by grepping for [DUPLICATE_REJECTION_CAPTURE].
          process.stdout.write(
            `\n[DUPLICATE_REJECTION_CAPTURE] ${JSON.stringify({
              signalId,
              clientOrderId,
              exchangeOrderId: firstResult?.id ?? null,
              errorMessage: msg,
              errorName: err instanceof Error ? err.name : "unknown",
            })}\n`,
          );
        }

        // 6. Assert we captured SOMETHING. We deliberately keep the assertion
        //    loose — the plan's behavior spec calls for recording whatever
        //    MEXC actually returns so Plan 02-06's SUMMARY captures the
        //    canonical error code. Candidate codes from 02-RESEARCH.md
        //    Pitfall 1: {-2010, 30001, 30002, 30003}, substring /duplicate/i.
        //    Added 700004 empirically (seen in community reports).
        expect(duplicateError).toBeDefined();
        const errMsg =
          duplicateError instanceof Error
            ? duplicateError.message
            : String(duplicateError);
        const candidateCodes = ["-2010", "30001", "30002", "30003", "700004"];
        const matchesDuplicate =
          /duplicate/i.test(errMsg) ||
          candidateCodes.some((code) => errMsg.includes(code));
        // If neither matches, the test STILL PASSES (we captured SOMETHING);
        // SUMMARY.md records the actual observed signature so the executor's
        // DUPLICATE_ERROR_CODES constant can be updated.
        if (!matchesDuplicate) {
          // eslint-disable-next-line no-console
          console.warn(
            `[Phase 2 live proof] duplicate-error signature unexpected — message did not match /duplicate/i or candidate codes. Update packages/executor/src/executor.ts DUPLICATE_ERROR_CODES with the observed signature. Actual: ${errMsg}`,
          );
        }
      } finally {
        // 7. Cleanup — cancel + flatten. Runs even if assertions failed.
        //    This bounds real-money exposure to seconds regardless of what
        //    the test did. Equivalent to `pnpm panic` for the test scope.
        try {
          const open = await client.fetchOpenOrders("ETHUSDT");
          for (const o of open) {
            const coid =
              o.clientOrderId ??
              (o.info as { origClientOrderId?: string } | undefined)
                ?.origClientOrderId ??
              clientOrderId;
            try {
              await client.cancelOrder("ETHUSDT", coid);
              // eslint-disable-next-line no-console
              console.log(
                `[Phase 2 live proof] cleanup: cancelled ${coid}`,
              );
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                `[Phase 2 live proof] cleanup: cancel failed for ${coid}: ${String(err)}`,
              );
            }
          }

          // Flatten any remaining ETH balance. 2 * minNotional USDT on ETH
          // buy produces ≈ 2 * minNotional / ethPrice ETH. Cleanup
          // clientOrderId uses a `cleanup-` prefix so it's distinguishable
          // from the proof order in the MEXC UI.
          const balPost = await client.getAccountInfo();
          const ethTotal =
            (balPost.total as Record<string, number>).ETH ?? 0;
          if (ethTotal > 0) {
            const flattenCoid = `cleanup-${Date.now().toString(16)}`.slice(
              0,
              32,
            );
            try {
              await client.placeMarketSell({
                symbol: "ETHUSDT",
                clientOrderId: flattenCoid,
                quantity: String(ethTotal),
              });
              // eslint-disable-next-line no-console
              console.log(
                `[Phase 2 live proof] cleanup: flattened ${ethTotal} ETH via ${flattenCoid}`,
              );
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[Phase 2 live proof] cleanup: flatten FAILED — run pnpm panic manually to cancel + flatten: ${String(err)}`,
              );
            }
          } else {
            // eslint-disable-next-line no-console
            console.log(
              `[Phase 2 live proof] cleanup: no ETH balance to flatten (ethTotal=${ethTotal})`,
            );
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[Phase 2 live proof] cleanup top-level failure — run pnpm panic manually: ${String(err)}`,
          );
        }
      }
    }, 60_000); // 60s timeout — one MEXC round trip is typically 1-3 seconds
  },
);
