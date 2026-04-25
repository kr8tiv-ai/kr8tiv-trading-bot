import { describe, expect, it } from "vitest";
import { parseHistoryIngestArgs } from "./history-ingest.js";

describe("history-ingest args", () => {
  it("parses safe defaults and explicit BTC/ETH/SOL futures options", () => {
    expect(
      parseHistoryIngestArgs([
        "--symbols",
        "BTCUSDT,ETHUSDT",
        "--days",
        "30",
        "--limit",
        "50",
        "--max-pages",
        "3",
        "--json",
      ]),
    ).toMatchObject({
      symbols: ["BTCUSDT", "ETHUSDT"],
      days: 30,
      limit: 50,
      maxPages: 3,
      json: true,
    });
  });

  it("rejects unsupported futures symbols", () => {
    expect(() => parseHistoryIngestArgs(["--symbols", "DOGEUSDT"])).toThrow(
      "unsupported futures symbol",
    );
  });
});
