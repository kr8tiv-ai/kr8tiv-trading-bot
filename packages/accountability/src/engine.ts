import {
  AccountabilityCheckSchema,
  AccountableTradePlanSchema,
  type AccountabilityCheck,
  type AccountabilityIssue,
  type AccountableTradePlan,
} from "@kr8tiv/shared-schemas";

function round(value: number, decimals: number = 8): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function issue(
  code: AccountabilityIssue["code"],
  message: string,
): AccountabilityIssue {
  return { code, message };
}

function isMeaningfulJournal(plan: AccountableTradePlan): boolean {
  return plan.thesis.trim().length >= 20 && plan.journalNote.trim().length >= 10;
}

function stopDistance(plan: AccountableTradePlan): number {
  return plan.direction === "long"
    ? plan.entryPrice - plan.stopLossPrice
    : plan.stopLossPrice - plan.entryPrice;
}

function targetDistance(plan: AccountableTradePlan): number {
  return plan.direction === "long"
    ? plan.takeProfitPrice - plan.entryPrice
    : plan.entryPrice - plan.takeProfitPrice;
}

export function reviewTradePlan(plan: AccountableTradePlan): AccountabilityCheck {
  const blocks: AccountabilityIssue[] = [];
  const warnings: AccountabilityIssue[] = [];

  const parsed = AccountableTradePlanSchema.safeParse(plan);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message).join("; ");
    if (/thesis|journal/i.test(messages) || !isMeaningfulJournal(plan)) {
      blocks.push(
        issue("missing-thesis", "Journal thesis is required before entry."),
      );
    }
    if (/stopLossPrice/i.test(messages)) {
      blocks.push(issue("invalid-stop", "Stop loss is on the wrong side."));
    }
    if (/takeProfitPrice/i.test(messages)) {
      blocks.push(issue("invalid-target", "Take profit is on the wrong side."));
    }
  } else if (!isMeaningfulJournal(plan)) {
    blocks.push(
      issue("missing-thesis", "Journal thesis is required before entry."),
    );
  }

  if (plan.riskMode === "core" && plan.leverage > 30) {
    blocks.push(
      issue(
        "leverage-mode-mismatch",
        "Core trades must stay at 30x leverage or below.",
      ),
    );
  }
  if (plan.riskMode === "sniper" && plan.leverage < 30) {
    blocks.push(
      issue(
        "leverage-mode-mismatch",
        "Sniper trades are reserved for 30x-100x high-leverage setups.",
      ),
    );
  }

  if (plan.leverage >= 75) {
    warnings.push(
      issue(
        "high-leverage",
        `${plan.leverage}x sniper setup; size must stay small and invalidation tight.`,
      ),
    );
  }

  const notional = plan.marginQuote * plan.leverage;
  const quantity = notional / plan.entryPrice;
  const estimatedLossQuote = Math.max(0, stopDistance(plan) * quantity);
  const estimatedRewardQuote = Math.max(0, targetDistance(plan) * quantity);
  const riskRewardRatio =
    estimatedLossQuote === 0 ? 0 : estimatedRewardQuote / estimatedLossQuote;

  if (estimatedLossQuote <= 0) {
    blocks.push(issue("invalid-stop", "Stop loss is required before entry."));
  }
  if (estimatedRewardQuote <= 0) {
    blocks.push(issue("invalid-target", "Take profit is required before entry."));
  }
  if (riskRewardRatio > 0 && riskRewardRatio < 1.5) {
    blocks.push(
      issue(
        "poor-risk-reward",
        `Risk/reward is ${round(riskRewardRatio, 2)}R; require at least 1.5R.`,
      ),
    );
  }

  return AccountabilityCheckSchema.parse({
    okToProceed: blocks.length === 0,
    estimatedLossQuote: round(estimatedLossQuote),
    estimatedRewardQuote: round(estimatedRewardQuote),
    riskRewardRatio: round(riskRewardRatio),
    blocks,
    warnings,
  });
}
