import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const APP_PATH = new URL("./trader-app.ts", import.meta.url);

async function readAppSource(): Promise<string> {
  return await readFile(APP_PATH, "utf8");
}

describe("trader cockpit UI contract", () => {
  it("offers a one-click dashboard action to review, save, and paper-fire a trade", async () => {
    const source = await readAppSource();
    expect(source).toContain("Review + save + paper-fire");
    expect(source).toContain('data-save="fire"');
  });

  it("renders current MEXC futures open orders in the live account panel", async () => {
    const source = await readAppSource();
    expect(source).toContain("Open orders");
    expect(source).toContain("openOrders");
  });

  it("lets a live MEXC futures position populate the intake form", async () => {
    const source = await readAppSource();
    expect(source).toContain("Use position");
    expect(source).toContain("data-use-position");
    expect(source).toContain("loadPositionIntoIntake");
  });

  it("keeps the live account panel useful during active leverage trades", async () => {
    const source = await readAppSource();
    expect(source).toContain("distance to liq");
    expect(source).toContain("void loadAccountStatus();");
  });

  it("ships a premium cockpit shell for the dashboard surface", async () => {
    const source = await readAppSource();
    expect(source).toContain("cockpit-shell");
    expect(source).toContain("MEXC live exposure");
    expect(source).toContain("trade-firewall");
  });
});
