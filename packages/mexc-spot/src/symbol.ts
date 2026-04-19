/**
 * MEXC spot symbol helpers — the single chokepoint for EXEC-06 pair whitelist
 * enforcement at the client boundary.
 *
 * The executor's risk manager (Plan 02-03) also enforces the whitelist — this
 * is the last line of defense before a network call, matching the "fail closed,
 * as early as possible" rule from 02-CONTEXT.md Specifics.
 *
 * Phase 2 only supports ETHUSDT per the pair-whitelist decision in STATE.md
 * Decisions. Phase 6 (futures) expands separately; Phase 4+ may add more spot
 * pairs once the signal layer justifies them.
 */

/**
 * Phase 2 spot whitelist. Phase 6 (futures) expands separately.
 * Adding a new pair = update this constant + audit risk-manager + audit
 * SQLite position tracking (currently indexes by pair).
 */
export const ALLOWED_MEXC_SYMBOLS: readonly string[] = ["ETHUSDT"] as const;

/**
 * Convert MEXC raw symbol (e.g. 'ETHUSDT') to CCXT unified format ('ETH/USDT').
 * Throws synchronously for any symbol not on the Phase 2 whitelist — this is
 * the EXEC-06 enforcement chokepoint at the MEXC client boundary.
 *
 * This function is the single source of truth for the ETHUSDT<->ETH/USDT
 * conversion. All write methods on MEXCSpotClient route through here before
 * any network call.
 */
export function toCcxtSymbol(mexcSymbol: string): string {
  if (!ALLOWED_MEXC_SYMBOLS.includes(mexcSymbol)) {
    throw new Error(`pair not whitelisted: ${mexcSymbol}`);
  }
  // Phase 2 only supports ETHUSDT; simple lookup is sufficient. Phase 6 can
  // switch to ccxt.markets[...].symbol if more pairs come online.
  if (mexcSymbol === "ETHUSDT") return "ETH/USDT";
  // Belt-and-suspenders: if someone adds a symbol to the whitelist above
  // without extending this switch, fail closed rather than returning undefined.
  throw new Error(`pair not whitelisted: ${mexcSymbol}`);
}

/**
 * Inverse conversion — for reading MEXC raw responses and normalizing back.
 * Rarely needed in Phase 2 (CCXT hands us unified symbols in responses).
 */
export function mexcSymbolFromCcxt(ccxtSymbol: string): string {
  if (ccxtSymbol === "ETH/USDT") return "ETHUSDT";
  throw new Error(`pair not whitelisted: ${ccxtSymbol}`);
}
