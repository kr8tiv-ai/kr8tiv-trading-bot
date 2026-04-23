import { describe, expect, it } from "vitest";
import type { MarketScan } from "@kr8tiv/shared-schemas";
import { diffScans } from "./watch.js";

function makeScan(overrides: Partial<MarketScan>): MarketScan {
  return {
    symbol: "BTCUSDT",
    market: "mexc-futures",
    currentPrice: 80000,
    regime: "bullish",
    warnings: [],
    strategies: [],
    ideas: [],
    ...overrides,
  };
}

describe("diffScans", () => {
  it("emits an idea-opened event for a new scalp long", () => {
    const current = makeScan({
      ideas: [
        {
          symbol: "BTCUSDT",
          market: "mexc-futures",
          direction: "long",
          horizon: "scalp",
          confidence: 0.82,
          entryPrice: 80000,
          invalidationPrice: 79400,
          targets: [80600, 81200],
          thesis: "trend and momentum aligned",
          reasons: ["bullish trend", "positive MACD"],
          strategies: [],
        },
      ],
    });

    const events = diffScans(null, current, 1_700_000_000_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("idea-opened");
  });

  it("emits a regime-changed event when the higher timeframe flips", () => {
    const previous = makeScan({ regime: "range" });
    const current = makeScan({ regime: "bearish" });

    const events = diffScans(previous, current, 1_700_000_000_000);
    expect(events.some((event) => event.eventType === "regime-changed")).toBe(
      true,
    );
  });

  it("emits idea-updated when confidence changes materially", () => {
    const previous = makeScan({
      ideas: [
        {
          symbol: "BTCUSDT",
          market: "mexc-futures",
          direction: "long",
          horizon: "swing",
          confidence: 0.55,
          entryPrice: 80000,
          invalidationPrice: 78800,
          targets: [81800, 83200],
          thesis: "old thesis",
          reasons: ["trend"],
          strategies: [],
        },
      ],
    });
    const current = makeScan({
      ideas: [
        {
          symbol: "BTCUSDT",
          market: "mexc-futures",
          direction: "long",
          horizon: "swing",
          confidence: 0.74,
          entryPrice: 80120,
          invalidationPrice: 78950,
          targets: [82000, 83450],
          thesis: "improving structure",
          reasons: ["trend", "breakout"],
          strategies: [],
        },
      ],
    });

    const events = diffScans(previous, current, 1_700_000_000_000);
    expect(events.some((event) => event.eventType === "idea-updated")).toBe(
      true,
    );
  });

  it("emits idea-closed when a prior setup disappears", () => {
    const previous = makeScan({
      ideas: [
        {
          symbol: "BTCUSDT",
          market: "mexc-futures",
          direction: "short",
          horizon: "scalp",
          confidence: 0.67,
          entryPrice: 80000,
          invalidationPrice: 80600,
          targets: [79400, 78900],
          thesis: "fade setup",
          reasons: ["momentum"],
          strategies: [],
        },
      ],
    });

    const current = makeScan({ ideas: [] });
    const events = diffScans(previous, current, 1_700_000_000_000);
    expect(events.some((event) => event.eventType === "idea-closed")).toBe(
      true,
    );
  });
});

