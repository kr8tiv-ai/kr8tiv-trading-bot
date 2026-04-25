import type { MexcFuturesMarketContext } from "@kr8tiv/shared-schemas";

export type FuturesContextBias = "long" | "short" | "neutral";
export type FuturesCrowdingState =
  | "longs_crowded"
  | "shorts_crowded"
  | "balanced";

export type FuturesContextAssessment = {
  symbol: string;
  bias: FuturesContextBias;
  crowding: FuturesCrowdingState;
  score: number;
  fundingRate: number;
  basisPct: number;
  riseFallRate: number;
  amount24: number;
  holdVol: number;
  notes: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pct(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

export function assessFuturesContext(
  context: MexcFuturesMarketContext,
): FuturesContextAssessment {
  const notes: string[] = [];
  const fundingAbs = Math.abs(context.fundingRate);
  const basisAbs = Math.abs(context.basisPct);
  const moveAbs = Math.abs(context.riseFallRate);
  const score = clamp(
    Math.round(
      fundingAbs * 55_000 +
        basisAbs * 18_000 +
        moveAbs * 450 +
        (context.amount24 > 0 ? Math.log10(context.amount24) * 2 : 0),
    ),
    0,
    100,
  );

  const longsCrowded =
    context.fundingRate >= 0.0005 &&
    context.basisPct >= 0.001 &&
    context.riseFallRate >= 0;
  const shortsCrowded =
    context.fundingRate <= -0.0005 &&
    context.basisPct <= -0.001 &&
    context.riseFallRate <= 0;

  if (longsCrowded) {
    notes.push(
      `crowded longs: funding ${pct(context.fundingRate)} and basis ${pct(
        context.basisPct,
      )} are stretched while price is up ${pct(context.riseFallRate)}`,
    );
    notes.push("avoid late long chases; prefer pullback confirmation or short fades");
    return {
      symbol: context.symbol,
      bias: "short",
      crowding: "longs_crowded",
      score,
      fundingRate: context.fundingRate,
      basisPct: context.basisPct,
      riseFallRate: context.riseFallRate,
      amount24: context.amount24,
      holdVol: context.holdVol,
      notes,
    };
  }

  if (shortsCrowded) {
    notes.push(
      `crowded shorts: funding ${pct(context.fundingRate)} and basis ${pct(
        context.basisPct,
      )} are stretched while price is down ${pct(context.riseFallRate)}`,
    );
    notes.push("avoid late short chases; prefer reclaim confirmation or long fades");
    return {
      symbol: context.symbol,
      bias: "long",
      crowding: "shorts_crowded",
      score,
      fundingRate: context.fundingRate,
      basisPct: context.basisPct,
      riseFallRate: context.riseFallRate,
      amount24: context.amount24,
      holdVol: context.holdVol,
      notes,
    };
  }

  notes.push(
    `balanced context: funding ${pct(context.fundingRate)}, basis ${pct(
      context.basisPct,
    )}, 24h move ${pct(context.riseFallRate)}`,
  );
  return {
    symbol: context.symbol,
    bias: "neutral",
    crowding: "balanced",
    score,
    fundingRate: context.fundingRate,
    basisPct: context.basisPct,
    riseFallRate: context.riseFallRate,
    amount24: context.amount24,
    holdVol: context.holdVol,
    notes,
  };
}
