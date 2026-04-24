import { closeDatabase, openDatabase } from "@kr8tiv/db";
import { applySchema } from "@kr8tiv/executor";
import {
  buildStyleFingerprint,
  reconstructTrades,
} from "@kr8tiv/style-engine";
import {
  ImportedTradeSchema,
  type ImportedTrade,
  type StyleFingerprint,
} from "@kr8tiv/shared-schemas";

type Options = {
  symbols: string[];
  json: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
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
      if (!value) throw new Error("missing --symbols value");
      options.symbols = value.split(",").map((s) => s.trim().toUpperCase());
      i += 1;
      continue;
    }
    throw new Error(`unknown arg: ${arg}`);
  }

  return options;
}

function readTrades(db: ReturnType<typeof openDatabase>, symbols: string[]): ImportedTrade[] {
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
}

function formatMs(ms: number): string {
  if (ms === 0) return "0m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function formatFingerprint(fingerprint: StyleFingerprint): string {
  const hourLines = Object.entries(fingerprint.hourOfDayExpectancy)
    .map(
      ([hour, stats]) =>
        `  ${hour.padStart(2, "0")}: samples=${stats.sampleCount}, avgPnL=${stats.avgNetPnlQuote.toFixed(2)}, winRate=${(stats.winRate * 100).toFixed(0)}%`,
    )
    .join("\n");

  return [
    `=== ${fingerprint.symbol} style fingerprint ===`,
    `closed trades: ${fingerprint.sampleCount}`,
    `avg hold: ${formatMs(fingerprint.avgHoldTimeMs)} | median hold: ${formatMs(fingerprint.medianHoldTimeMs)}`,
    `median size: ${fingerprint.medianPositionSizeQuote.toFixed(2)} USDT | win rate: ${(fingerprint.winRate * 100).toFixed(0)}%`,
    `win/loss hold: ${formatMs(fingerprint.avgWinHoldTimeMs)} / ${formatMs(fingerprint.avgLossHoldTimeMs)}`,
    `preferred UTC hours: ${fingerprint.preferredEntryHoursUtc.length > 0 ? fingerprint.preferredEntryHoursUtc.join(", ") : "none yet"}`,
    hourLines ? `hour expectancy:\n${hourLines}` : "hour expectancy: no closed trades yet",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = openDatabase();
  try {
    applySchema(db);
    const imported = readTrades(db, options.symbols);
    const closed = reconstructTrades(imported);
    const fingerprints = options.symbols.map((symbol) =>
      buildStyleFingerprint(symbol, closed),
    );

    if (options.json) {
      process.stdout.write(`${JSON.stringify(fingerprints, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${fingerprints.map(formatFingerprint).join("\n\n")}\n`);
  } finally {
    closeDatabase(db);
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
