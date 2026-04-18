// scripts/verify-env.ts
// Run via: pnpm verify-env
// Asserts: (1) env vars parse through the Zod schema, (2) all Phase 1 required secrets exist.

import { env } from "@kr8tiv/config";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import type { SecretName } from "@kr8tiv/shared-types";

const REQUIRED: readonly SecretName[] = [
  "mexc-spot-access",
  "mexc-spot-secret",
  "mexc-whitelist-ip",
];

async function main(): Promise<void> {
  // Step 1 — env parse
  process.stdout.write("=== env ===\n");
  process.stdout.write(`NODE_ENV              = ${env.NODE_ENV}\n`);
  process.stdout.write(`MEXC_SPOT_BASE_URL    = ${env.MEXC_SPOT_BASE_URL}\n`);
  process.stdout.write(`MEXC_FUTURES_BASE_URL = ${env.MEXC_FUTURES_BASE_URL}\n`);
  process.stdout.write(`MEXC_RECV_WINDOW_MS   = ${env.MEXC_RECV_WINDOW_MS}\n`);
  process.stdout.write(`REDIS_URL             = ${env.REDIS_URL.replace(/\/\/[^@]*@/, "//***@")}\n`);
  process.stdout.write(`SQLITE_PATH           = ${env.SQLITE_PATH}\n`);
  process.stdout.write(`LOG_LEVEL             = ${env.LOG_LEVEL}\n`);
  process.stdout.write(`LOG_PRETTY            = ${env.LOG_PRETTY}\n`);

  // Step 2 — secrets present
  process.stdout.write("\n=== Windows Credential Manager ===\n");
  const provider = new WindowsCredentialManagerProvider();
  const results = await Promise.all(
    REQUIRED.map(async (n) => ({ n, ok: await provider.has(n) })),
  );
  for (const r of results) {
    const marker = r.ok ? "[OK]" : "[MISSING]";
    process.stdout.write(`${marker}   kr8tiv-mexc-bot/${r.n}\n`);
  }
  const missing = results.filter((x) => !x.ok).map((x) => x.n);
  if (missing.length > 0) {
    process.stderr.write(`\nMissing: ${missing.join(", ")}\n`);
    process.stderr.write("Fix: pnpm setup:credentials\n");
    process.exit(1);
  }
  process.stdout.write("\nAll Phase 1 prerequisites satisfied.\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`verify-env failed: ${String(err)}\n`);
  process.exit(1);
});
