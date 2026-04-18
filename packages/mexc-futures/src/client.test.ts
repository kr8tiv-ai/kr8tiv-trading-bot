import { describe, expect, it } from "vitest";
import { MEXCFuturesClient } from "./client.js";
import { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { wrap, type SecretProvider } from "@kr8tiv/secrets";
import type { SecretName, Secret } from "@kr8tiv/shared-types";

function mockProvider(has: Partial<Record<SecretName, string>> = {}): SecretProvider {
  const values: Partial<Record<SecretName, string>> = {
    "mexc-spot-access": "mx0mockaccess1234567890",
    "mexc-spot-secret": "mockmocksecret0123456789abcdef01",
    "mexc-whitelist-ip": "127.0.0.1",
    ...has,
  };
  return {
    async get(name) {
      const v = values[name];
      if (v === undefined) throw new Error(`not set: ${name}`);
      return wrap(v) as Secret<string>;
    },
    async has(name) {
      return values[name] !== undefined;
    },
    async list() {
      return Object.keys(values) as SecretName[];
    },
    async set() {
      /* no-op */
    },
    async delete() {
      /* no-op */
    },
  };
}

describe("MEXCFuturesClient.create (unit)", () => {
  it("constructs successfully WITHOUT futures credentials (Phase 1 parity)", async () => {
    // mexc-futures-access / mexc-futures-secret are NOT in the mock
    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    expect(client.exchange.apiKey).toBe("");
    expect(client.exchange.secret).toBe("");
  });

  it("sets options.defaultType = 'swap'", async () => {
    const client = await MEXCFuturesClient.create({ secrets: mockProvider() });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.defaultType).toBe("swap");
  });

  it("uses baseUrl override when provided", async () => {
    const client = await MEXCFuturesClient.create({
      secrets: mockProvider(),
      baseUrl: "https://test-futures.example.com",
    });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    const urls = (client.exchange as any).urls.api;
    expect(urls.swap).toBe("https://test-futures.example.com");
  });

  it("uses futures credentials when present", async () => {
    const client = await MEXCFuturesClient.create({
      secrets: mockProvider({
        "mexc-futures-access": "mx0futuresaccess1234567890",
        "mexc-futures-secret": "futuressecret0123456789abcdef01",
      }),
    });
    expect(client.exchange.apiKey).toBe("mx0futuresaccess1234567890");
    expect(client.exchange.secret).toBe("futuressecret0123456789abcdef01");
  });

  it("MEXCFuturesClient and MEXCSpotClient construct DIFFERENT CCXT instances (separate rate buckets)", async () => {
    const provider = mockProvider();
    const spot = await MEXCSpotClient.create({ secrets: provider });
    const futures = await MEXCFuturesClient.create({ secrets: provider });
    expect(spot.exchange).not.toBe(futures.exchange);
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((spot.exchange as any).options.defaultType).toBe("spot");
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((futures.exchange as any).options.defaultType).toBe("swap");
  });

  it("does NOT expose write-path methods on the wrapper", () => {
    const names = Object.getOwnPropertyNames(MEXCFuturesClient.prototype);
    expect(names).not.toContain("placeOrder");
    expect(names).not.toContain("createOrder");
    expect(names).not.toContain("cancelOrder");
  });
});
