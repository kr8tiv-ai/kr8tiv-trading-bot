import { createLogger } from "@kr8tiv/logger";
import { readFuturesAccountStatus } from "./futures-account-status.js";

const log = createLogger().child({ service: "futures-status" });

function formatNumber(value: number, decimals = 4): string {
  return value.toFixed(decimals);
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const status = await readFuturesAccountStatus();
  if (!status.available) throw new Error(status.message);
  const { snapshot } = status;

  if (json) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  const lines = [
    "MEXC futures account status",
    `USDT total ${formatNumber(snapshot.usdt.total, 2)} | free ${formatNumber(snapshot.usdt.free, 2)} | used ${formatNumber(snapshot.usdt.used, 2)}`,
    "",
    "Open BTC/ETH/SOL positions:",
  ];

  if (snapshot.positions.length === 0) {
    lines.push("- none");
  } else {
    for (const position of snapshot.positions) {
      lines.push(
        `- ${position.symbol} ${position.side} ${position.leverage}x | contracts ${formatNumber(position.contracts)} | ` +
          `notional ${formatNumber(position.notionalQuote, 2)} USDT | entry ${formatNumber(position.entryPrice)} | ` +
          `mark ${formatNumber(position.markPrice)} | uPnL ${formatNumber(position.unrealizedPnl, 2)} USDT`,
      );
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((err) => {
  log.fatal({ err }, "futures status failed");
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
