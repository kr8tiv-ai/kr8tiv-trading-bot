import { describe, expect, it } from "vitest";
import { MEXCFuturesClient } from "./client.js";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";

const MEXC_LIVE = process.env.MEXC_LIVE === "1";

describe.skipIf(!MEXC_LIVE)(
  "MEXCFuturesClient (live — requires MEXC_LIVE=1)",
  () => {
    it("ping() against real contract.mexc.com returns a positive integer serverTime (PUBLIC, no auth needed)", async () => {
      // Note: futures credentials don't need to be provisioned — ping is public.
      const client = await MEXCFuturesClient.create({
        secrets: new WindowsCredentialManagerProvider(),
      });
      const result = await client.ping();
      expect(result.serverTime).toBeGreaterThan(0);
      expect(Number.isInteger(result.serverTime)).toBe(true);
    }, 15_000);
  },
);
