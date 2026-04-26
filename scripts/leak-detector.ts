import type { TradeJournalEntry } from "@kr8tiv/executor";
import type { ImportedTrade, ReconstructedTrade } from "@kr8tiv/shared-schemas";
import { reconstructTrades } from "@kr8tiv/style-engine";

/**
 * "Leak of the day" detector. Pulls one actionable behavioral pattern out of
 * Matt's trade history + journal and surfaces it in the cockpit banner.
 *
 * The contract: ONE leak at a time. The cockpit value isn't a 12-row report;
 * it's the single sentence that should change Matt's next decision today.
 *
 * Heuristics, in priority order:
 *
 *   1. **Tilt streak** — last 3 closed trades are losses AND the most recent
 *      journal row has approvalStatus = pending. "You're 0/3 today; the next
 *      plan should sit until the regime resets."
 *   2. **Hour-of-day bleed** — a UTC hour bucket with sampleCount >= 5 and
 *      avgNetPnlQuote < -0.5 USDT. "You bleed at 04:00 UTC: -0.92 avg over 7
 *      closes. Next plan in that window blocks unless conditions match."
 *   3. **Override pattern** — Matt saved >= 3 plans this week with
 *      `okToProceed = false`. "You overrode the accountability verdict 3
 *      times in the last 7 days. Worth re-reading the blocks."
 *   4. **Symbol bias** — one of BTC/ETH/SOL has -ev across >= 5 closes while
 *      another has +ev. "SOL is bleeding for you; BTC is paying. Why are you
 *      still in SOL?"
 *
 * If nothing fires, returns `null` and the cockpit shows the empty state.
 */
export type LeakObservation = {
  readonly code: "tilt-streak" | "hour-of-day-bleed" | "override-pattern" | "symbol-bias";
  readonly severity: "info" | "warn" | "block";
  readonly headline: string;
  readonly detail: string;
  readonly actionHint: string;
  readonly evidence: Record<string, string | number>;
};

const TILT_STREAK_LENGTH = 3;
const HOUR_BUCKET_MIN_SAMPLES = 5;
const HOUR_BUCKET_BLEED_THRESHOLD = -0.5;
const OVERRIDE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const OVERRIDE_THRESHOLD = 3;
const SYMBOL_BIAS_MIN_SAMPLES = 5;

function detectTiltStreak(
  closed: ReconstructedTrade[],
  recentJournal: TradeJournalEntry[],
): LeakObservation | null {
  if (closed.length < TILT_STREAK_LENGTH) return null;
  const last = closed.slice(-TILT_STREAK_LENGTH);
  if (last.some((t) => t.netPnlQuote >= 0)) return null;
  const totalLoss = last.reduce((sum, t) => sum + t.netPnlQuote, 0);
  const hasPending = recentJournal.some((j) => j.approvalStatus === "pending");
  return {
    code: "tilt-streak",
    severity: "block",
    headline: `Tilt streak: 0/${TILT_STREAK_LENGTH} on the last ${TILT_STREAK_LENGTH} closed trades`,
    detail: `Net loss ${totalLoss.toFixed(2)} USDT over the last three closes${hasPending ? "; a pending plan is queued" : ""}.`,
    actionHint: "Walk away. The next plan should sit for at least one regime tick before approval.",
    evidence: {
      streakLength: TILT_STREAK_LENGTH,
      netPnlQuote: Number(totalLoss.toFixed(2)),
      pendingCount: recentJournal.filter((j) => j.approvalStatus === "pending").length,
    },
  };
}

function detectHourOfDayBleed(closed: ReconstructedTrade[]): LeakObservation | null {
  if (closed.length < HOUR_BUCKET_MIN_SAMPLES) return null;
  const buckets = new Map<number, { count: number; total: number; wins: number }>();
  for (const trade of closed) {
    const hour = new Date(trade.entryTimeMs).getUTCHours();
    const bucket = buckets.get(hour) ?? { count: 0, total: 0, wins: 0 };
    bucket.count += 1;
    bucket.total += trade.netPnlQuote;
    if (trade.netPnlQuote > 0) bucket.wins += 1;
    buckets.set(hour, bucket);
  }
  let worstHour: number | null = null;
  let worstAvg = 0;
  let worstSamples = 0;
  for (const [hour, b] of buckets) {
    if (b.count < HOUR_BUCKET_MIN_SAMPLES) continue;
    const avg = b.total / b.count;
    if (avg < worstAvg && avg <= HOUR_BUCKET_BLEED_THRESHOLD) {
      worstAvg = avg;
      worstHour = hour;
      worstSamples = b.count;
    }
  }
  if (worstHour === null) return null;
  const hourLabel = `${String(worstHour).padStart(2, "0")}:00 UTC`;
  return {
    code: "hour-of-day-bleed",
    severity: "warn",
    headline: `Bleed window: ${hourLabel}`,
    detail: `Avg net ${worstAvg.toFixed(2)} USDT across ${worstSamples} closed trades opened in that hour.`,
    actionHint: `If the next plan opens in ${hourLabel}, require a regime + style confirmation before approving.`,
    evidence: {
      hourUtc: worstHour,
      avgNetPnlQuote: Number(worstAvg.toFixed(2)),
      sampleCount: worstSamples,
    },
  };
}

function detectOverridePattern(
  recentJournal: TradeJournalEntry[],
  nowMs: number,
): LeakObservation | null {
  const cutoff = nowMs - OVERRIDE_LOOKBACK_MS;
  const overrides = recentJournal.filter((j) => j.createdAtMs >= cutoff && !j.okToProceed);
  if (overrides.length < OVERRIDE_THRESHOLD) return null;
  const blockCodes = new Set(overrides.flatMap((j) => j.blocks.map((b) => b.code)));
  return {
    code: "override-pattern",
    severity: "warn",
    headline: `Override streak: ${overrides.length} blocked plans saved this week`,
    detail: `Blocks hit: ${[...blockCodes].join(", ") || "(none)"}.`,
    actionHint:
      "Stop overriding the verdict. Either fix the plan to clear the blocks, or skip the trade.",
    evidence: {
      overrideCount: overrides.length,
      lookbackDays: 7,
      uniqueBlockCodes: blockCodes.size,
    },
  };
}

function detectSymbolBias(closed: ReconstructedTrade[]): LeakObservation | null {
  const bySymbol = new Map<string, { count: number; total: number }>();
  for (const t of closed) {
    const b = bySymbol.get(t.symbol) ?? { count: 0, total: 0 };
    b.count += 1;
    b.total += t.netPnlQuote;
    bySymbol.set(t.symbol, b);
  }
  let worst: { symbol: string; avg: number; count: number } | null = null;
  let best: { symbol: string; avg: number; count: number } | null = null;
  for (const [symbol, b] of bySymbol) {
    if (b.count < SYMBOL_BIAS_MIN_SAMPLES) continue;
    const avg = b.total / b.count;
    if (avg < 0 && (worst === null || avg < worst.avg)) {
      worst = { symbol, avg, count: b.count };
    }
    if (avg > 0 && (best === null || avg > best.avg)) {
      best = { symbol, avg, count: b.count };
    }
  }
  if (worst === null || best === null || worst.symbol === best.symbol) {
    return null;
  }
  return {
    code: "symbol-bias",
    severity: "info",
    headline: `${worst.symbol} is bleeding while ${best.symbol} is paying`,
    detail: `${worst.symbol}: ${worst.avg.toFixed(2)} avg over ${worst.count} closes. ${best.symbol}: +${best.avg.toFixed(2)} avg over ${best.count}.`,
    actionHint: `Consider concentrating new sniper risk on ${best.symbol} until ${worst.symbol} regime turns.`,
    evidence: {
      worstSymbol: worst.symbol,
      worstAvg: Number(worst.avg.toFixed(2)),
      bestSymbol: best.symbol,
      bestAvg: Number(best.avg.toFixed(2)),
    },
  };
}

export function findTopLeak(args: {
  readonly trades: ImportedTrade[];
  readonly journal: TradeJournalEntry[];
  readonly nowMs?: number;
}): LeakObservation | null {
  const nowMs = args.nowMs ?? Date.now();
  const closed = reconstructTrades(args.trades);
  const orderedClosed = [...closed].sort((a, b) => a.exitTimeMs - b.exitTimeMs);
  return (
    detectTiltStreak(orderedClosed, args.journal) ??
    detectOverridePattern(args.journal, nowMs) ??
    detectHourOfDayBleed(orderedClosed) ??
    detectSymbolBias(orderedClosed) ??
    null
  );
}
