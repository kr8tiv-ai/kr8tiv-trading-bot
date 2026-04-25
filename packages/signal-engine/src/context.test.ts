import { describe, expect, it } from "vitest";
import type { MexcFuturesMarketContext } from "@kr8tiv/shared-schemas";
import { assessFuturesContext } from "./context.js";

function context(
  patch: Partial<MexcFuturesMarketContext>,
): MexcFuturesMarketContext {
  return {
    symbol: "BTCUSDT",
    lastPrice: 100_000,
    indexPrice: 99_950,
    fairPrice: 100_050,
    basisPct: 0.001,
    fundingRate: 0.0001,
    nextSettleTime: 1_777_000_000_000,
    collectCycleHours: 8,
    volume24: 100_000,
    amount24: 1_000_000_000,
    holdVol: 50_000_000,
    riseFallRate: 0.01,
    high24Price: 104_000,
    low24Price: 96_000,
    timestamp: 1_777_000_000_000,
    ...patch,
  };
}

describe("assessFuturesContext", () => {
  it("flags crowded longs as a short-side caution/fade context", () => {
    const assessment = assessFuturesContext(
      context({ fundingRate: 0.0009, basisPct: 0.002, riseFallRate: 0.035 }),
    );

    expect(assessment.bias).toBe("short");
    expect(assessment.crowding).toBe("longs_crowded");
    expect(assessment.score).toBeGreaterThan(60);
    expect(assessment.notes.join(" ")).toContain("crowded longs");
  });

  it("flags crowded shorts as a long-side caution/fade context", () => {
    const assessment = assessFuturesContext(
      context({ fundingRate: -0.0008, basisPct: -0.0025, riseFallRate: -0.04 }),
    );

    expect(assessment.bias).toBe("long");
    expect(assessment.crowding).toBe("shorts_crowded");
    expect(assessment.score).toBeGreaterThan(60);
    expect(assessment.notes.join(" ")).toContain("crowded shorts");
  });

  it("keeps neutral context neutral when funding and basis are calm", () => {
    const assessment = assessFuturesContext(
      context({ fundingRate: 0.00003, basisPct: 0.0001, riseFallRate: 0.004 }),
    );

    expect(assessment.bias).toBe("neutral");
    expect(assessment.crowding).toBe("balanced");
    expect(assessment.score).toBeLessThan(45);
  });
});
