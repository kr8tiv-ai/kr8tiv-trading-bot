import { describe, expect, it } from "vitest";
import {
  decodeApprovalCallbackData,
  encodeApprovalCallbackData,
} from "./callbacks.js";

describe("telegram callback encoding", () => {
  it("round-trips approve payloads", () => {
    const encoded = encodeApprovalCallbackData({
      action: "approve",
      signalId: "11111111-1111-1111-1111-111111111111",
      issuedAtMs: 1_777_000_000_000,
    });

    expect(encoded.length).toBeLessThanOrEqual(64);
    expect(decodeApprovalCallbackData(encoded)).toEqual({
      version: "ap1",
      action: "approve",
      signalId: "11111111-1111-1111-1111-111111111111",
      issuedAtMs: 1_777_000_000_000,
    });
  });

  it("round-trips reject payloads", () => {
    const encoded = encodeApprovalCallbackData({
      action: "reject",
      signalId: "sig-42",
      issuedAtMs: 42,
    });

    expect(decodeApprovalCallbackData(encoded)?.action).toBe("reject");
  });

  it("returns null for malformed payloads", () => {
    expect(decodeApprovalCallbackData("nope")).toBeNull();
    expect(decodeApprovalCallbackData("ap1:x:sig:zzz")).toBeNull();
  });

  it("throws when signal id would overflow Telegram's callback_data limit", () => {
    expect(() =>
      encodeApprovalCallbackData({
        action: "approve",
        signalId: "x".repeat(80),
        issuedAtMs: 1,
      }),
    ).toThrow(/64-byte limit/i);
  });
});
