import ccxt, { type Exchange } from "ccxt";
import { env } from "@kr8tiv/config";
import { unsafeReveal, type SecretProvider } from "@kr8tiv/secrets";
import {
  MexcBalanceResponseSchema,
  MexcPingResponseSchema,
  type AccountInfo,
} from "@kr8tiv/shared-schemas";

export interface MEXCSpotClientConfig {
  /** SecretProvider that has mexc-spot-access + mexc-spot-secret provisioned. */
  secrets: SecretProvider;
  /** Override for tests. Defaults to env.MEXC_SPOT_BASE_URL. */
  baseUrl?: string;
  /** Override for tests. Defaults to env.MEXC_RECV_WINDOW_MS. */
  recvWindowMs?: number;
}

/**
 * Read-only MEXC spot client.
 *
 * Phase 1 scope:
 * - ping() for boot-time connectivity smoke test
 * - getAccountInfo() for FND-06 verification (returns Zod-validated balance)
 *
 * Phase 2 will add write-path methods (placeMarketBuy, placeLimitSell, cancelOrder, etc.)
 * DO NOT add order-placement here.
 */
export class MEXCSpotClient {
  // Exposed read-only for tests that poke at options.defaultType without going
  // through CCXT's public API. Downstream code should NOT use this to place
  // orders — that's Phase 2.
  readonly exchange: Exchange;

  private constructor(exchange: Exchange) {
    this.exchange = exchange;
  }

  static async create(config: MEXCSpotClientConfig): Promise<MEXCSpotClient> {
    const baseUrl = config.baseUrl ?? env.MEXC_SPOT_BASE_URL;
    const recvWindow = config.recvWindowMs ?? env.MEXC_RECV_WINDOW_MS;

    const [accessSecret, secretSecret] = await Promise.all([
      config.secrets.get("mexc-spot-access"),
      config.secrets.get("mexc-spot-secret"),
    ]);

    const exchange = new ccxt.mexc({
      apiKey: unsafeReveal(accessSecret),
      secret: unsafeReveal(secretSecret),
      enableRateLimit: true,
      timeout: 10_000,
      options: {
        defaultType: "spot",
        recvWindow,
      },
      urls: {
        api: {
          spot: baseUrl,
          spotPublic: baseUrl,
          spotPrivate: baseUrl,
        },
      },
    } as ConstructorParameters<typeof ccxt.mexc>[0]) as Exchange;

    return new MEXCSpotClient(exchange);
  }

  /**
   * FND-08 smoke-test support. Hits public MEXC `/api/v3/time` (no auth needed).
   * CCXT does not expose a unified ping for every exchange, so we use the
   * implicit method or raw fetch as a fallback.
   *
   * Returns `{ serverTime: number }` after Zod parse.
   */
  async ping(): Promise<{ serverTime: number }> {
    // CCXT's MEXC integration exposes `publicGetTime` as an implicit method.
    // Per 01-RESEARCH.md Open Question 2, exact method names can drift; guard with fallback.
    let raw: unknown;
    // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
    const implicit = (this.exchange as any).publicGetTime;
    if (typeof implicit === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: CCXT implicit methods aren't typed
      raw = await (this.exchange as any).publicGetTime();
    } else {
      // Fallback: raw fetch against the configured base URL.
      const url = `${env.MEXC_SPOT_BASE_URL}/api/v3/time`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`MEXC spot /time failed: HTTP ${resp.status}`);
      raw = await resp.json();
    }
    return MexcPingResponseSchema.parse(raw);
  }

  /**
   * Read-only: fetch spot account balances via CCXT's unified method.
   * Parsed through Zod — malformed responses throw at the boundary, not
   * silently at the executor.
   */
  async getAccountInfo(): Promise<AccountInfo> {
    const raw = await this.exchange.fetchBalance({ type: "spot" });
    return MexcBalanceResponseSchema.parse(raw);
  }

  // NO order-placement methods here. Phase 2 adds placeMarketBuy etc.
}
