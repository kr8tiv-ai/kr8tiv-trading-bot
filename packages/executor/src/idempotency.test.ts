import { describe, expect, it } from "vitest";
import { makeClientOrderId } from "./idempotency.js";

describe("makeClientOrderId", () => {
  it("returns a 32-char hex string", () => {
    const coid = makeClientOrderId("deadbeef-uuid", 1700000000000);
    expect(coid).toHaveLength(32);
    expect(coid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic — same inputs produce the same output", () => {
    const a = makeClientOrderId("signal-abc", 1700000000000);
    const b = makeClientOrderId("signal-abc", 1700000000000);
    const c = makeClientOrderId("signal-abc", 1700000000000);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("produces different outputs for different signalIds", () => {
    const a = makeClientOrderId("signal-a", 1700000000000);
    const b = makeClientOrderId("signal-b", 1700000000000);
    expect(a).not.toBe(b);
  });

  it("produces different outputs for different approvalTsMs values", () => {
    const a = makeClientOrderId("signal-shared", 1700000000000);
    const b = makeClientOrderId("signal-shared", 1700000000001);
    expect(a).not.toBe(b);
  });

  it("output contains only [0-9a-f] lowercase hex characters", () => {
    const samples = [
      makeClientOrderId("u1", 1),
      makeClientOrderId("uuid-with-dashes-1234", 1700000000000),
      makeClientOrderId("", 0),
      makeClientOrderId("!@#$%^&*()", 999_999_999_999),
    ];
    for (const s of samples) {
      expect(s).toHaveLength(32);
      expect(s).toMatch(/^[0-9a-f]+$/);
    }
  });
});
