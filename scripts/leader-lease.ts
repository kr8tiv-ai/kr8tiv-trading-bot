import { hostname } from "node:os";
import type { Redis } from "@kr8tiv/redis-client";

/**
 * Leader-lease helper for the multi-instance pattern (CLAUDE.md "If running
 * BOTH" — Windows + Hostinger VPS). Only ONE instance writes orders or paper
 * trades at a time. Implementation: SET cockpit:leader <holder> NX PX <ttl>
 * to acquire; renew with PX before expiry. If the key is held by someone
 * else, this instance becomes a follower and the cockpit refuses mutating
 * endpoints.
 *
 * Single-host development: the lease is acquired immediately on boot and the
 * cockpit shows "leader". Adds zero friction in the common case.
 */

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_RENEW_INTERVAL_MS = 20_000;
const LEASE_KEY = "cockpit:leader";

export type LeaderLeaseStatus = {
  readonly key: string;
  readonly isLeader: boolean;
  readonly holder: string;
  readonly expiresAtMs: number | null;
  readonly hostname: string;
  readonly pid: number;
};

export interface LeaderLease {
  readonly status: () => LeaderLeaseStatus;
  readonly stop: () => Promise<void>;
}

function makeHolder(): string {
  return `${hostname()}#${process.pid}`;
}

/**
 * Try to acquire the lease, retrying renewal in the background. The function
 * returns immediately with a status reflecting the first attempt; if another
 * instance holds the lease, this one stays follower until it free or TTL
 * expires (and a `tryAcquire` tick succeeds).
 */
export async function startLeaderLease(args: {
  readonly redis: Redis;
  readonly holder?: string;
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
  readonly onChange?: (status: LeaderLeaseStatus) => void;
}): Promise<LeaderLease> {
  const holder = args.holder ?? makeHolder();
  const ttlMs = args.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const renewMs = args.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  let isLeader = false;
  let currentHolder = holder;
  let expiresAtMs: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function tryAcquire(): Promise<void> {
    if (stopped) return;
    try {
      // SET key value NX PX ttl — acquires the lease only if no holder yet.
      const result = await args.redis.set(LEASE_KEY, holder, "PX", ttlMs, "NX");
      if (result === "OK") {
        if (!isLeader) {
          isLeader = true;
          currentHolder = holder;
          expiresAtMs = Date.now() + ttlMs;
          args.onChange?.(snapshot());
        } else {
          expiresAtMs = Date.now() + ttlMs;
        }
        return;
      }
      // Already held — see who has it.
      const observed = await args.redis.get(LEASE_KEY);
      if (observed === holder) {
        // We hold it but the NX SET failed (because the key already exists).
        // Refresh the TTL with a non-NX PX SET so we don't lose the lease.
        await args.redis.set(LEASE_KEY, holder, "PX", ttlMs);
        if (!isLeader) {
          isLeader = true;
          currentHolder = holder;
          args.onChange?.(snapshot());
        }
        expiresAtMs = Date.now() + ttlMs;
      } else {
        if (isLeader) {
          isLeader = false;
          args.onChange?.(snapshot());
        }
        currentHolder = observed ?? "(unknown)";
        // We don't know the remote TTL; mark unknown.
        expiresAtMs = null;
      }
    } catch {
      if (isLeader) {
        isLeader = false;
        args.onChange?.(snapshot());
      }
      // Redis blip — preserve last known holder. Will retry on next tick.
    }
  }

  function snapshot(): LeaderLeaseStatus {
    return {
      key: LEASE_KEY,
      isLeader,
      holder: currentHolder,
      expiresAtMs,
      hostname: hostname(),
      pid: process.pid,
    };
  }

  await tryAcquire();
  timer = setInterval(() => {
    void tryAcquire();
  }, renewMs);
  // Keep the Node event loop unpinned by the timer so SIGINT exits cleanly.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    status: snapshot,
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      try {
        // Only release the lease if we actually hold it (compare-and-delete
        // via Lua to avoid stomping a different leader).
        await args.redis.eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
          else
            return 0
          end`,
          1,
          LEASE_KEY,
          holder,
        );
      } catch {
        // Best-effort release; if Redis is gone the lease will TTL out.
      }
    },
  };
}
