import ccxt, { type Exchange } from "ccxt";
import { env } from "@kr8tiv/config";
import { unsafeReveal, type SecretProvider } from "@kr8tiv/secrets";
import {
  MexcFuturesPingSchema,
  MexcPingResponseSchema,
} from "@kr8tiv/shared-schemas";

export interface MEXCFuturesClientConfig {
  secrets: SecretProvider;
  /** Override for tests. Defaults to env.MEXC_FUTURES_BASE_URL. */
  baseUrl?: string;
}

/**
 * Read-only MEXC USDT-M futures (swap) client — STUB in Phase 1.
 *
 * Phase 1 behavior:
 * - Public ping works with NO authentication (futures ping is a public endpoint).
 * - If mexc-futures-access and mexc-futures-secret are NOT provisioned in the
 *   SecretProvider (expected in Phase 1 — futures creds come in Phase 6), the
 *   client constructs with empty apiKey/secret. Private methods would fail, but
 *   no private methods exist yet.
 *
 * Phase 6 adds write-path methods (placeFuturesOrder, etc.) AND requires
 * futures credentials to be present.
 *
 * Separation invariant (Pitfall 1 defense):
 * - Own CCXT instance (separate from MEXCSpotClient) -> separate rate-limit bucket.
 * - Own base URL scope (urls.api.swap/swapPublic/swapPrivate) -> Jan 12 2026
 *   MEXC futures domain migration is a one-line env change, not a code change.
 */
export class MEXCFuturesClient {
  readonly exchange: Exchange;

  private constructor(exchange: Exchange) {
    this.exchange = exchange;
  }

  static async create(config: MEXCFuturesClientConfig): Promise<MEXCFuturesClient> {
    const baseUrl = config.baseUrl ?? env.MEXC_FUTURES_BASE_URL;

    // In Phase 1, futures credentials are expected to be absent. Public ping
    // doesn't need them. We check `.has()` instead of `.get()` to avoid throwing.
    const [hasAccess, hasSecret] = await Promise.all([
      config.secrets.has("mexc-futures-access"),
      config.secrets.has("mexc-futures-secret"),
    ]);
    const authenticated = hasAccess && hasSecret;

    const apiKey = authenticated
      ? unsafeReveal(await config.secrets.get("mexc-futures-access"))
      : "";
    const secret = authenticated
      ? unsafeReveal(await config.secrets.get("mexc-futures-secret"))
      : "";

    const exchange = new ccxt.mexc({
      apiKey,
      secret,
      enableRateLimit: true,
      timeout: 10_000,
      options: {
        defaultType: "swap",
        recvWindow: env.MEXC_RECV_WINDOW_MS,
      },
      urls: {
        api: {
          swap: baseUrl,
          swapPublic: baseUrl,
          swapPrivate: baseUrl,
        },
      },
    } as ConstructorParameters<typeof ccxt.mexc>[0]) as Exchange;

    return new MEXCFuturesClient(exchange);
  }

  /**
   * Public MEXC futures ping: GET /api/v1/contract/ping.
   * Returns `{ success, code, data }` where `data` is the server epoch ms.
   * Adapter converts to the unified `{ serverTime: number }` shape.
   *
   * Per 01-RESEARCH.md Open Question 1, CCXT's implicit method name may drift.
   * Try `contractPublicGetPing` first; fall back to raw fetch.
   */
  async ping(): Promise<{ serverTime: number }> {
    let raw: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
    const implicit = (this.exchange as any).contractPublicGetPing;
    if (typeof implicit === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
      raw = await (this.exchange as any).contractPublicGetPing();
    } else {
      const url = `${env.MEXC_FUTURES_BASE_URL}/api/v1/contract/ping`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(
          `MEXC futures /ping failed: HTTP ${resp.status} from ${url}`,
        );
      }
      raw = await resp.json();
    }

    // Parse through the futures-specific schema first, then adapt.
    const parsed = MexcFuturesPingSchema.parse(raw);
    if (!parsed.success) {
      throw new Error(
        `MEXC futures /ping returned success=false (code=${parsed.code})`,
      );
    }
    // Unified shape the boot sequence expects.
    return MexcPingResponseSchema.parse({ serverTime: parsed.data });
  }

  // NO order-placement methods here. Phase 6 adds placeFuturesOrder etc.
}
