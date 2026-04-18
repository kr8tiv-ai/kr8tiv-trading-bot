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
