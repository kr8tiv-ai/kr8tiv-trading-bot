import { Bot, type Context } from "grammy";
import type { TelegramApprovalCallback } from "@kr8tiv/shared-schemas";
import type { Logger } from "pino";
import { decodeApprovalCallbackData } from "./callbacks.js";
import type { TelegramRuntimeConfig } from "./config.js";
import { isWhitelistedChat } from "./policies.js";

export type TelegramDecisionHandler = (
  payload: TelegramApprovalCallback,
) => Promise<void>;

export interface TelegramRuntimeHandlers {
  readonly onApprove: TelegramDecisionHandler;
  readonly onReject: TelegramDecisionHandler;
  readonly onStatus: () => Promise<string>;
  readonly onPanic?: () => Promise<string>;
  readonly log: Logger;
}

export function createTelegramBot(
  config: TelegramRuntimeConfig,
  handlers: TelegramRuntimeHandlers,
): Bot<Context> {
  const bot = new Bot<Context>(config.botToken);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!isWhitelistedChat(chatId, config.chatId)) {
      return;
    }
    await next();
  });

  bot.command("status", async (ctx) => {
    await ctx.reply(await handlers.onStatus());
  });

  bot.command("panic", async (ctx) => {
    const text = handlers.onPanic
      ? await handlers.onPanic()
      : "panic command not wired yet";
    await ctx.reply(text);
  });

  bot.callbackQuery(/^ap1:/, async (ctx) => {
    void ctx.answerCallbackQuery().catch((err: unknown) => {
      handlers.log.warn({ err }, "telegram: answerCallbackQuery failed");
    });

    const payload = decodeApprovalCallbackData(ctx.callbackQuery.data);
    if (payload === null) {
      handlers.log.warn(
        { data: ctx.callbackQuery.data },
        "telegram: invalid callback payload",
      );
      return;
    }

    if (payload.action === "approve") {
      await handlers.onApprove(payload);
      return;
    }
    await handlers.onReject(payload);
  });

  return bot;
}
