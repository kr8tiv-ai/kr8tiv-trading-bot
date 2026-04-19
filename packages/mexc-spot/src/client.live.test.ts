import { describe, expect, it } from "vitest";
import { MEXCSpotClient } from "./client.js";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";

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
