import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase } from "@kr8tiv/db";
import { applySchema } from "@kr8tiv/executor";
import {
  MEXCFuturesClient,
  SUPPORTED_FUTURES_SIGNAL_SYMBOLS,
} from "@kr8tiv/mexc-futures";
import { logger } from "@kr8tiv/logger";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import type { ImportedTrade } from "@kr8tiv/shared-schemas";

const log = logger.child({ cmd: "history-ingest" });

export type HistoryIngestOptions = {
  symbols: string[];
  days: number;
  limit: number;
  maxPages: number;
  json: boolean;
};

export type HistoryIngestSymbolReport = {
  symbol: string;
  fetched: number;
  insertedOrUpdated: number;
  oldestExecutedAtMs: number | null;
  newestExecutedAtMs: number | null;
  pages: number;
};

function usage(): never {
  throw new Error(
    [
      "Usage: pnpm history:ingest [--symbols BTCUSDT,ETHUSDT,SOLUSDT]",
      "                           [--days 60] [--limit 100] [--max-pages 20] [--json]",
      "",
      "Requires mexc-futures-access and mexc-futures-secret in Windows Credential Manager.",
    ].join("\n"),
  );
}

export function parseHistoryIngestArgs(argv: string[]): HistoryIngestOptions {
  const options: HistoryIngestOptions = {
    symbols: [...SUPPORTED_FUTURES_SIGNAL_SYMBOLS],
    days: 60,
    limit: 100,
    maxPages: 20,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--symbols") {
      const value = argv[i + 1];
      if (!value) usage();
      options.symbols = value.split(",").map((s) => s.trim().toUpperCase());
      i += 1;
      continue;
    }
    if (arg === "--days") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value < 1) usage();
      options.days = Math.trunc(value);
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 500) usage();
      options.limit = value;
      i += 1;
      continue;
    }
    if (arg === "--max-pages") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 200) usage();
      options.maxPages = value;
      i += 1;
      continue;
    }
    usage();
  }

  for (const symbol of options.symbols) {
    if (!SUPPORTED_FUTURES_SIGNAL_SYMBOLS.includes(symbol as never)) {
      throw new Error(`unsupported futures symbol: ${symbol}`);
    }
  }
  return options;
}

function upsertTrade(db: ReturnType<typeof openDatabase>, trade: ImportedTrade): void {
  db.prepare(
    `INSERT INTO trades (
      venue, market, symbol, side, price, size, quote_notional, fee, fee_currency,
      executed_at_ms, source_trade_id, source_order_id, leverage, risk_mode,
      thesis, journal_note, raw_response, imported_at_ms
    ) VALUES (
      @venue, @market, @symbol, @side, @price, @size, @quoteNotional, @fee, @feeCurrency,
      @executedAtMs, @sourceTradeId, @sourceOrderId, @leverage, @riskMode,
      @thesis, @journalNote, @rawResponse, @importedAtMs
    )
    ON CONFLICT(venue, market, source_trade_id) DO UPDATE SET
      price = excluded.price,
      size = excluded.size,
      quote_notional = excluded.quote_notional,
      fee = excluded.fee,
      fee_currency = excluded.fee_currency,
      source_order_id = excluded.source_order_id,
      leverage = excluded.leverage,
      risk_mode = excluded.risk_mode,
      thesis = excluded.thesis,
      journal_note = excluded.journal_note,
      raw_response = excluded.raw_response,
      imported_at_ms = excluded.imported_at_ms`,
  ).run({ ...trade, importedAtMs: Date.now() });
}

async function ingestSymbol(
  client: MEXCFuturesClient,
  db: ReturnType<typeof openDatabase>,
  options: HistoryIngestOptions,
  symbol: string,
): Promise<HistoryIngestSymbolReport> {
  let since = Date.now() - options.days * 24 * 60 * 60 * 1000;
  const report: HistoryIngestSymbolReport = {
    symbol,
    fetched: 0,
    insertedOrUpdated: 0,
    oldestExecutedAtMs: null,
    newestExecutedAtMs: null,
    pages: 0,
  };

  for (let page = 0; page < options.maxPages; page += 1) {
    const rows = await client.fetchMyTradesPage({
      symbol,
      since,
      limit: options.limit,
    });
    report.pages += 1;
    if (rows.length === 0) break;

    const tx = db.transaction((items: ImportedTrade[]) => {
      for (const row of items) upsertTrade(db, row);
    });
    tx(rows);

    report.fetched += rows.length;
    report.insertedOrUpdated += rows.length;
    const times = rows.map((row) => row.executedAtMs);
    const oldest = Math.min(...times);
    const newest = Math.max(...times);
    report.oldestExecutedAtMs =
      report.oldestExecutedAtMs === null
        ? oldest
        : Math.min(report.oldestExecutedAtMs, oldest);
    report.newestExecutedAtMs =
      report.newestExecutedAtMs === null
        ? newest
        : Math.max(report.newestExecutedAtMs, newest);

    if (newest < since) break;
    since = newest + 1;
    if (rows.length < options.limit) break;
  }

  return report;
}

export async function ingestFuturesHistory(
  partial: Partial<HistoryIngestOptions> = {},
): Promise<HistoryIngestSymbolReport[]> {
  const options: HistoryIngestOptions = {
    symbols: partial.symbols ?? [...SUPPORTED_FUTURES_SIGNAL_SYMBOLS],
    days: partial.days ?? 60,
    limit: partial.limit ?? 100,
    maxPages: partial.maxPages ?? 20,
    json: partial.json ?? false,
  };
  for (const symbol of options.symbols) {
    if (!SUPPORTED_FUTURES_SIGNAL_SYMBOLS.includes(symbol as never)) {
      throw new Error(`unsupported futures symbol: ${symbol}`);
    }
  }
  const db = openDatabase();
  try {
    applySchema(db);
    const client = await MEXCFuturesClient.create({
      secrets: new WindowsCredentialManagerProvider(),
    });
    const reports: HistoryIngestSymbolReport[] = [];
    for (const symbol of options.symbols) {
      reports.push(await ingestSymbol(client, db, options, symbol));
    }
    return reports;
  } finally {
    closeDatabase(db);
  }
}

async function main(): Promise<void> {
  const options = parseHistoryIngestArgs(process.argv.slice(2));
  const reports = await ingestFuturesHistory(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    process.stdout.write("Futures history ingest complete\n");
    for (const report of reports) {
      process.stdout.write(
        `${report.symbol}: ${report.insertedOrUpdated} rows across ${report.pages} page(s)\n`,
      );
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  main().catch((err) => {
    log.fatal({ err }, "history ingest failed");
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
