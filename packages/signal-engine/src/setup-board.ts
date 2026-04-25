import type { MarketScan, TradeIdea } from "@kr8tiv/shared-schemas";
import type { StrategyBacktestComparison } from "./backtest.js";
import type { FuturesContextAssessment } from "./context.js";
import type { AdaptiveGridPlan } from "./grid.js";

export type SetupBoardAction = "consider_long" | "consider_short" | "wait";

export type SetupBoardRow = {
  symbol: string;
  currentPrice: number;
  action: SetupBoardAction;
  score: number;
  primaryDirection: "long" | "short" | "neutral";
  primaryStrategy: string | null;
  bestBacktestStrategy: string | null;
  backtestNetPnlPct: number | null;
  contextBias: FuturesContextAssessment["bias"];
  contextScore: number;
  fundamentalPosture: "supportive" | "caution" | "hostile" | null;
  fundamentalScore: number | null;
  gridLevelCount: number;
  styleConflictCount: number;
  blockers: string[];
  notes: string[];
};

export type SetupBoardFundamentals = {
  posture: "supportive" | "caution" | "hostile";
  score: number;
  notes?: readonly string[];
};

export type BuildSetupBoardRowInput = {
  scan: MarketScan;
  comparison: StrategyBacktestComparison;
  context: FuturesContextAssessment;
  gridPlan: AdaptiveGridPlan;
  fundamentals?: SetupBoardFundamentals;
  styleConflictCount?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function topIdea(scan: MarketScan): TradeIdea | null {
  return (
    [...scan.ideas].sort((a, b) => b.confidence - a.confidence)[0] ?? null
  );
}

function primaryStrategy(idea: TradeIdea | null): string | null {
  if (!idea) return null;
  return (
    [...idea.strategies].sort((a, b) => b.confidence - a.confidence)[0]
      ?.strategy ?? null
  );
}

function contextOpposes(
  direction: "long" | "short",
  context: FuturesContextAssessment,
): boolean {
  return (
    context.score >= 60 &&
    ((direction === "long" && context.bias === "short") ||
      (direction === "short" && context.bias === "long"))
  );
}

export function buildSetupBoardRow(
  input: BuildSetupBoardRowInput,
): SetupBoardRow {
  const idea = topIdea(input.scan);
  const strategy = primaryStrategy(idea);
  const best = input.comparison.best;
  const styleConflictCount = input.styleConflictCount ?? 0;
  const blockers: string[] = [];
  const notes: string[] = [];

  if (!idea) {
    blockers.push("no actionable model setup");
  }
  if (!best) {
    blockers.push("recent backtest has no positive edge");
  } else {
    notes.push(
      `backtest supports ${best.strategy}: ${best.netPnlPct.toFixed(2)}% net, PF ${best.profitFactor.toFixed(2)}`,
    );
  }
  if (idea && contextOpposes(idea.direction, input.context)) {
    blockers.push("context is strongly against the model side");
  }
  if (input.fundamentals?.posture === "hostile") {
    blockers.push("fundamentals are hostile for this asset");
  }
  if (input.fundamentals?.posture === "caution") {
    notes.push("fundamentals are only caution; reduce size or require cleaner confirmation");
  }
  for (const note of input.fundamentals?.notes ?? []) {
    notes.push(`fundamentals: ${note}`);
  }
  if (input.gridPlan.warnings.length > 0) {
    notes.push(input.gridPlan.warnings.join("; "));
  }
  if (styleConflictCount > 0) {
    notes.push(`${styleConflictCount} style conflict(s) need review before entry`);
  }
  for (const warning of input.scan.warnings) {
    notes.push(warning);
  }

  const backtestBoost =
    best && idea?.strategies.some((signal) => signal.strategy === best.strategy)
      ? 10
      : best
        ? 4
        : -18;
  const contextBoost =
    idea && input.context.bias === idea.direction && input.context.score >= 55
      ? 8
      : idea && contextOpposes(idea.direction, input.context)
        ? -25
        : 0;
  const fundamentalBoost =
    input.fundamentals?.posture === "supportive"
      ? 6
      : input.fundamentals?.posture === "caution"
        ? -4
        : input.fundamentals?.posture === "hostile"
          ? -22
          : 0;
  const gridBoost =
    strategy === "adaptive-grid" && input.gridPlan.levels.length > 0 ? 5 : 0;
  const stylePenalty = styleConflictCount * 5;
  const score = clamp(
    Math.round((idea?.confidence ?? 0) * 100 + backtestBoost + contextBoost + fundamentalBoost + gridBoost - stylePenalty),
    0,
    100,
  );

  const action: SetupBoardAction =
    idea && blockers.length === 0
      ? idea.direction === "long"
        ? "consider_long"
        : "consider_short"
      : "wait";

  return {
    symbol: input.scan.symbol,
    currentPrice: input.scan.currentPrice,
    action,
    score,
    primaryDirection: idea?.direction ?? "neutral",
    primaryStrategy: strategy,
    bestBacktestStrategy: best?.strategy ?? null,
    backtestNetPnlPct: best?.netPnlPct ?? null,
    contextBias: input.context.bias,
    contextScore: input.context.score,
    fundamentalPosture: input.fundamentals?.posture ?? null,
    fundamentalScore: input.fundamentals?.score ?? null,
    gridLevelCount: input.gridPlan.levels.length,
    styleConflictCount,
    blockers,
    notes,
  };
}
