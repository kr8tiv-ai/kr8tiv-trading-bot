import { InlineKeyboard } from "grammy";
import {
  TelegramApprovalCardSchema,
  TelegramStatusSnapshotSchema,
  type TelegramApprovalCard,
  type TelegramStatusSnapshot,
} from "@kr8tiv/shared-schemas";
import { encodeApprovalCallbackData } from "./callbacks.js";

function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}%`;
}

function formatSignedBps(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} bps`;
}

export function renderApprovalCard(payload: TelegramApprovalCard): string {
  const card = TelegramApprovalCardSchema.parse(payload);
  const lines = [
    `Signal ${card.pair} ${card.side.toUpperCase()}`,
    "",
    `Entry: ${card.entryPrice.toFixed(4)}`,
    `Stop: ${card.stopPrice.toFixed(4)}`,
    `Target: ${card.targetPrice.toFixed(4)}`,
    `Confidence: ${(card.confidence * 100).toFixed(1)}%`,
    `Regime: ${card.regime}`,
    `Funding: ${formatPercent(card.fundingRatePct)}`,
    `Current vs entry: ${card.currentPrice.toFixed(4)} (${formatSignedBps(card.priceDeltaBps)})`,
    `Fee + slippage est: ${formatUsd(card.estimatedFeeUsd + card.estimatedSlippageUsd)}`,
    `Expires in: ${Math.max(0, Math.round((card.expiresAtMs - card.issuedAtMs) / 1000))}s`,
    "",
    `Why: ${card.rationale}`,
  ];

  if (card.conflictsWithStyle) {
    lines.push("", `Style conflict: ${card.conflictsWithStyle}`);
  }

  return lines.join("\n");
}

export function buildApprovalKeyboard(
  payload: Pick<TelegramApprovalCard, "signalId" | "issuedAtMs">,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "Approve",
      encodeApprovalCallbackData({
        action: "approve",
        signalId: payload.signalId,
        issuedAtMs: payload.issuedAtMs,
      }),
    )
    .text(
      "Reject",
      encodeApprovalCallbackData({
        action: "reject",
        signalId: payload.signalId,
        issuedAtMs: payload.issuedAtMs,
      }),
    );
}

export function renderExpiredApprovalCard(signalId: string): string {
  return `Signal expired\n\nsignalId: ${signalId}\nNo action taken.`;
}

export function renderPriceDriftRejectedCard(args: {
  signalId: string;
  driftBps: number;
  maxPriceDriftBps: number;
}): string {
  return [
    "Signal expired due to price drift",
    "",
    `signalId: ${args.signalId}`,
    `Observed drift: ${formatSignedBps(args.driftBps)}`,
    `Max allowed drift: ${args.maxPriceDriftBps} bps`,
  ].join("\n");
}

export function renderStatusMessage(snapshot: TelegramStatusSnapshot): string {
  const parsed = TelegramStatusSnapshotSchema.parse(snapshot);
  return [
    "Status",
    "",
    `Open positions: ${parsed.openPositions}`,
    `Today's PnL: ${formatUsd(parsed.todaysPnlUsd)}`,
    `Today's signals: ${parsed.todaysSignalCount}`,
    `Circuit breaker: ${parsed.circuitBreakerTripped ? "TRIPPED" : "clear"}`,
    `Executor: ${parsed.executorArmed ? "armed" : "disarmed"}`,
  ].join("\n");
}
