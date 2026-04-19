import { describe, expect, it, vi } from "vitest";
import {
  parseArgs,
  runPipeline,
  type PlaceOrderArgs,
  type XAddableRedis,
} from "./place-order.js";

describe("parseArgs", () => {
  it("parses --side buy --notional 5", () => {
    expect(parseArgs(["--side", "buy", "--notional", "5"])).toEqual({
      side: "buy",
      notional: 5,
    });
  });

  it("parses --side sell --notional 3.5 (fractional notional)", () => {
    expect(parseArgs(["--side", "sell", "--notional", "3.5"])).toEqual({
      side: "sell",
      notional: 3.5,
    });
  });

  it("parses flags in reverse order", () => {
    expect(parseArgs(["--notional", "5", "--side", "buy"])).toEqual({
      side: "buy",
      notional: 5,
    });
  });

  it("throws on missing --side", () => {
    expect(() => parseArgs(["--notional", "5"])).toThrow(/side/i);
  });

  it("throws on missing --notional", () => {
    expect(() => parseArgs(["--side", "buy"])).toThrow(/notional/i);
  });

  it("throws on invalid --side value", () => {
    expect(() => parseArgs(["--side", "hodl", "--notional", "5"])).toThrow(
      /buy.*sell/,
    );
  });

  it("throws on non-positive --notional (zero)", () => {
    expect(() => parseArgs(["--side", "buy", "--notional", "0"])).toThrow(
      /positive/,
    );
  });

  it("throws on non-positive --notional (negative)", () => {
    expect(() => parseArgs(["--side", "buy", "--notional", "-1"])).toThrow(
      /positive/,
    );
  });

  it("throws on non-numeric --notional", () => {
    expect(() => parseArgs(["--side", "buy", "--notional", "abc"])).toThrow(
      /positive/,
    );
  });
});

/**
 * Utility: find the index of a field name in an ioredis xadd flat-KV call.
 * Redis xadd args are: [stream, "MAXLEN", "~", "1000", "*", k1, v1, k2, v2, ...].
 * Used in place of a full parser since we only need to read specific field
 * values for assertions.
 */
function findFieldValue(call: readonly string[], field: string): string | undefined {
  const idx = call.indexOf(field);
  if (idx < 0) return undefined;
  return call[idx + 1];
}

describe("runPipeline", () => {
  const validArgs: PlaceOrderArgs = { side: "buy", notional: 5 };

  function makeRedis(): {
    redis: XAddableRedis;
    xadd: ReturnType<typeof vi.fn>;
  } {
    const xadd = vi.fn().mockResolvedValue("1-0");
    return { redis: { xadd } as XAddableRedis, xadd };
  }

  it("emits 4 XADDs in pipeline order (candidate → filtered → pending → decided)", async () => {
    const { redis, xadd } = makeRedis();
    await runPipeline(redis, validArgs);

    expect(xadd).toHaveBeenCalledTimes(4);
    expect(xadd.mock.calls[0]![0]).toBe("signals.candidate");
    expect(xadd.mock.calls[1]![0]).toBe("signals.filtered");
    expect(xadd.mock.calls[2]![0]).toBe("approvals.pending");
    expect(xadd.mock.calls[3]![0]).toBe("approvals.decided");
  });

  it("every XADD includes MAXLEN ~ 1000 (Pitfall 4 defense)", async () => {
    const { redis, xadd } = makeRedis();
    await runPipeline(redis, validArgs);

    for (const call of xadd.mock.calls as unknown as readonly (readonly string[])[]) {
      const maxlenIdx = call.indexOf("MAXLEN");
      expect(maxlenIdx).toBeGreaterThanOrEqual(0);
      expect(call[maxlenIdx + 1]).toBe("~");
      expect(call[maxlenIdx + 2]).toBe("1000");
    }
  });

  it("every XADD uses '*' as the entry ID (let Redis assign)", async () => {
    const { redis, xadd } = makeRedis();
    await runPipeline(redis, validArgs);

    for (const call of xadd.mock.calls as unknown as readonly (readonly string[])[]) {
      // MAXLEN ~ 1000 is positions 1-3; * is position 4 (stream name is 0).
      expect(call[4]).toBe("*");
    }
  });

  it("all 4 XADDs reference the SAME signal_id (propagates through pipeline)", async () => {
    const { redis, xadd } = makeRedis();
    const result = await runPipeline(redis, validArgs);

    const signalIds = (
      xadd.mock.calls as unknown as readonly (readonly string[])[]
    ).map((c) => findFieldValue(c, "signal_id"));

    expect(signalIds).toHaveLength(4);
    expect(new Set(signalIds).size).toBe(1);
    expect(signalIds[0]).toBe(result.signalId);
    // UUID v4: 36-char, 8-4-4-4-12 hex
    expect(result.signalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("signals.candidate carries pair, side, notional_usdt, source='test-harness'", async () => {
    const { redis, xadd } = makeRedis();
    await runPipeline(redis, validArgs);

    const candidateCall = xadd.mock.calls[0] as unknown as readonly string[];
    expect(findFieldValue(candidateCall, "pair")).toBe("ETHUSDT");
    expect(findFieldValue(candidateCall, "side")).toBe("buy");
    expect(findFieldValue(candidateCall, "notional_usdt")).toBe("5");
    expect(findFieldValue(candidateCall, "source")).toBe("test-harness");
    expect(findFieldValue(candidateCall, "ts")).toBeDefined();
  });

  it("signals.filtered carries filter_result=pass (news-veto passthrough)", async () => {
    const { redis, xadd } = makeRedis();
    await runPipeline(redis, validArgs);

    const filteredCall = xadd.mock.calls[1] as unknown as readonly string[];
    expect(findFieldValue(filteredCall, "filter_result")).toBe("pass");
  });

  it("approvals.pending carries approval_timeout_ms=90000 (matches Phase 3 planned TTL)", async () => {
    const { redis, xadd } = makeRedis();
    await runPipeline(redis, validArgs);

    const pendingCall = xadd.mock.calls[2] as unknown as readonly string[];
    expect(findFieldValue(pendingCall, "approval_timeout_ms")).toBe("90000");
  });

  it("approvals.decided carries approved=true, pair, side, notional_usdt, approval_ts", async () => {
    const { redis, xadd } = makeRedis();
    const result = await runPipeline(redis, validArgs);

    const decidedCall = xadd.mock.calls[3] as unknown as readonly string[];
    expect(findFieldValue(decidedCall, "approved")).toBe("true");
    expect(findFieldValue(decidedCall, "pair")).toBe("ETHUSDT");
    expect(findFieldValue(decidedCall, "side")).toBe("buy");
    expect(findFieldValue(decidedCall, "notional_usdt")).toBe("5");
    expect(findFieldValue(decidedCall, "approval_ts")).toBe(
      String(result.approvalTsMs),
    );
  });

  it("side='sell' propagates through candidate + decided stages", async () => {
    const { redis, xadd } = makeRedis();
    await runPipeline(redis, { side: "sell", notional: 3 });

    const candidateCall = xadd.mock.calls[0] as unknown as readonly string[];
    const decidedCall = xadd.mock.calls[3] as unknown as readonly string[];

    expect(findFieldValue(candidateCall, "side")).toBe("sell");
    expect(findFieldValue(decidedCall, "side")).toBe("sell");
    expect(findFieldValue(candidateCall, "notional_usdt")).toBe("3");
    expect(findFieldValue(decidedCall, "notional_usdt")).toBe("3");
  });

  it("returns stream IDs for all 4 stages", async () => {
    const xadd = vi
      .fn()
      .mockResolvedValueOnce("1-0")
      .mockResolvedValueOnce("2-0")
      .mockResolvedValueOnce("3-0")
      .mockResolvedValueOnce("4-0");
    const redis = { xadd } as XAddableRedis;

    const result = await runPipeline(redis, validArgs);
    expect(result.streamIds).toEqual({
      candidate: "1-0",
      filtered: "2-0",
      pending: "3-0",
      decided: "4-0",
    });
  });

  it("propagates xadd rejection (e.g. Redis down mid-pipeline)", async () => {
    const xadd = vi
      .fn()
      .mockResolvedValueOnce("1-0")
      .mockRejectedValueOnce(new Error("redis down"));
    const redis = { xadd } as XAddableRedis;

    await expect(runPipeline(redis, validArgs)).rejects.toThrow(/redis down/);
    // Remaining stages never fire
    expect(xadd).toHaveBeenCalledTimes(2);
  });

  it("generates a fresh signal_id per invocation (non-deterministic UUID v4)", async () => {
    const { redis } = makeRedis();
    const r1 = await runPipeline(redis, validArgs);
    const r2 = await runPipeline(redis, validArgs);
    expect(r1.signalId).not.toBe(r2.signalId);
  });

  it("approvalTsMs is >= the ts of the candidate stage (pipeline ordering)", async () => {
    const { redis, xadd } = makeRedis();
    const result = await runPipeline(redis, validArgs);

    const candidateCall = xadd.mock.calls[0] as unknown as readonly string[];
    const candidateTs = Number(findFieldValue(candidateCall, "ts"));
    expect(Number.isFinite(candidateTs)).toBe(true);
    expect(result.approvalTsMs).toBeGreaterThanOrEqual(candidateTs);
  });
});
