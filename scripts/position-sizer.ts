import type { AccountableTradePlan, RiskMode } from "@kr8tiv/shared-schemas";

/**
 * Bankroll-aware position sizing helper. Given:
 *   - free USDT (from MEXC futures account or a manual override)
 *   - desired risk-of-account percent per trade (default 0.5%)
 *   - the plan's entry / stop / direction / mode
 *
 * Compute the (marginQuote, leverage) pair that makes a stop-out cost exactly
 * the requested account-risk percent — clamped to the legal range for the
 * trade's risk mode (sniper 30-100x, core 1-30x).
 *
 * The math:
 *   stopDistancePct = |entry - stop| / entry
 *   maxLossQuote    = freeUsdt * riskOfAccountPct
 *   notionalQuote   = maxLossQuote / stopDistancePct        // size the trade
 *   marginQuote     = notionalQuote / leverage              // collateral
 *
 * We pick leverage **first** (mode-bounded, capped by stop tightness so we
 * don't get instantly liquidated by adverse price action before the stop),
 * then derive marginQuote so the stop hits exactly at the target loss.
 *
 * Heuristic: for safety, keep effective leverage at most ~70% of the price
 * distance from entry to liquidation. With isolated margin and stop orders
 * pre-set, MEXC liquidates near `entry / (1 ± 1/leverage)`. We require the
 * stop to sit BEFORE liquidation by at least 50%, i.e.:
 *
 *   stopDistancePct * leverage ≤ 0.5
 *
 * Solving for leverage:
 *
 *   maxSafeLeverage = floor(0.5 / stopDistancePct)
 */
export type SuggestedSize = {
  readonly marginQuote: number;
  readonly leverage: number;
  readonly notionalQuote: number;
  readonly maxLossQuote: number;
  readonly stopDistancePct: number;
  readonly rationale: string[];
  readonly clampedTo:
    | "mode-min"
    | "mode-max"
    | "liquidation-safety"
    | "free-balance"
    | "exact"
    | "stop-too-tight";
};

const MODE_RANGE: Record<RiskMode, { min: number; max: number }> = {
  sniper: { min: 30, max: 100 },
  // Medium = the cockpit's "10x-50x faster than core but not full-send" tier
  // — disciplined but quicker to act than core. Sized between sniper and core.
  medium: { min: 10, max: 50 },
  core: { min: 1, max: 30 },
};

const DEFAULT_RISK_OF_ACCOUNT = 0.005; // 0.5%
const SAFETY_MARGIN_VS_LIQUIDATION = 0.5; // stop must hit at ≤50% of distance to liq
const MIN_MARGIN_QUOTE = 1; // never propose < $1 margin (MEXC dust)

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export type SuggestSizeArgs = {
  readonly freeUsdt: number;
  readonly riskOfAccountPct?: number; // 0.005 = 0.5%
  readonly plan: Pick<
    AccountableTradePlan,
    "direction" | "entryPrice" | "stopLossPrice" | "riskMode"
  >;
};

/**
 * Compute a safe (marginQuote, leverage) pair for the given plan + account.
 *
 * Returns `clampedTo` so the cockpit can explain WHY the suggested size
 * landed where it did (e.g. "stop too tight, capped at safety leverage 50x").
 */
export function suggestPositionSize(args: SuggestSizeArgs): SuggestedSize {
  const { freeUsdt, plan } = args;
  const riskOfAccountPct = args.riskOfAccountPct ?? DEFAULT_RISK_OF_ACCOUNT;
  const rationale: string[] = [];

  if (freeUsdt <= 0) {
    return {
      marginQuote: 0,
      leverage: MODE_RANGE[plan.riskMode].min,
      notionalQuote: 0,
      maxLossQuote: 0,
      stopDistancePct: 0,
      rationale: ["free USDT is 0; cannot size a trade"],
      clampedTo: "free-balance",
    };
  }

  const stopDistance =
    plan.direction === "long"
      ? plan.entryPrice - plan.stopLossPrice
      : plan.stopLossPrice - plan.entryPrice;

  if (stopDistance <= 0) {
    return {
      marginQuote: 0,
      leverage: MODE_RANGE[plan.riskMode].min,
      notionalQuote: 0,
      maxLossQuote: 0,
      stopDistancePct: 0,
      rationale: ["stop is on the wrong side of entry; sizer cannot proceed"],
      clampedTo: "stop-too-tight",
    };
  }

  const stopDistancePct = stopDistance / plan.entryPrice;
  const maxLossQuote = freeUsdt * riskOfAccountPct;
  const targetNotional = maxLossQuote / stopDistancePct;

  const range = MODE_RANGE[plan.riskMode];
  const safetyLeverage = Math.floor(SAFETY_MARGIN_VS_LIQUIDATION / stopDistancePct);

  let leverage = clamp(safetyLeverage, range.min, range.max);
  let clampedTo: SuggestedSize["clampedTo"] = "exact";

  if (safetyLeverage < range.min) {
    // Stop is too far away to fit the mode — keep min leverage but warn.
    leverage = range.min;
    clampedTo = "stop-too-tight";
    rationale.push(
      `stop is ${(stopDistancePct * 100).toFixed(2)}% away — too wide for ${plan.riskMode} bounds; using min leverage ${range.min}x`,
    );
  } else if (safetyLeverage > range.max) {
    leverage = range.max;
    clampedTo = "mode-max";
    rationale.push(
      `stop is tight enough to support ${safetyLeverage}x but capped at ${range.max}x for ${plan.riskMode} mode`,
    );
  } else {
    rationale.push(
      `safety-bounded leverage = ${safetyLeverage}x (stop sits at ${(SAFETY_MARGIN_VS_LIQUIDATION * 100).toFixed(0)}% of distance to liquidation)`,
    );
  }

  let marginQuote = round2(targetNotional / leverage);
  // Cap marginQuote at half of free balance so we always keep dry powder.
  const cap = round2(freeUsdt * 0.5);
  if (marginQuote > cap) {
    rationale.push(
      `requested margin ${marginQuote.toFixed(2)} USDT > 50% of free balance; capped at ${cap.toFixed(2)} USDT`,
    );
    marginQuote = cap;
    clampedTo = "free-balance";
  }
  if (marginQuote < MIN_MARGIN_QUOTE) {
    rationale.push(`computed margin < ${MIN_MARGIN_QUOTE} USDT; bumped to floor`);
    marginQuote = MIN_MARGIN_QUOTE;
  }

  rationale.unshift(
    `target risk = ${(riskOfAccountPct * 100).toFixed(2)}% of ${freeUsdt.toFixed(2)} USDT = ${maxLossQuote.toFixed(2)} USDT max loss`,
  );

  return {
    marginQuote,
    leverage,
    notionalQuote: round2(marginQuote * leverage),
    maxLossQuote: round2(maxLossQuote),
    stopDistancePct: Number(stopDistancePct.toFixed(6)),
    rationale,
    clampedTo,
  };
}
