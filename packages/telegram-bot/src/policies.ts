export type SignalSuppressionReason =
  | "DAILY_CAP_REACHED"
  | "PAIR_COOLDOWN_ACTIVE";

export type SignalSuppressionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: SignalSuppressionReason;
      readonly retryAtMs?: number;
    };

export type ApprovalPressDecision =
  | { readonly allowed: true; readonly driftBps: number }
  | {
      readonly allowed: false;
      readonly reason: "EXPIRED" | "PRICE_DRIFT_EXCEEDED";
      readonly driftBps: number;
    };

export function isWhitelistedChat(
  chatId: string | number | undefined,
  allowedChatId: string,
): boolean {
  if (chatId === undefined) return false;
  return String(chatId) === allowedChatId;
}

export function isApprovalExpired(
  expiresAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs >= expiresAtMs;
}

export function computePriceDriftBps(
  entryPrice: number,
  currentPrice: number,
): number {
  return Number((((currentPrice - entryPrice) / entryPrice) * 10000).toFixed(4));
}

export function evaluateSignalSuppression(args: {
  todaysSignalCount: number;
  dailySignalCap: number;
  lastRejectedAtMs?: number;
  nowMs: number;
  rejectCooldownMs: number;
}): SignalSuppressionDecision {
  if (args.todaysSignalCount >= args.dailySignalCap) {
    return { allowed: false, reason: "DAILY_CAP_REACHED" };
  }
  if (
    args.lastRejectedAtMs !== undefined &&
    args.nowMs - args.lastRejectedAtMs < args.rejectCooldownMs
  ) {
    return {
      allowed: false,
      reason: "PAIR_COOLDOWN_ACTIVE",
      retryAtMs: args.lastRejectedAtMs + args.rejectCooldownMs,
    };
  }
  return { allowed: true };
}

export function evaluateApprovalPress(args: {
  entryPrice: number;
  currentPrice: number;
  expiresAtMs: number;
  nowMs: number;
  maxPriceDriftBps: number;
}): ApprovalPressDecision {
  const driftBps = computePriceDriftBps(args.entryPrice, args.currentPrice);
  if (isApprovalExpired(args.expiresAtMs, args.nowMs)) {
    return { allowed: false, reason: "EXPIRED", driftBps };
  }
  if (Math.abs(driftBps) > args.maxPriceDriftBps) {
    return { allowed: false, reason: "PRICE_DRIFT_EXCEEDED", driftBps };
  }
  return { allowed: true, driftBps };
}
