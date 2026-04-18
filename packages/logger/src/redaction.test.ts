import { describe, expect, it } from "vitest";
import pino from "pino";
import { REDACTION_PATHS } from "./index.js";

/**
 * Create a logger that writes to an in-memory buffer (no pino-pretty transport).
 * Returns the logger and an array of captured JSON strings.
 */
function captureLogger() {
  const entries: string[] = [];
  const stream = {
    write(chunk: string): number {
      entries.push(chunk);
      return chunk.length;
    },
  };
  const log = pino(
    {
      redact: { paths: [...REDACTION_PATHS], censor: "[REDACTED]" },
      level: "trace",
    },
    stream as unknown as NodeJS.WritableStream,
  );
  return { log, entries };
}

describe("pino redaction", () => {
  it("redacts top-level apiKey", () => {
    const { log, entries } = captureLogger();
    log.info({ apiKey: "mx0secretkey1234567890" }, "test");
    const parsed = JSON.parse(entries[0] ?? "") as { apiKey: unknown };
    expect(parsed.apiKey).toBe("[REDACTED]");
  });

  it("redacts top-level secret, password, token, apiSecret", () => {
    const { log, entries } = captureLogger();
    log.info({ secret: "s", password: "p", token: "t", apiSecret: "as" });
    const parsed = JSON.parse(entries[0] ?? "") as Record<string, unknown>;
    expect(parsed.secret).toBe("[REDACTED]");
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.apiSecret).toBe("[REDACTED]");
  });

  it("redacts x-mexc-apikey, x-mexc-signature, authorization request headers", () => {
    const { log, entries } = captureLogger();
    log.info({
      req: {
        headers: {
          "x-mexc-apikey": "mx0xxxx",
          "x-mexc-signature": "sigstring",
          authorization: "Bearer tokentokentoken",
        },
      },
    });
    const parsed = JSON.parse(entries[0] ?? "") as {
      req: { headers: Record<string, unknown> };
    };
    expect(parsed.req.headers["x-mexc-apikey"]).toBe("[REDACTED]");
    expect(parsed.req.headers["x-mexc-signature"]).toBe("[REDACTED]");
    expect(parsed.req.headers.authorization).toBe("[REDACTED]");
  });

  it("redacts nested mexc.apiKey and mexc.secret", () => {
    const { log, entries } = captureLogger();
    log.info({ mexc: { apiKey: "mx0xxxx", secret: "hexhexhex" } });
    const parsed = JSON.parse(entries[0] ?? "") as {
      mexc: Record<string, unknown>;
    };
    expect(parsed.mexc.apiKey).toBe("[REDACTED]");
    expect(parsed.mexc.secret).toBe("[REDACTED]");
  });

  it("redacts telegramToken and *.telegramToken", () => {
    const { log, entries } = captureLogger();
    log.info({ telegramToken: "1234567890:abc", inner: { telegramToken: "x" } });
    const parsed = JSON.parse(entries[0] ?? "") as {
      telegramToken: unknown;
      inner: { telegramToken: unknown };
    };
    expect(parsed.telegramToken).toBe("[REDACTED]");
    expect(parsed.inner.telegramToken).toBe("[REDACTED]");
  });

  it("redacts walletAddress (Phase 7 scaffold)", () => {
    const { log, entries } = captureLogger();
    log.info({ walletAddress: "0xdeadbeef..." });
    const parsed = JSON.parse(entries[0] ?? "") as { walletAddress: unknown };
    expect(parsed.walletAddress).toBe("[REDACTED]");
  });

  it("redacts *.walletAddress (nested)", () => {
    const { log, entries } = captureLogger();
    log.info({ user: { walletAddress: "0xabc" } });
    const parsed = JSON.parse(entries[0] ?? "") as {
      user: { walletAddress: unknown };
    };
    expect(parsed.user.walletAddress).toBe("[REDACTED]");
  });

  it("leaves unrelated string fields unchanged", () => {
    const { log, entries } = captureLogger();
    log.info({ user: { name: "matt" }, note: "hello" });
    const parsed = JSON.parse(entries[0] ?? "") as {
      user: { name: unknown };
      note: unknown;
    };
    expect(parsed.user.name).toBe("matt");
    expect(parsed.note).toBe("hello");
  });

  it("redacts config.apiKey, config.secret, config.headers (axios error-echo shapes)", () => {
    const { log, entries } = captureLogger();
    log.info({
      config: { apiKey: "k", secret: "s", headers: { foo: "bar" } },
    });
    const parsed = JSON.parse(entries[0] ?? "") as {
      config: Record<string, unknown>;
    };
    expect(parsed.config.apiKey).toBe("[REDACTED]");
    expect(parsed.config.secret).toBe("[REDACTED]");
    expect(parsed.config.headers).toBe("[REDACTED]");
  });

  it("redacts deep-nested secret via **.secret", () => {
    const { log, entries } = captureLogger();
    log.info({ a: { b: { c: { secret: "nested" } } } });
    const parsed = JSON.parse(entries[0] ?? "") as {
      a: { b: { c: { secret: unknown } } };
    };
    expect(parsed.a.b.c.secret).toBe("[REDACTED]");
  });

  it("redacts *.key generic pattern", () => {
    const { log, entries } = captureLogger();
    log.info({ obj: { key: "abc" } });
    const parsed = JSON.parse(entries[0] ?? "") as {
      obj: { key: unknown };
    };
    expect(parsed.obj.key).toBe("[REDACTED]");
  });

  it("redacts res.headers['set-cookie']", () => {
    const { log, entries } = captureLogger();
    log.info({ res: { headers: { "set-cookie": ["sessionid=xxx"] } } });
    const parsed = JSON.parse(entries[0] ?? "") as {
      res: { headers: Record<string, unknown> };
    };
    expect(parsed.res.headers["set-cookie"]).toBe("[REDACTED]");
  });
});
