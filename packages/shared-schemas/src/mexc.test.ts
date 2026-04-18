import { describe, expect, it } from "vitest";
import {
  MexcBalanceResponseSchema,
  MexcFuturesPingSchema,
  MexcPingResponseSchema,
  MexcSpotTimeSchema,
} from "./mexc.js";

describe("MexcSpotTimeSchema", () => {
  it("accepts a positive integer serverTime", () => {
    expect(MexcSpotTimeSchema.parse({ serverTime: 1645539742000 })).toEqual({
      serverTime: 1645539742000,
    });
  });
  it("rejects non-number serverTime", () => {
    expect(() => MexcSpotTimeSchema.parse({ serverTime: "x" })).toThrow();
  });
  it("rejects negative serverTime", () => {
    expect(() => MexcSpotTimeSchema.parse({ serverTime: -1 })).toThrow();
  });
});

describe("MexcFuturesPingSchema", () => {
  it("accepts { success: true, code: 0, data: timestamp }", () => {
    const v = MexcFuturesPingSchema.parse({
      success: true,
      code: 0,
      data: 1645539742000,
    });
    expect(v.success).toBe(true);
    expect(v.data).toBe(1645539742000);
  });
  it("accepts success:false (caller decides what to do)", () => {
    expect(() =>
      MexcFuturesPingSchema.parse({ success: false, code: 0, data: 1 }),
    ).not.toThrow();
  });
  it("rejects missing data", () => {
    expect(() =>
      MexcFuturesPingSchema.parse({ success: true, code: 0 }),
    ).toThrow();
  });
});

describe("MexcPingResponseSchema", () => {
  it("accepts { serverTime: number }", () => {
    expect(MexcPingResponseSchema.parse({ serverTime: 123 })).toEqual({
      serverTime: 123,
    });
  });
});

describe("MexcBalanceResponseSchema", () => {
  it("accepts the four required fields (info, total, free, used)", () => {
    const bal = MexcBalanceResponseSchema.parse({
      info: {},
      total: { USDT: 10 },
      free: { USDT: 10 },
      used: { USDT: 0 },
    });
    expect(bal.total.USDT).toBe(10);
  });
  it("rejects when total/free/used are missing", () => {
    expect(() => MexcBalanceResponseSchema.parse({ info: {} })).toThrow();
  });
});
