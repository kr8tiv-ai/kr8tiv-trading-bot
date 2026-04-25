import type {
  StrategyBacktestComparison,
  StrategyBacktestResult,
} from "./backtest.js";
import type { FuturesContextAssessment } from "./context.js";
import type { AdaptiveGridPlan } from "./grid.js";

export type GridTradingCandidateAction = "paper_grid" | "watch" | "avoid";

export type GridTradingCandidate = {
  symbol: string;
  action: GridTradingCandidateAction;
  score: number;
  gridLevelCount: number;
  allocatedCapitalQuote: number;
  rangePct: number;
  bestBacktestStrategy: string | null;
  gridBacktestNetPnlPct: number | null;
  gridBacktestWinRate: number | null;
  gridBacktestProfitFactor: number | null;
  contextBias: FuturesContextAssessment["bias"];
  contextCrowding: FuturesContextAssessment["crowding"];
  fundamentalPosture: "supportive" | "caution" | "hostile" | null;
  fundamentalScore: number | null;
  blockers: string[];
  notes: string[];
};

export type GridCandidateFundamentals = {
  posture: "supportive" | "caution" | "hostile";
  score: number;
  notes?: readonly string[];
};

export type ScoreGridTradingCandidateInput = {
  plan: AdaptiveGridPlan;
  comparison: StrategyBacktestComparison;
  context: FuturesContextAssessment;
  fundamentals?: GridCandidateFundamentals;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function gridResult(
  comparison: StrategyBacktestComparison,
): StrategyBacktestResult | null {
  return (
    comparison.results.find((result) => result.strategy === "adaptive-grid") ??
    null
  );
}

export function scoreGridTradingCandidate(
  input: ScoreGridTradingCandidateInput,
): GridTradingCandidate {
  const grid = gridResult(input.comparison);
  const blockers: string[] = [];
  const notes: string[] = [];

  if (input.plan.levels.length === 0) {
    blockers.push("grid planner produced no executable levels");
  }
  if (input.comparison.best?.strategy !== "adaptive-grid") {
    blockers.push("adaptive-grid is not the best recent replay");
  }
  if (!grid || grid.netPnlPct <= 0) {
    blockers.push("adaptive-grid replay is not positive after fees");
  }
  if (input.context.crowding !== "balanced" && input.context.score >= 60) {
    blockers.push("crowded futures context is hostile to passive grid entries");
  }
  if (input.fundamentals?.posture === "hostile") {
    blockers.push("fundamentals are hostile for this asset");
  }
  if (input.fundamentals?.posture === "caution") {
    notes.push("fundamentals are only caution; paper-test smaller before live grid execution");
  }
  for (const note of input.fundamentals?.notes ?? []) {
    notes.push(`fundamentals: ${note}`);
  }
  for (const warning of input.plan.warnings) {
    if (warning.includes("compressed") || warning.includes("capital")) {
      blockers.push(warning);
    } else {
      notes.push(warning);
    }
  }
  for (const warning of grid?.warnings ?? []) {
    notes.push(warning);
  }

  const gridNet = grid?.netPnlPct ?? 0;
  const pf = grid?.profitFactor ?? 0;
  const levelScore = Math.min(input.plan.levels.length, 8) * 4;
  const edgeScore = gridNet * 6 + Math.min(pf, 3) * 8;
  const contextPenalty =
    input.context.crowding === "balanced" ? 0 : input.context.score * 0.25;
  const fundamentalAdjustment =
    input.fundamentals?.posture === "supportive"
      ? 5
      : input.fundamentals?.posture === "caution"
        ? -4
        : input.fundamentals?.posture === "hostile"
          ? -20
          : 0;
  const warningPenalty = input.plan.warnings.length * 5;
  const score = clamp(
    Math.round(42 + levelScore + edgeScore + fundamentalAdjustment - contextPenalty - warningPenalty),
    0,
    100,
  );

  const action: GridTradingCandidateAction =
    blockers.length > 0 ? "avoid" : score >= 70 ? "paper_grid" : "watch";

  if (action === "paper_grid") {
    notes.unshift(
      "paper-grid ready: plan, replay, and futures context agree; keep live execution manual",
    );
  } else if (action === "watch") {
    notes.unshift("watch only: grid is plausible but not strong enough to risk yet");
  }

  return {
    symbol: input.plan.symbol,
    action,
    score,
    gridLevelCount: input.plan.levels.length,
    allocatedCapitalQuote: input.plan.allocatedCapitalQuote,
    rangePct: input.plan.rangePct,
    bestBacktestStrategy: input.comparison.best?.strategy ?? null,
    gridBacktestNetPnlPct: grid?.netPnlPct ?? null,
    gridBacktestWinRate: grid?.winRate ?? null,
    gridBacktestProfitFactor: grid?.profitFactor ?? null,
    contextBias: input.context.bias,
    contextCrowding: input.context.crowding,
    fundamentalPosture: input.fundamentals?.posture ?? null,
    fundamentalScore: input.fundamentals?.score ?? null,
    blockers,
    notes,
  };
}
