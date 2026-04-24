import { type Bot, InlineKeyboard } from "grammy";
import {
  createTelegramBot,
  encodeApprovalCallbackData,
  loadTelegramRuntimeConfig,
  TelegramConfigError,
} from "@kr8tiv/telegram-bot";
import type {
  AccountableTradePlan,
  AccountabilityCheck,
  StyleConflict,
} from "@kr8tiv/shared-schemas";
import type { SecretProvider } from "@kr8tiv/secrets";
import type { createLogger } from "@kr8tiv/logger";

/**
 * The logger type is re-derived from {@link createLogger}'s return type so
 * `scripts/` doesn't need a direct `pino` devDependency. Keep it in sync if
 * @kr8tiv/logger swaps implementations.
 */
type Logger = ReturnType<typeof createLogger>;

const JOURNAL_SIGNAL_PREFIX = "tj";

/**
 * Round-trip helpers for encoding a numeric `trade_journal.id` into the
 * 64-byte `callback_data` envelope used by @kr8tiv/telegram-bot. The existing
 * `encodeApprovalCallbackData` helper requires a signalId string — we stamp it
 * with the `tj` prefix so callbacks can cleanly be decoded back to a journal
 * row id without colliding with Phase 2's `uuid-v4` signalIds.
 */
export function encodeJournalSignalId(journalId: number): string {
  return `${JOURNAL_SIGNAL_PREFIX}${journalId}`;
}

export function decodeJournalSignalId(signalId: string): number | null {
  if (!signalId.startsWith(JOURNAL_SIGNAL_PREFIX)) return null;
  const parsed = Number.parseInt(
    signalId.slice(JOURNAL_SIGNAL_PREFIX.length),
    10,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export type ApprovalDecisionRecord = {
  readonly journalId: number;
  readonly decision: "approved" | "rejected";
  readonly chatId: number;
  readonly priorStatus: "pending" | "approved" | "rejected" | "expired" | null;
  readonly changed: boolean;
};

export interface TradeJournalLookupEntry {
  readonly id: number;
  readonly symbol: string;
  readonly direction: "long" | "short";
  readonly leverage: number;
  readonly riskMode: "sniper" | "core";
  readonly telegramMessageId: number | null;
}

export interface TelegramDispatcherHandlers {
  /**
   * Called when Matt taps Approve or Reject. The dispatcher has already
   * flipped the DB row via `recordDecision` below — this hook is an
   * opportunity for side-effects (logging, metrics, post-approval actions).
   */
  readonly onDecision: (record: ApprovalDecisionRecord) => Promise<void>;
  /**
   * Fetch a journal row for Telegram message editing. Must return
   * `telegram_message_id` + basic plan metadata.
   */
  readonly lookupEntry: (journalId: number) => TradeJournalLookupEntry | null;
  /**
   * Flip the journal row to approved/rejected in SQLite. Return value mirrors
   * `recordApprovalDecision` so the dispatcher can avoid editing messages
   * twice on duplicate callbacks.
   */
  readonly recordDecision: (
    journalId: number,
    decision: "approved" | "rejected",
  ) => {
    readonly changed: boolean;
    readonly priorStatus:
      | "pending"
      | "approved"
      | "rejected"
      | "expired"
      | null;
  };
  /**
   * Rendered output of `/status` command — cockpit supplies the
   * latest-journal summary so Matt can confirm the app is up from Telegram.
   */
  readonly onStatus: () => Promise<string>;
}

export interface TelegramDispatcher {
  readonly chatId: number;
  sendApprovalCard(args: {
    readonly journalId: number;
    readonly plan: AccountableTradePlan;
    readonly review: AccountabilityCheck;
    readonly conflicts: StyleConflict[];
  }): Promise<{ chatId: number; messageId: number }>;
  stop(): Promise<void>;
}

function format(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

function renderPlanCard(args: {
  journalId: number;
  plan: AccountableTradePlan;
  review: AccountabilityCheck;
  conflicts: StyleConflict[];
}): string {
  const { journalId, plan, review, conflicts } = args;
  const lines = [
    `TJ#${journalId} • ${plan.symbol} ${plan.direction.toUpperCase()} ${plan.leverage}x (${plan.riskMode})`,
    "",
    `Entry  ${plan.entryPrice}`,
    `Stop   ${plan.stopLossPrice}`,
    `Target ${plan.takeProfitPrice}`,
    `Margin ${format(plan.marginQuote)} USDT`,
    `Max loss ${format(review.estimatedLossQuote)} USDT → reward ${format(review.estimatedRewardQuote)} USDT (${format(review.riskRewardRatio)}R)`,
    "",
    `Why: ${plan.thesis}`,
    `Note: ${plan.journalNote}`,
  ];
  if (review.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of review.warnings) {
      lines.push(`• ${warning.message}`);
    }
  }
  if (conflicts.length > 0) {
    lines.push("", "Style conflicts:");
    for (const conflict of conflicts) {
      lines.push(`• (${conflict.severity}) ${conflict.message}`);
    }
  }
  return lines.join("\n");
}

function renderDecisionUpdate(args: {
  journalId: number;
  entry: TradeJournalLookupEntry | null;
  decision: "approved" | "rejected";
  nowMs: number;
}): string {
  const label = args.decision === "approved" ? "APPROVED" : "REJECTED";
  const stamp = new Date(args.nowMs).toISOString().replace("T", " ").slice(0, 19);
  if (args.entry === null) {
    return `TJ#${args.journalId} ${label} (${stamp} UTC)`;
  }
  return [
    `TJ#${args.journalId} ${label} (${stamp} UTC)`,
    `${args.entry.symbol} ${args.entry.direction.toUpperCase()} ${args.entry.leverage}x ${args.entry.riskMode}`,
    "",
    args.decision === "approved"
      ? "Matt approved this plan. Next step: Matt fires the order on MEXC (firing is still manual while futures write path ships in Phase 6)."
      : "Matt rejected this plan. Journal row updated; no exchange action.",
  ].join("\n");
}

export async function startTelegramDispatcher(args: {
  readonly secrets: SecretProvider;
  readonly log: Logger;
  readonly handlers: TelegramDispatcherHandlers;
  /** Defaults to 5000ms. grammY resolves `onStart` when long-polling begins. */
  readonly startTimeoutMs?: number;
}): Promise<TelegramDispatcher | null> {
  const log = args.log.child({ component: "telegram-dispatcher" });

  const config = await (async () => {
    try {
      return await loadTelegramRuntimeConfig(args.secrets);
    } catch (err) {
      if (err instanceof TelegramConfigError) {
        log.warn(
          { err: err.message },
          "telegram dispatcher disabled: config incomplete (set TELEGRAM_CHAT_ID + telegram-bot-token WCM secret)",
        );
        return null;
      }
      log.warn({ err }, "telegram dispatcher disabled: failed to load config");
      return null;
    }
  })();
  if (config === null) return null;

  const chatId = Number(config.chatId);
  if (!Number.isFinite(chatId)) {
    log.warn(
      { chatId: config.chatId },
      "telegram dispatcher disabled: chat id is not numeric",
    );
    return null;
  }

  const bot: Bot = createTelegramBot(config, {
    log,
    onStatus: args.handlers.onStatus,
    onApprove: async (payload) => {
      const journalId = decodeJournalSignalId(payload.signalId);
      if (journalId === null) {
        log.warn({ payload }, "ignoring approve callback with unknown signalId");
        return;
      }
      const priorEntry = args.handlers.lookupEntry(journalId);
      const result = args.handlers.recordDecision(journalId, "approved");
      if (result.changed) {
        const nowMs = Date.now();
        if (priorEntry?.telegramMessageId != null) {
          try {
            await bot.api.editMessageText(
              chatId,
              priorEntry.telegramMessageId,
              renderDecisionUpdate({
                journalId,
                entry: priorEntry,
                decision: "approved",
                nowMs,
              }),
            );
          } catch (err) {
            log.warn({ err, journalId }, "failed to edit approved telegram message");
          }
        }
      }
      await args.handlers.onDecision({
        journalId,
        decision: "approved",
        chatId,
        priorStatus: result.priorStatus,
        changed: result.changed,
      });
    },
    onReject: async (payload) => {
      const journalId = decodeJournalSignalId(payload.signalId);
      if (journalId === null) {
        log.warn({ payload }, "ignoring reject callback with unknown signalId");
        return;
      }
      const priorEntry = args.handlers.lookupEntry(journalId);
      const result = args.handlers.recordDecision(journalId, "rejected");
      if (result.changed && priorEntry?.telegramMessageId != null) {
        try {
          await bot.api.editMessageText(
            chatId,
            priorEntry.telegramMessageId,
            renderDecisionUpdate({
              journalId,
              entry: priorEntry,
              decision: "rejected",
              nowMs: Date.now(),
            }),
          );
        } catch (err) {
          log.warn({ err, journalId }, "failed to edit rejected telegram message");
        }
      }
      await args.handlers.onDecision({
        journalId,
        decision: "rejected",
        chatId,
        priorStatus: result.priorStatus,
        changed: result.changed,
      });
    },
  });

  const startTimeoutMs = args.startTimeoutMs ?? 5000;
  const startDone = new Promise<void>((resolve, reject) => {
    bot
      .start({
        drop_pending_updates: true,
        onStart: () => resolve(),
      })
      .catch((err: unknown) => reject(err));
  });

  try {
    await Promise.race([
      startDone,
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`grammY did not emit onStart within ${startTimeoutMs}ms`)),
          startTimeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    log.warn({ err }, "telegram dispatcher disabled: bot failed to start");
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    return null;
  }

  log.info({ chatId }, "telegram dispatcher online");

  return {
    chatId,
    async sendApprovalCard({ journalId, plan, review, conflicts }) {
      const signalId = encodeJournalSignalId(journalId);
      const issuedAtMs = Date.now();
      const keyboard = new InlineKeyboard()
        .text(
          "Approve",
          encodeApprovalCallbackData({ action: "approve", signalId, issuedAtMs }),
        )
        .text(
          "Reject",
          encodeApprovalCallbackData({ action: "reject", signalId, issuedAtMs }),
        );
      const text = renderPlanCard({ journalId, plan, review, conflicts });
      const message = await bot.api.sendMessage(chatId, text, {
        reply_markup: keyboard,
      });
      return { chatId, messageId: message.message_id };
    },
    async stop() {
      try {
        await bot.stop();
      } catch (err) {
        log.warn({ err }, "telegram dispatcher stop error (ignored)");
      }
    },
  };
}
