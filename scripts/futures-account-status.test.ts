import { describe, expect, it, vi } from "vitest";
import type { SecretProvider } from "@kr8tiv/secrets";
import type { MexcFuturesAccountSnapshot } from "@kr8tiv/shared-schemas";
import {
  FUTURES_STATUS_MISSING_CREDENTIALS_MESSAGE,
  readFuturesAccountStatus,
} from "./futures-account-status.js";

function secretProvider(hasResult: boolean): SecretProvider {
  return {
    async get() {
      throw new Error("get should not be called in this test");
    },
    async has() {
      return hasResult;
    },
    async set() {
      throw new Error("set should not be called in this test");
    },
    async delete() {
      throw new Error("delete should not be called in this test");
    },
    async list() {
      return [];
    },
  };
}

const snapshot: MexcFuturesAccountSnapshot = {
  usdt: { total: 100, free: 70, used: 30 },
  positions: [
    {
      symbol: "BTCUSDT",
      side: "long",
      contracts: 0.01,
      notionalQuote: 900,
      entryPrice: 90000,
      markPrice: 90100,
      unrealizedPnl: 1,
      leverage: 30,
      liquidationPrice: 87000,
      marginMode: "isolated",
      rawResponse: "{}",
    },
  ],
  fetchedAtMs: 1_713_000_000_000,
};

describe("readFuturesAccountStatus", () => {
  it("returns an actionable missing-credentials response without creating a client", async () => {
    const createClient = vi.fn();

    const status = await readFuturesAccountStatus({
      secrets: secretProvider(false),
      createClient,
    });

    expect(status).toEqual({
      available: false,
      reason: "missing_credentials",
      message: FUTURES_STATUS_MISSING_CREDENTIALS_MESSAGE,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns the authenticated account snapshot when futures credentials exist", async () => {
    const createClient = vi.fn(async () => ({
      fetchAccountSnapshot: vi.fn(async () => snapshot),
    }));

    const status = await readFuturesAccountStatus({
      secrets: secretProvider(true),
      createClient,
    });

    expect(status).toEqual({ available: true, snapshot });
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
