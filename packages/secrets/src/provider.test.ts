import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WindowsCredentialManagerProvider } from "./provider.js";
import { SecretNotFoundError } from "./errors.js";
import { unsafeReveal, wrap } from "./secret.js";
import type { SecretName } from "@kr8tiv/shared-types";

const TEST_PREFIX = "kr8tiv-mexc-bot-test";
const TEST_SECRETS: SecretName[] = [
  "mexc-spot-access",
  "mexc-spot-secret",
  "mexc-whitelist-ip",
];

describe("Secret brand helpers", () => {
  it("wrap + unsafeReveal round-trips the raw value", () => {
    const s = wrap("hello");
    expect(unsafeReveal(s)).toBe("hello");
  });
});

describe("WindowsCredentialManagerProvider (round-trip)", () => {
  const provider = new WindowsCredentialManagerProvider({ servicePrefix: TEST_PREFIX });

  beforeEach(async () => {
    for (const n of TEST_SECRETS) {
      try {
        await provider.delete(n);
      } catch {
        // may not exist — fine
      }
    }
  });

  afterEach(async () => {
    for (const n of TEST_SECRETS) {
      try {
        await provider.delete(n);
      } catch {
        // fine
      }
    }
  });

  it("get() throws SecretNotFoundError for missing name", async () => {
    await expect(provider.get("mexc-spot-access")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("has() returns false for missing, true after set, false after delete", async () => {
    expect(await provider.has("mexc-spot-access")).toBe(false);
    await provider.set("mexc-spot-access", "testvalue123");
    expect(await provider.has("mexc-spot-access")).toBe(true);
    await provider.delete("mexc-spot-access");
    expect(await provider.has("mexc-spot-access")).toBe(false);
  });

  it("set() + get() round-trips the value through Windows Credential Manager", async () => {
    const raw = "round-trip-test-" + Math.random().toString(36).slice(2);
    await provider.set("mexc-spot-secret", raw);
    const retrieved = await provider.get("mexc-spot-secret");
    expect(unsafeReveal(retrieved)).toBe(raw);
  });

  it("list() returns only currently-present secrets", async () => {
    await provider.set("mexc-spot-access", "a");
    await provider.set("mexc-whitelist-ip", "127.0.0.1");
    const present = await provider.list();
    expect(present.sort()).toEqual(["mexc-spot-access", "mexc-whitelist-ip"].sort());
  });

  it("SecretNotFoundError carries the requested SecretName", async () => {
    try {
      await provider.get("telegram-bot-token");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretNotFoundError);
      expect((e as SecretNotFoundError).secretName).toBe("telegram-bot-token");
    }
  });
});
