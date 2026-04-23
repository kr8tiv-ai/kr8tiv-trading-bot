import { createRedis, pingOrThrow, type Redis } from "@kr8tiv/redis-client";
import { diffScans } from "@kr8tiv/signal-engine";
import {
  MarketScanSchema,
  SignalWatchEventSchema,
  type MarketScan,
  type SignalWatchEvent,
} from "@kr8tiv/shared-schemas";
import { createLogger } from "@kr8tiv/logger";
import { MEXCFuturesClient } from "@kr8tiv/mexc-futures";
import {
  formatScan,
  parseScanArgs,
  publicOnlyProvider,
  scanSymbols,
  type ScanOptions,
} from "./scan-signals.js";

const log = createLogger().child({ service: "signals-watch" });

const WATCH_STREAM = "signals.market-watch";

interface WatchOptions extends ScanOptions {
  intervalMs: number;
  iterations: number;
}

function parseWatchArgs(argv: string[]): WatchOptions {
  const baseArgv: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--interval-ms" || arg === "--iterations") {
      i += 1;
      continue;
    }
    baseArgv.push(arg);
  }

  const options: WatchOptions = {
    ...parseScanArgs(baseArgv.filter((arg) => arg !== "--json")),
    json: false,
    intervalMs: 60_000,
    iterations: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--interval-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 5_000) {
        throw new Error("--interval-ms must be an integer >= 5000");
      }
      options.intervalMs = value;
      i += 1;
      continue;
    }
    if (arg === "--iterations") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--iterations must be an integer >= 0");
      }
      options.iterations = value;
      i += 1;
    }
  }

  return options;
}

function latestScanKey(symbol: string): string {
  return `signals:latest:${symbol}`;
}

async function loadPreviousScan(
  redis: Redis,
  symbol: string,
): Promise<MarketScan | null> {
  const raw = await redis.get(latestScanKey(symbol));
  if (!raw) return null;
  return MarketScanSchema.parse(JSON.parse(raw));
}

async function saveCurrentScan(redis: Redis, scan: MarketScan): Promise<void> {
  await redis.set(latestScanKey(scan.symbol), JSON.stringify(scan));
}

async function publishEvent(
  redis: Redis,
  event: SignalWatchEvent,
): Promise<void> {
  const parsed = SignalWatchEventSchema.parse(event);
  await redis.xadd(
    WATCH_STREAM,
    "MAXLEN",
    "~",
    "1000",
    "*",
    "symbol",
    parsed.symbol,
    "eventType",
    parsed.eventType,
    "json",
    JSON.stringify(parsed),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function formatEvent(event: SignalWatchEvent): string {
  return `[${event.symbol}] ${event.title} | ${event.message}`;
}

async function main(): Promise<void> {
  const options = parseWatchArgs(process.argv.slice(2));
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const redis = createRedis();
  await pingOrThrow(redis);

  try {
    let remaining = options.iterations;
    while (remaining !== 0) {
      const scans = await scanSymbols(client, options);
      const now = Date.now();

      for (const scan of scans) {
        const previous = await loadPreviousScan(redis, scan.symbol);
        const events = diffScans(previous, scan, now);
        await saveCurrentScan(redis, scan);

        if (events.length === 0) {
          process.stdout.write(
            `[${scan.symbol}] no meaningful change | regime=${scan.regime} | ideas=${scan.ideas.length}\n`,
          );
        } else {
          for (const event of events) {
            await publishEvent(redis, event);
            process.stdout.write(`${formatEvent(event)}\n`);
          }
        }
      }

      if (options.iterations > 0) {
        remaining -= 1;
        if (remaining === 0) break;
      }

      process.stdout.write(
        `\nNext watch cycle in ${Math.round(options.intervalMs / 1000)}s\n\n`,
      );
      await sleep(options.intervalMs);
    }

    process.stdout.write("\nFinal market state:\n");
    const finalScans = await scanSymbols(client, options);
    for (const scan of finalScans) {
      process.stdout.write(`${formatScan(scan)}\n\n`);
    }
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  log.fatal({ err }, "signals watch failed");
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
