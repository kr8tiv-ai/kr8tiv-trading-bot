import { describe, expect, it } from "vitest";
import { SignalWatchEventSchema } from "./signal-watch.js";

describe("SignalWatchEventSchema", () => {
  it("parses an idea-opened event", () => {
    const parsed = SignalWatchEventSchema.parse({
      eventId: "BTCUSDT:long:scalp:idea-opened:1700000000000",
      symbol: "BTCUSDT",
      eventType: "idea-opened",
      occurredAtMs: 1_700_000_000_000,
      regime: "bullish",
      currentPrice: 80000,
      title: "new scalp long setup",
      message: "bullish regime aligned with short-term momentum",
      ideaKey: "long:scalp",
      direction: "long",
      horizon: "scalp",
      confidence: 0.81,
    });
    expect(parsed.eventType).toBe("idea-opened");
  });

  it("parses a regime-changed event without idea fields", () => {
    const parsed = SignalWatchEventSchema.parse({
      eventId: "ETHUSDT:regime-changed:1700000000000",
      symbol: "ETHUSDT",
      eventType: "regime-changed",
      occurredAtMs: 1_700_000_000_000,
      regime: "bearish",
      currentPrice: 3200,
      title: "regime changed",
      message: "higher timeframe flipped from range to bearish",
      previousRegime: "range",
    });
    expect(parsed.previousRegime).toBe("range");
  });
});

