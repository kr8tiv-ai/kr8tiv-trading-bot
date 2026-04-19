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

function mockRedis(opts: {
  pingBehavior?: "ok" | "throw";
  armed?: string | null;
} = {}) {
  const pingBehavior = opts.pingBehavior ?? "ok";
  const armedValue = opts.armed ?? null;
  return {
    ping: vi.fn().mockImplementation(async () => {
      if (pingBehavior === "throw")
        throw new Error("ECONNREFUSED 127.0.0.1:6379");
      return "PONG";
    }),
    get: vi.fn().mockImplementation(async (k: string) => {
      if (k === "executor:armed") return armedValue;
      return null;
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
    exec: vi.fn(),
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
    }),
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

/**
 * Phase 2 deps — inject fake executor primitives so tests don't need to spin
 * up a real Redis Streams consumer loop. Defaults to a "nothing stale / not
 * armed / executor starts successfully" configuration.
 */
interface Phase2Overrides {
  staleState?: boolean;
  armed?: boolean;
  startExecutorImpl?: BootDependencies["startExecutorFn"];
  buildApprovalHandlerImpl?: BootDependencies["buildApprovalHandlerFn"];
  applySchemaSpy?: ReturnType<typeof vi.fn>;
}

function happyPathDeps(
  overrides: Partial<BootDependencies> & Phase2Overrides = {},
): BootDependencies {
  const now = Date.now();
  const {
    staleState = false,
    armed = false,
    startExecutorImpl,
    buildApprovalHandlerImpl,
    applySchemaSpy,
    ...rest
  } = overrides;

  const stopExecutorSpy = vi.fn().mockResolvedValue(undefined);
  const defaultStartExecutor: BootDependencies["startExecutorFn"] = async () =>
    stopExecutorSpy;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const defaultHandler: any = vi.fn();
  const defaultBuildApprovalHandler: BootDependencies["buildApprovalHandlerFn"] =
    () => defaultHandler;

  return {
    logger: silentLogger(),
    secrets: mockSecrets(),
    redisFactory: () =>
      mockRedis({
        pingBehavior: "ok",
        armed: armed ? "true" : null,
      }),
    dbFactory: () => mockDb(),
    spotFactory: async () =>
      mockSpotClient({ ok: true, serverTime: now }),
    futuresFactory: async () =>
      mockFuturesClient({ ok: true, serverTime: now }),
    fetchPublicIp: async () => "127.0.0.1",
    stalePositionsExistFn: vi.fn().mockResolvedValue(staleState),
    isArmedFn: vi.fn().mockResolvedValue(armed),
    applySchemaFn: applySchemaSpy ?? vi.fn(),
    startExecutorFn: startExecutorImpl ?? defaultStartExecutor,
    buildApprovalHandlerFn:
      buildApprovalHandlerImpl ?? defaultBuildApprovalHandler,
    ...rest,
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

describe("boot — Phase 2 executor integration", () => {
  it("Step 10: throws BootError stage=stale-state when stalePositionsExist returns true", async () => {
    try {
      await boot(happyPathDeps({ staleState: true }));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).stage).toBe("stale-state");
      expect((e as Error).message).toContain("stale state detected");
      expect((e as Error).message).toContain("pnpm reconcile");
    }
  });

  it("Step 10: does NOT call startExecutor when stale state is detected", async () => {
    const startExecutorSpy = vi.fn().mockResolvedValue(async () => undefined);
    try {
      await boot(
        happyPathDeps({
          staleState: true,
          startExecutorImpl: startExecutorSpy,
        }),
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
    }
    expect(startExecutorSpy).not.toHaveBeenCalled();
  });

  it("Step 10: continues past stale check when none exists", async () => {
    const startExecutorSpy = vi.fn().mockResolvedValue(async () => undefined);
    await boot(
      happyPathDeps({
        staleState: false,
        startExecutorImpl: startExecutorSpy,
      }),
    );
    expect(startExecutorSpy).toHaveBeenCalledTimes(1);
  });

  it("Step 11: logs warning 'executor NOT armed' when Redis executor:armed != 'true'", async () => {
    const log = silentLogger();
    await boot(happyPathDeps({ logger: log, armed: false }));
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const notArmedCall = warnCalls.find((c) =>
      c.some(
        (arg) =>
          typeof arg === "string" && arg.includes("executor NOT armed"),
      ),
    );
    expect(notArmedCall).toBeDefined();
  });

  it("Step 11: logs 'executor armed' (info, not warn) when Redis executor:armed === 'true'", async () => {
    const log = silentLogger();
    await boot(happyPathDeps({ logger: log, armed: true }));
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const armedCall = infoCalls.find((c) =>
      c.some((arg) => typeof arg === "string" && arg === "executor armed"),
    );
    expect(armedCall).toBeDefined();

    // And the unarmed-warn DID NOT fire
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    const notArmedCall = warnCalls.find((c) =>
      c.some(
        (arg) =>
          typeof arg === "string" && arg.includes("executor NOT armed"),
      ),
    );
    expect(notArmedCall).toBeUndefined();
  });

  it("Step 11: calls applySchema(db) before starting the executor consumer", async () => {
    const applySchemaSpy = vi.fn();
    const callOrder: string[] = [];
    const wrappedApply = vi.fn(() => {
      callOrder.push("applySchema");
      applySchemaSpy();
    });
    const wrappedStart: BootDependencies["startExecutorFn"] = async () => {
      callOrder.push("startExecutor");
      return async () => undefined;
    };
    await boot(
      happyPathDeps({
        applySchemaSpy: wrappedApply,
        startExecutorImpl: wrappedStart,
      }),
    );
    expect(applySchemaSpy).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["applySchema", "startExecutor"]);
  });

  it("Step 12: BootResult.stopExecutor is callable and resolves", async () => {
    const stopSpy = vi.fn().mockResolvedValue(undefined);
    const result = await boot(
      happyPathDeps({
        startExecutorImpl: async () => stopSpy,
      }),
    );
    expect(typeof result.stopExecutor).toBe("function");
    await expect(result.stopExecutor()).resolves.toBeUndefined();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("Step 12: creates a DEDICATED consumerRedis via deps.redisFactory (called twice)", async () => {
    const redisFactorySpy = vi.fn(() =>
      mockRedis({ pingBehavior: "ok", armed: null }),
    );
    await boot(
      happyPathDeps({
        redisFactory: redisFactorySpy,
      }),
    );
    // Once for the main handle (Step 5), once for the consumer loop (Step 12).
    expect(redisFactorySpy).toHaveBeenCalledTimes(2);
  });

  it("Step 12: passes the consumerRedis (second factory call) into startExecutor", async () => {
    const mainRedis = mockRedis({ pingBehavior: "ok", armed: null });
    const consumerRedis = mockRedis({ pingBehavior: "ok", armed: null });
    const factoryCalls: Array<ReturnType<typeof mockRedis>> = [
      mainRedis,
      consumerRedis,
    ];
    let factoryIndex = 0;
    const redisFactorySpy = vi.fn(() => {
      const r = factoryCalls[factoryIndex];
      factoryIndex += 1;
      // biome-ignore lint/style/noNonNullAssertion: test-invariant
      return r!;
    });
    const startExecutorSpy = vi
      .fn<NonNullable<BootDependencies["startExecutorFn"]>>()
      .mockResolvedValue(async () => undefined);
    await boot(
      happyPathDeps({
        redisFactory: redisFactorySpy,
        startExecutorImpl: startExecutorSpy,
      }),
    );
    expect(startExecutorSpy).toHaveBeenCalledTimes(1);
    // First positional arg is the consumer Redis.
    // biome-ignore lint/style/noNonNullAssertion: test-invariant
    const firstCallArgs = startExecutorSpy.mock.calls[0]!;
    expect(firstCallArgs[0]).toBe(consumerRedis);
  });

  it("Step 12: BootResult.executorArmed reflects Redis value (true case)", async () => {
    const resultArmed = await boot(happyPathDeps({ armed: true }));
    expect(resultArmed.executorArmed).toBe(true);
  });

  it("Step 12: BootResult.executorArmed reflects Redis value (false case)", async () => {
    const resultUnarmed = await boot(happyPathDeps({ armed: false }));
    expect(resultUnarmed.executorArmed).toBe(false);
  });

  it("Step 12: throws BootError stage=stale-state + disconnects consumerRedis when startExecutor throws", async () => {
    const mainRedis = mockRedis({ pingBehavior: "ok", armed: null });
    const consumerRedis = mockRedis({ pingBehavior: "ok", armed: null });
    const consumerDisconnectSpy = consumerRedis.disconnect as ReturnType<
      typeof vi.fn
    >;
    const factoryCalls: Array<ReturnType<typeof mockRedis>> = [
      mainRedis,
      consumerRedis,
    ];
    let factoryIndex = 0;
    const redisFactorySpy = vi.fn(() => {
      const r = factoryCalls[factoryIndex];
      factoryIndex += 1;
      // biome-ignore lint/style/noNonNullAssertion: test-invariant
      return r!;
    });
    const startExecutorSpy = vi
      .fn<NonNullable<BootDependencies["startExecutorFn"]>>()
      .mockRejectedValue(new Error("redis streams unavailable"));
    try {
      await boot(
        happyPathDeps({
          redisFactory: redisFactorySpy,
          startExecutorImpl: startExecutorSpy,
        }),
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).stage).toBe("stale-state");
      expect((e as Error).message).toContain("executor start failed");
    }
    expect(consumerDisconnectSpy).toHaveBeenCalled();
  });

  it("Step 12: buildApprovalHandler receives { spot, redis, db, log }", async () => {
    const buildApprovalHandlerSpy = vi.fn(
      // biome-ignore lint/suspicious/noExplicitAny: test mock for opaque handler
      (): any => vi.fn(),
    );
    await boot(
      happyPathDeps({
        buildApprovalHandlerImpl: buildApprovalHandlerSpy,
      }),
    );
    expect(buildApprovalHandlerSpy).toHaveBeenCalledTimes(1);
    // biome-ignore lint/style/noNonNullAssertion: test-invariant
    const firstCall = buildApprovalHandlerSpy.mock.calls[0]!;
    const depsArg = (firstCall as unknown as [Record<string, unknown>])[0];
    expect(depsArg.spot).toBeDefined();
    expect(depsArg.redis).toBeDefined();
    expect(depsArg.db).toBeDefined();
    expect(depsArg.log).toBeDefined();
  });
});
