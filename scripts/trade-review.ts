import { reviewTradePlan } from "@kr8tiv/accountability";
import { AccountableTradePlanSchema } from "@kr8tiv/shared-schemas";

type RawArgs = Record<string, string | boolean>;

function usage(): never {
  throw new Error(
    [
      "Usage: pnpm trade:review --symbol BTCUSDT --side long --horizon scalp",
      "                         --mode sniper --leverage 75 --margin 12",
      "                         --entry 93500 --stop 93140 --target 94400",
      "                         --why \"setup thesis\" --note \"journal note\"",
      "",
      "Modes: sniper = 30x-100x smaller-capital snipe, core = <=30x larger-capital trade",
    ].join("\n"),
  );
}

function parseRaw(argv: string[]): RawArgs {
  const out: RawArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) usage();
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function stringArg(args: RawArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) usage();
  return value.trim();
}

function numberArg(args: RawArgs, key: string): number {
  const value = Number(stringArg(args, key));
  if (!Number.isFinite(value)) usage();
  return value;
}

function main(): void {
  const args = parseRaw(process.argv.slice(2));
  const plan = AccountableTradePlanSchema.parse({
    symbol: stringArg(args, "symbol").toUpperCase(),
    market: "mexc-futures",
    direction: stringArg(args, "side"),
    horizon: stringArg(args, "horizon"),
    riskMode: stringArg(args, "mode"),
    leverage: numberArg(args, "leverage"),
    marginQuote: numberArg(args, "margin"),
    entryPrice: numberArg(args, "entry"),
    stopLossPrice: numberArg(args, "stop"),
    takeProfitPrice: numberArg(args, "target"),
    thesis: stringArg(args, "why"),
    journalNote: stringArg(args, "note"),
    createdAtMs: Date.now(),
  });

  const review = reviewTradePlan(plan);
  const verdict = review.okToProceed ? "OK TO PLAN" : "BLOCKED";
  const lines = [
    `${verdict}: ${plan.symbol} ${plan.direction} ${plan.leverage}x ${plan.riskMode}`,
    `margin: ${plan.marginQuote.toFixed(2)} USDT | estimated loss: ${review.estimatedLossQuote.toFixed(2)} USDT | estimated reward: ${review.estimatedRewardQuote.toFixed(2)} USDT | R: ${review.riskRewardRatio.toFixed(2)}`,
  ];

  if (review.blocks.length > 0) {
    lines.push("blocks:");
    for (const block of review.blocks) lines.push(`- ${block.message}`);
  }
  if (review.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of review.warnings) lines.push(`- ${warning.message}`);
  }

  lines.push("journal:");
  lines.push(`- why: ${plan.thesis}`);
  lines.push(`- note: ${plan.journalNote}`);

  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(review.okToProceed ? 0 : 2);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
}
