import { describe, expect, it } from "vitest";
import { MEXCSpotClient } from "./client.js";
import { wrap, type SecretProvider } from "@kr8tiv/secrets";
import type { SecretName, Secret } from "@kr8tiv/shared-types";

// Mock SecretProvider — returns deterministic branded values
function mockProvider(overrides: Partial<Record<SecretName, string>> = {}): SecretProvider {
  const values: Partial<Record<SecretName, string>> = {
    "mexc-spot-access": "mx0mockaccess1234567890",
    "mexc-spot-secret": "mockmocksecret0123456789abcdef01",
    "mexc-whitelist-ip": "127.0.0.1",
    ...overrides,
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

describe("MEXCSpotClient.create (unit)", () => {
  it("constructs a CCXT mexc instance with options.defaultType = 'spot'", async () => {
    const client = await MEXCSpotClient.create({ secrets: mockProvider() });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.defaultType).toBe("spot");
  });

  it("reads mexc-spot-access and mexc-spot-secret from the SecretProvider", async () => {
    const client = await MEXCSpotClient.create({ secrets: mockProvider() });
    expect(client.exchange.apiKey).toBe("mx0mockaccess1234567890");
    expect(client.exchange.secret).toBe("mockmocksecret0123456789abcdef01");
  });

  it("uses baseUrl override when provided", async () => {
    const client = await MEXCSpotClient.create({
      secrets: mockProvider(),
      baseUrl: "https://test.example.com",
    });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    const urls = (client.exchange as any).urls.api;
    expect(urls.spot).toBe("https://test.example.com");
  });

  it("uses recvWindowMs override when provided", async () => {
    const client = await MEXCSpotClient.create({
      secrets: mockProvider(),
      recvWindowMs: 3000,
    });
    // biome-ignore lint/suspicious/noExplicitAny: probing CCXT internals
    expect((client.exchange as any).options.recvWindow).toBe(3000);
  });

  it("does NOT expose placeOrder, createOrder, or cancelOrder on the MEXCSpotClient wrapper", () => {
    const proto = Object.getPrototypeOf(MEXCSpotClient.prototype);
    const wrapperMethods = [
      ...Object.getOwnPropertyNames(MEXCSpotClient.prototype),
      ...Object.getOwnPropertyNames(proto),
    ];
    expect(wrapperMethods).not.toContain("placeOrder");
    expect(wrapperMethods).not.toContain("createOrder");
    expect(wrapperMethods).not.toContain("cancelOrder");
  });
});
