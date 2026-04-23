import { env } from "@kr8tiv/config";
import { unsafeReveal, type SecretProvider } from "@kr8tiv/secrets";

export interface TelegramRuntimeConfig {
  readonly botToken: string;
  readonly chatId: string;
  readonly signalTtlMs: number;
  readonly dailySignalCap: number;
  readonly rejectCooldownMs: number;
  readonly maxPriceDriftBps: number;
}

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramConfigError";
  }
}

export async function loadTelegramRuntimeConfig(
  secrets: SecretProvider,
): Promise<TelegramRuntimeConfig> {
  if (!env.TELEGRAM_CHAT_ID) {
    throw new TelegramConfigError(
      "TELEGRAM_CHAT_ID is required before enabling the Telegram approval loop",
    );
  }

  const botToken = unsafeReveal(await secrets.get("telegram-bot-token"));
  if (botToken.trim().length === 0) {
    throw new TelegramConfigError("telegram-bot-token is empty");
  }

  return {
    botToken,
    chatId: env.TELEGRAM_CHAT_ID,
    signalTtlMs: env.TELEGRAM_SIGNAL_TTL_MS,
    dailySignalCap: env.TELEGRAM_DAILY_SIGNAL_CAP,
    rejectCooldownMs: env.TELEGRAM_PAIR_REJECT_COOLDOWN_MS,
    maxPriceDriftBps: env.TELEGRAM_PRICE_DRIFT_BPS,
  };
}
