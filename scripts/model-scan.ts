import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewTradePlan } from "@kr8tiv/accountability";
import { createLogger } from "@kr8tiv/logger";
import { MEXCFuturesClient } from "@kr8tiv/mexc-futures";
import { buildTradePlansFromScan } from "@kr8tiv/signal-engine";
import type {
  AccountableTradePlan,
  AccountabilityCheck,
  MarketScan,
} from "@kr8tiv/shared-schemas";
import {
  formatScan,
  parseScanArgs,
  publicOnlyProvider,
  scanSymbols,
  toHumanInterval,
} from "./scan-signals.js";

const log = createLogger().child({ service: "model-scan" });

type ModelPlan = {
  scan: Pick<MarketScan, "symbol" | "regime" | "currentPrice" | "warnings">;
  plan: AccountableTradePlan;
  review: AccountabilityCheck;
};

function formatModelPlan(item: ModelPlan): string {
  const { scan, plan, review } = item;
  const lines = [
    `- ${plan.symbol} ${plan.direction} ${plan.horizon} ${plan.riskMode} ${plan.leverage}x`,
    `  entry ${plan.entryPrice.toFixed(4)} | stop ${plan.stopLossPrice.toFixed(4)} | target ${plan.takeProfitPrice.toFixed(4)}`,
    `  margin ${plan.marginQuote.toFixed(2)} USDT | loss ${review.estimatedLossQuote.toFixed(2)} | reward ${review.estimatedRewardQuote.toFixed(2)} | ${review.riskRewardRatio.toFixed(2)}R`,
    `  verdict: ${review.okToProceed ? "OK TO PLAN" : "BLOCKED"} | regime ${scan.regime}`,
    `  thesis: ${plan.thesis}`,
  ];
  for (const block of review.blocks) lines.push(`  block: ${block.message}`);
  for (const warning of review.warnings) lines.push(`  warning: ${warning.message}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseScanArgs(process.argv.slice(2));
  const client = await MEXCFuturesClient.create({ secrets: publicOnlyProvider });
  const scans = await scanSymbols(client, options);
  const tradePlanOptions =
    options.proposedNotionalQuote === undefined
      ? {}
      : { marginQuote: options.proposedNotionalQuote };
  const plans = scans.flatMap((scan) =>
    buildTradePlansFromScan(scan, tradePlanOptions).map((plan) => ({
      scan: {
        symbol: scan.symbol,
        regime: scan.regime,
        currentPrice: scan.currentPrice,
        warnings: scan.warnings,
      },
      plan,
      review: reviewTradePlan(plan),
    })),
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ scans, plans }, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Futures model scan for ${options.symbols.join(", ")}`,
      `windows: ${toHumanInterval(options.shortInterval)} + ${toHumanInterval(options.longInterval)}`,
      `plan margin: ${(options.proposedNotionalQuote ?? 10).toFixed(2)} USDT`,
      "",
      scans.map(formatScan).join("\n\n"),
      "",
      "Accountability-ready model plans:",
      plans.length === 0
        ? "- none; model is waiting for cleaner BTC/ETH/SOL structure"
        : plans.map(formatModelPlan).join("\n"),
    ].join("\n"),
  );
  process.stdout.write("\n");
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    log.fatal({ err }, "model scan failed");
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
