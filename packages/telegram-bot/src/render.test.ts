import { describe, expect, it } from "vitest";
import {
  buildApprovalKeyboard,
  renderApprovalCard,
  renderExpiredApprovalCard,
  renderPriceDriftRejectedCard,
  renderStatusMessage,
} from "./render.js";

describe("telegram rendering", () => {
  it("renders an approval card with all required operator fields", () => {
    const text = renderApprovalCard({
      signalId: "sig-1",
      pair: "ETHUSDT",
      side: "buy",
      entryPrice: 1800,
      stopPrice: 1760,
      targetPrice: 1860,
      confidence: 0.72,
      regime: "trend",
      fundingRatePct: 0.01,
      rationale: "EMA20 crossed EMA50 with ADX above 25",
      currentPrice: 1801.5,
      priceDeltaBps: 8.3,
      estimatedFeeUsd: 0.02,
      estimatedSlippageUsd: 0.03,
      conflictsWithStyle: "You do not usually trade this hour.",
      issuedAtMs: 1_777_000_000_000,
      expiresAtMs: 1_777_000_090_000,
    });

    expect(text).toContain("Signal ETHUSDT BUY");
    expect(text).toContain("Entry:");
    expect(text).toContain("Stop:");
    expect(text).toContain("Target:");
    expect(text).toContain("Confidence:");
    expect(text).toContain("Regime:");
    expect(text).toContain("Funding:");
    expect(text).toContain("Current vs entry:");
    expect(text).toContain("Fee + slippage est:");
    expect(text).toContain("Style conflict:");
  });

  it("builds a 2-button approval keyboard", () => {
    const keyboard = buildApprovalKeyboard({
      signalId: "sig-1",
      issuedAtMs: 1_777_000_000_000,
    });
    const inlineKeyboard = keyboard.inline_keyboard;
    expect(inlineKeyboard).toHaveLength(1);
    expect(inlineKeyboard[0]).toHaveLength(2);
    expect(inlineKeyboard[0]?.[0]?.text).toBe("Approve");
    expect(inlineKeyboard[0]?.[1]?.text).toBe("Reject");
  });

  it("renders expired and stale-price variants", () => {
    expect(renderExpiredApprovalCard("sig-1")).toContain("Signal expired");
    expect(
      renderPriceDriftRejectedCard({
        signalId: "sig-1",
        driftBps: 35.2,
        maxPriceDriftBps: 30,
      }),
    ).toContain("price drift");
  });

  it("renders /status snapshot text", () => {
    const text = renderStatusMessage({
      openPositions: 1,
      todaysPnlUsd: -1.25,
      todaysSignalCount: 3,
      circuitBreakerTripped: false,
      executorArmed: true,
    });

    expect(text).toContain("Open positions: 1");
    expect(text).toContain("Today's PnL: -$1.25");
    expect(text).toContain("Today's signals: 3");
    expect(text).toContain("Circuit breaker: clear");
    expect(text).toContain("Executor: armed");
  });
});
