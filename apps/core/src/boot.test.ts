import { describe, expect, it, vi } from "vitest";
import { boot, BootError, type BootDependencies } from "./boot.js";
import { wrap, type SecretProvider } from "@kr8tiv/secrets";
import type { SecretName, Secret } from "@kr8tiv/shared-types";
import type { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import type { MEXCFuturesClient } from "@kr8tiv/mexc-futures";

function mockSecrets(
  values: Partial<Record<SecretName, string | undefined>> = {},
): SecretProvider {
  const data: Partial<Record<SecretName, string | undefined>> = {
    "mexc-spot-access": "mx0mockaccess1234567890",
    "mexc-spot-secret": "mockmocksecret0123456789abcdef01",
    "mexc-whitelist-ip": "127.0.0.1",
    ...values,
  };
  return {
    async get(name) {
      const v = data[name];
      if (v === undefined) throw new Error(`not set: ${name}`);
      return wrap(v) as Secret<string>;
    },
    async has(name) {
      return data[name] !== undefined;
    },
    async list() {
      return (Object.keys(data) as SecretName[]).filter(
        (k) => data[k] !== undefined,
      );
    },
    async set() {
      /* no-op */
    },
    async delete() {
      /* no-op */
    },
  };
}

function mockRedis(opts: { pingBehavior?: "ok" | "throw" } = {}) {
  const pingBehavior = opts.pingBehavior ?? "ok";
  return {
    ping: vi.fn().mockImplementation(async () => {
      if (pingBehavior === "throw")
        throw new Error("ECONNREFUSED 127.0.0.1:6379");
      return "PONG";
    }),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
    options: { host: "127.0.0.1", port: 6379 },
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  } as any;
}

function mockDb() {
  return {
    pragma: vi.fn().mockReturnValue([]),
    close: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  } as any;
}

function mockSpotClient(
  pingResult: { ok: true; serverTime: number } | { ok: false },
): MEXCSpotClient {
  return {
    ping: vi.fn().mockImplementation(async () => {
      if (!pingResult.ok) throw new Error("spot ping failed (mock)");
      return { serverTime: pingResult.serverTime };
    }),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  } as any;
}

function mockFuturesClient(
  pingResult: { ok: true; serverTime: number } | { ok: false },
): MEXCFuturesClient {
  return {
    ping: vi.fn().mockImplementation(async () => {
      if (!pingResult.ok) throw new Error("futures ping failed (mock)");
      return { serverTime: pingResult.serverTime };
    }),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  } as any;
}

function silentLogger() {
  const methods = ["trace", "debug", "info", "warn", "error", "fatal", "child"];
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const log: any = {};
  for (const m of methods) log[m] = vi.fn();
  log.child = () => log;
  return log;
}

function happyPathDeps(
  overrides: Partial<BootDependencies> = {},
): BootDependencies {
  const now = Date.now();
  return {
    logger: silentLogger(),
    secrets: mockSecrets(),
    redisFactory: () => mockRedis({ pingBehavior: "ok" }),
    dbFactory: () => mockDb(),
    spotFactory: async () =>
      mockSpotClient({ ok: true, serverTime: now }),
    futuresFactory: async () =>
      mockFuturesClient({ ok: true, serverTime: now }),
    fetchPublicIp: async () => "127.0.0.1",
    ...overrides,
  };
}

describe("boot()", () => {
  it("happy path returns all four handles + secrets", async () => {
    const result = await boot(happyPathDeps());
    expect(result.redis).toBeDefined();
    expect(result.db).toBeDefined();
    expect(result.spot).toBeDefined();
    expect(result.futures).toBeDefined();
    expect(result.secrets).toBeDefined();
  });

  it("throws BootError(pre-flight) listing ALL missing secrets when any are absent", async () => {
    const secrets = mockSecrets({
      "mexc-spot-access": undefined,
      "mexc-whitelist-ip": undefined,
    });
    try {
      await boot(happyPathDeps({ secrets }));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).stage).toBe("pre-flight");
      expect((e as Error).message).toContain("mexc-spot-access");
      expect((e as Error).message).toContain("mexc-whitelist-ip");
    }
  });

  it("throws BootError(pre-flight) with 'Redis unreachable' when Redis ping fails", async () => {
    try {
      await boot(
        happyPathDeps({
          redisFactory: () => mockRedis({ pingBehavior: "throw" }),
        }),
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).stage).toBe("pre-flight");
      expect((e as Error).message).toContain("Redis unreachable");
    }
  });

  it("throws BootError(pre-flight) when openDatabase throws", async () => {
    try {
      await boot(
        happyPathDeps({
          dbFactory: () => {
            throw new Error("disk full");
          },
        }),
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).stage).toBe("pre-flight");
      expect((e as Error).message).toContain("sqlite open failed");
    }
  });

  it("throws BootError(mexc) when spot ping fails (but still attempts futures)", async () => {
    const futuresPingSpy = vi.fn().mockResolvedValue({ serverTime: Date.now() });
    const futuresMock = { ping: futuresPingSpy } as unknown as MEXCFuturesClient;
    try {
      await boot(
        happyPathDeps({
          spotFactory: async () => mockSpotClient({ ok: false }),
          futuresFactory: async () => futuresMock,
        }),
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).stage).toBe("mexc");
    }
    expect(futuresPingSpy).toHaveBeenCalled();
  });

  it("throws BootError(mexc) when futures ping fails (spot attempted in parallel)", async () => {
    const spotPingSpy = vi.fn().mockResolvedValue({ serverTime: Date.now() });
    const spotMock = { ping: spotPingSpy } as unknown as MEXCSpotClient;
    try {
      await boot(
        happyPathDeps({
          spotFactory: async () => spotMock,
          futuresFactory: async () => mockFuturesClient({ ok: false }),
        }),
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).stage).toBe("mexc");
    }
    expect(spotPingSpy).toHaveBeenCalled();
  });

  it("logs WARN (not fatal) when clock skew > 3 seconds", async () => {
    const log = silentLogger();
    await boot(
      happyPathDeps({
        logger: log,
        spotFactory: async () =>
          mockSpotClient({ ok: true, serverTime: Date.now() + 5_000 }),
      }),
    );
    expect(log.warn).toHaveBeenCalled();
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls;
    const clockSkewCall = warnCalls.find(
      (c) =>
        typeof c[0] === "object" &&
        c[0] !== null &&
        "deltaMs" in (c[0] as Record<string, unknown>),
    );
    expect(clockSkewCall).toBeDefined();
  });

  it("logs WARN (not fatal) when stored IP whitelist mismatches current public IP", async () => {
    const log = silentLogger();
    await boot(
      happyPathDeps({
        logger: log,
        fetchPublicIp: async () => "8.8.8.8",
      }),
    );
    expect(log.warn).toHaveBeenCalled();
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls;
    const ipMismatchCall = warnCalls.find(
      (c) =>
        typeof c[1] === "string" &&
        (c[1] as string).includes("IP") &&
        (c[1] as string).includes("match"),
    );
    expect(ipMismatchCall).toBeDefined();
  });
});
