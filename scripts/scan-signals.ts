import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase } from "@kr8tiv/db";
import { applySchema } from "@kr8tiv/executor";
import {
  FUTURES_KLINE_INTERVAL_MS,
  MEXCFuturesClient,
  SUPPORTED_FUTURES_SIGNAL_SYMBOLS,
  type FuturesKlineInterval,
} from "@kr8tiv/mexc-futures";
import { analyzeMarket, type AnalyzeMarketInput } from "@kr8tiv/signal-engine";
import {
  buildStyleConflicts,
  buildStyleFingerprint,
  reconstructTrades,
} from "@kr8tiv/style-engine";
import { createLogger } from "@kr8tiv/logger";
import {
  ImportedTradeSchema,
  type ImportedTrade,
  type MarketScan,
  type StyleFingerprint,
} from "@kr8tiv/shared-schemas";
import type { SecretProvider } from "@kr8tiv/secrets";

const log = createLogger().child({ service: "signals-scan" });

export type ScanOptions = {
  json: boolean;
  symbols: string[];
  shortInterval: FuturesKlineInterval;
  longInterval: FuturesKlineInterval;
  limit: number;
  style: boolean;
  proposedNotionalQuote?: number;
};

export const publicOnlyProvider: SecretProvider = {
  async get(name) {
    throw new Error(`public-only provider does not contain secret: ${name}`);
  },
  async has() {
    return false;
  },
  async list() {
    return [];
  },
  async set() {
    /* no-op */
  },
  async delete() {
    /* no-op */
  },
};

function usage(): never {
  throw new Error(
    [
      "Usage: pnpm signals:scan [--json] [--symbols BTCUSDT,ETHUSDT,SOLUSDT]",
      "                       [--short Min15] [--long Hour4] [--limit 160]",
      "",
      `Supported symbols: ${SUPPORTED_FUTURES_SIGNAL_SYMBOLS.join(", ")}`,
      `Supported intervals: ${Object.keys(FUTURES_KLINE_INTERVAL_MS).join(", ")}`,
    ].join("\n"),
  );
}

export function parseScanArgs(argv: string[]): ScanOptions {
  const options: ScanOptions = {
    json: false,
    symbols: [...SUPPORTED_FUTURES_SIGNAL_SYMBOLS],
    shortInterval: "Min15",
    longInterval: "Hour4",
    limit: 160,
    style: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--style") {
      options.style = true;
      continue;
    }
    if (arg === "--notional") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) usage();
      options.proposedNotionalQuote = value;
      i += 1;
      continue;
    }
    if (arg === "--symbols") {
      const value = argv[i + 1];
      if (!value) usage();
      options.symbols = value
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--short") {
      const value = argv[i + 1] as FuturesKlineInterval | undefined;
      if (!value || !(value in FUTURES_KLINE_INTERVAL_MS)) usage();
      options.shortInterval = value;
      i += 1;
      continue;
    }
    if (arg === "--long") {
      const value = argv[i + 1] as FuturesKlineInterval | undefined;
      if (!value || !(value in FUTURES_KLINE_INTERVAL_MS)) usage();
      options.longInterval = value;
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 60) usage();
      options.limit = value;
      i += 1;
      continue;
    }
    usage();
  }

  if (options.symbols.length === 0) usage();
  for (const symbol of options.symbols) {
    if (!SUPPORTED_FUTURES_SIGNAL_SYMBOLS.includes(symbol as never)) {
      throw new Error(`unsupported symbol in --symbols: ${symbol}`);
    }
  }

  return options;
}

export function toHumanInterval(interval: FuturesKlineInterval): string {
  switch (interval) {
    case "Min1":
      return "1m";
    case "Min5":
      return "5m";
    case "Min15":
      return "15m";
    case "Min30":
      return "30m";
    case "Hour1":
      return "1h";
    case "Hour4":
      return "4h";
    case "Day1":
      return "1d";
  }
  throw new Error(`unsupported interval: ${interval}`);
}

export function formatScan(scan: MarketScan): string {
  const lines = [
    `=== ${scan.symbol} ===`,
    `regime: ${scan.regime} | price: ${scan.currentPrice.toFixed(4)}`,
  ];

  if (scan.warnings.length > 0) {
    lines.push(`warnings: ${scan.warnings.join(" | ")}`);
  }

  if (scan.ideas.length === 0) {
    lines.push("ideas: none");
  } else {
    lines.push("ideas:");
    for (const idea of scan.ideas) {
      lines.push(
        `- ${idea.horizon} ${idea.direction} | conf ${(idea.confidence * 100).toFixed(0)}% | ` +
          `entry ${idea.entryPrice.toFixed(4)} | invalidation ${idea.invalidationPrice.toFixed(4)} | ` +
          `targets ${idea.targets.map((target) => target.toFixed(4)).join(", ")}`,
      );
      lines.push(`  thesis: ${idea.thesis}`);
      if (idea.conflictsWithStyle && idea.conflictsWithStyle.length > 0) {
        for (const conflict of idea.conflictsWithStyle) {
          lines.push(`  style ${conflict.severity}: ${conflict.message}`);
        }
      }
    }
  }

  lines.push("drivers:");
  for (const signal of scan.strategies) {
    lines.push(
      `- ${signal.timeframe} ${signal.strategy}: ${signal.bias} ${(signal.confidence * 100).toFixed(0)}% ` +
        `| ${signal.summary}`,
    );
  }

  return lines.join("\n");
}

export async function scanSymbols(
  client: MEXCFuturesClient,
  options: ScanOptions,
): Promise<MarketScan[]> {
  return Promise.all(
    options.symbols.map(async (symbol) => {
      const [shortCandles, longCandles] = await Promise.all([
        client.fetchCandles({
          symbol,
          interval: options.shortInterval,
          limit: options.limit,
        }),
        client.fetchCandles({
          symbol,
          interval: options.longInterval,
          limit: options.limit,
        }),
      ]);

      const input: AnalyzeMarketInput = {
        symbol,
        market: "mexc-futures",
        shortTimeframe: toHumanInterval(options.shortInterval),
        longTimeframe: toHumanInterval(options.longInterval),
        shortCandles,
        longCandles,
      };
      return analyzeMarket(input);
    }),
  );
}

function readImportedTrades(symbols: string[]): ImportedTrade[] {
  const db = openDatabase();
  try {
    applySchema(db);
    const rows = db
      .prepare(
        `SELECT
          venue,
          market,
          symbol,
          side,
          price,
          size,
          quote_notional AS quoteNotional,
          fee,
          fee_currency AS feeCurrency,
          executed_at_ms AS executedAtMs,
          source_trade_id AS sourceTradeId,
          source_order_id AS sourceOrderId,
          leverage,
          risk_mode AS riskMode,
          thesis,
          journal_note AS journalNote,
          raw_response AS rawResponse
        FROM trades
        WHERE symbol IN (${symbols.map(() => "?").join(",")})
        ORDER BY executed_at_ms ASC`,
      )
      .all(...symbols);
    return ImportedTradeSchema.array().parse(rows);
  } finally {
    closeDatabase(db);
  }
}

export function annotateScansWithStyle(
  scans: MarketScan[],
  fingerprints: StyleFingerprint[],
  proposedNotionalQuote?: number,
): MarketScan[] {
  const bySymbol = new Map(
    fingerprints.map((fingerprint) => [fingerprint.symbol, fingerprint]),
  );
  const generatedAtMs = Date.now();

  return scans.map((scan) => ({
    ...scan,
    ideas: scan.ideas.map((idea) => ({
      ...idea,
      conflictsWithStyle: buildStyleConflicts(
        proposedNotionalQuote === undefined
          ? { symbol: scan.symbol, generatedAtMs }
          : { symbol: scan.symbol, generatedAtMs, proposedNotionalQuote },
        bySymbol.get(scan.symbol),
      ),
    })),
  }));
}

async function main(): Promise<void> {
  const options = parseScanArgs(process.argv.slice(2));
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  let scans = await scanSymbols(client, options);

  if (options.style) {
    const imported = readImportedTrades(options.symbols);
    const closed = reconstructTrades(imported);
    const fingerprints = options.symbols.map((symbol) =>
      buildStyleFingerprint(symbol, closed),
    );
    scans = annotateScansWithStyle(
      scans,
      fingerprints,
      options.proposedNotionalQuote,
    );
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(scans, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Signal scan complete for ${options.symbols.join(", ")}`,
      `windows: ${toHumanInterval(options.shortInterval)} + ${toHumanInterval(options.longInterval)}`,
      "",
      ...scans.map((scan) => formatScan(scan)),
    ].join("\n"),
  );
  process.stdout.write("\n");
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    log.fatal({ err }, "signal scan failed");
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
