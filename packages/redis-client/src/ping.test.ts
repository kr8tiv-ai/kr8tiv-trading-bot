import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { createRedis, pingOrThrow } from "./factory.js";

/**
 * Probe TCP port 6379 synchronously (within a 300ms window) to decide whether
 * to run the live Redis tests. If no server answers, we skip them — the unit
 * tests still prove constructor defaults.
 *
 * FND-03 expects a live ping; that gets verified by Matt running
 * `pnpm -F @kr8tiv/redis-client test` after `Start-Service Memurai`.
 */
const REDIS_UP: boolean = await new Promise<boolean>((resolve) => {
  const socket = new net.Socket();
  const done = (result: boolean): void => {
    try {
      socket.destroy();
    } catch {
      /* ok */
    }
    resolve(result);
  };
  socket.setTimeout(300);
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  socket.once("timeout", () => done(false));
  socket.connect(6379, "127.0.0.1");
});

describe("createRedis", () => {
  it("constructs a client with the provided URL", () => {
    const c = createRedis({ url: "redis://127.0.0.1:6379" });
    expect(c.options.host).toBe("127.0.0.1");
    expect(c.options.port).toBe(6379);
    void c.disconnect();
  });

  it("defaults to lazyConnect:true, maxRetriesPerRequest:3, enableReadyCheck:true", () => {
    const c = createRedis({ url: "redis://127.0.0.1:6390" });
    expect(c.options.lazyConnect).toBe(true);
    expect(c.options.maxRetriesPerRequest).toBe(3);
    expect(c.options.enableReadyCheck).toBe(true);
    void c.disconnect();
  });

  it("accepts an override URL that wins over env default", () => {
    const c = createRedis({ url: "redis://alt.example.com:6400" });
    expect(c.options.host).toBe("alt.example.com");
    expect(c.options.port).toBe(6400);
    void c.disconnect();
  });
});

describe.skipIf(!REDIS_UP)(
  "pingOrThrow (live — requires Memurai/Redis on 127.0.0.1:6379)",
  () => {
    let client: ReturnType<typeof createRedis> | undefined;

    afterEach(async () => {
      if (client) {
        try {
          await client.quit();
        } catch {
          /* ok */
        }
        client = undefined;
      }
    });

    it("resolves with no error when Redis is up", async () => {
      client = createRedis({ url: "redis://127.0.0.1:6379" });
      await expect(pingOrThrow(client)).resolves.toBeUndefined();
    });

    it("throws a descriptive error when Redis is unreachable", async () => {
      client = createRedis({
        url: "redis://127.0.0.1:6390",
        connectTimeout: 500,
        commandTimeout: 500,
        maxRetriesPerRequest: 1,
      });
      await expect(pingOrThrow(client)).rejects.toThrow(/Redis ping failed/);
    }, 5_000);
  },
);

describe.skipIf(REDIS_UP)("pingOrThrow (offline fallback — Redis NOT running)", () => {
  it("(skipped live tests) installing Memurai will enable the live suite", () => {
    expect(REDIS_UP).toBe(false);
  });
});
