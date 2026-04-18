import { Redis, type RedisOptions } from "ioredis";
import { env } from "@kr8tiv/config";

export type { Redis };

export interface CreateRedisOverrides extends Partial<RedisOptions> {
  /** Override URL; defaults to env.REDIS_URL */
  url?: string;
}

/**
 * Construct an ioredis client with Phase 1 defaults.
 *
 * - `lazyConnect: true` — no TCP open on construction. Connection errors
 *   surface at first command (ping/get), not at client creation. Cleaner
 *   boot-time failure modes.
 * - `maxRetriesPerRequest: 3` — bounded retry. Default (20) can hang the
 *   bot for minutes on a dead Redis.
 * - `enableReadyCheck: true` — default; kept explicit.
 */
export function createRedis(overrides: CreateRedisOverrides = {}): Redis {
  const { url, ...opts } = overrides;
  return new Redis(url ?? env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    ...opts,
  });
}

/**
 * Ping the Redis instance. Opens the connection if lazyConnect is true.
 * Throws with a descriptive message on failure — callers should let it
 * propagate so boot fails fast with a clear error.
 */
export async function pingOrThrow(client: Redis): Promise<void> {
  let response: string;
  try {
    response = await client.ping();
  } catch (err) {
    throw new Error(
      `Redis ping failed at ${client.options.host ?? "?"}:${client.options.port ?? "?"} — ${String(err)}`,
    );
  }
  if (response !== "PONG") {
    throw new Error(`Redis ping returned unexpected response: ${response}`);
  }
}
