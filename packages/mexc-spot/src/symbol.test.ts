import { describe, expect, it } from "vitest";
import {
  toCcxtSymbol,
  mexcSymbolFromCcxt,
  ALLOWED_MEXC_SYMBOLS,
} from "./symbol.js";

describe("toCcxtSymbol", () => {
  it("maps ETHUSDT -> ETH/USDT", () => {
    expect(toCcxtSymbol("ETHUSDT")).toBe("ETH/USDT");
  });

  it("throws 'pair not whitelisted' for BTCUSDT, DOGEUSDT, SOLUSDT, empty", () => {
    for (const bad of ["BTCUSDT", "DOGEUSDT", "SOLUSDT", ""]) {
      expect(() => toCcxtSymbol(bad)).toThrow(/pair not whitelisted/i);
    }
  });

  it("throws on common typos (eth/usdt already-ccxt-format, lowercase)", () => {
    expect(() => toCcxtSymbol("ETH/USDT")).toThrow(/pair not whitelisted/i);
    expect(() => toCcxtSymbol("ethusdt")).toThrow(/pair not whitelisted/i);
  });

  it("ALLOWED_MEXC_SYMBOLS contains exactly ETHUSDT in Phase 2", () => {
    expect(ALLOWED_MEXC_SYMBOLS).toEqual(["ETHUSDT"]);
  });
});

describe("mexcSymbolFromCcxt", () => {
  it("maps ETH/USDT -> ETHUSDT", () => {
    expect(mexcSymbolFromCcxt("ETH/USDT")).toBe("ETHUSDT");
  });

  it("throws 'pair not whitelisted' for unknown ccxt symbols", () => {
    for (const bad of ["BTC/USDT", "DOGE/USDT", "SOL/USDT", "ETHUSDT", ""]) {
      expect(() => mexcSymbolFromCcxt(bad)).toThrow(/pair not whitelisted/i);
    }
  });

  it("round-trips ETHUSDT through toCcxtSymbol + back", () => {
    expect(mexcSymbolFromCcxt(toCcxtSymbol("ETHUSDT"))).toBe("ETHUSDT");
  });
});
