// scripts/setup-credentials.ts
// Run via: pnpm setup:credentials
// Prompts for each Phase 1 required secret and writes to Windows Credential Manager.

import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import type { SecretName } from "@kr8tiv/shared-types";

const REQUIRED: readonly SecretName[] = [
  "mexc-spot-access",
  "mexc-spot-secret",
  "mexc-whitelist-ip",
];
const OPTIONAL_CURRENT: readonly SecretName[] = [
  // Needed for the futures dashboard to read live positions/open orders.
  "mexc-futures-access",
  "mexc-futures-secret",
  // Needed only if Telegram dispatch is enabled.
  "telegram-bot-token",
];

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const provider = new WindowsCredentialManagerProvider();

  process.stdout.write("kr8tiv-mexc-bot - credential setup\n");
  process.stdout.write("Writes directly to Windows Credential Manager.\n");
  process.stdout.write("Press Enter on a name to skip it (keeps existing value if any).\n\n");

  for (const name of REQUIRED) {
    const exists = await provider.has(name);
    const prompt = exists
      ? `${name}  [already set - enter to keep, paste new value to replace]: `
      : `${name}  [not set - paste value]: `;
    const value = (await rl.question(prompt)).trim();
    if (value.length === 0) {
      process.stdout.write(exists ? "  (kept)\n" : "  (skipped - still missing)\n");
      continue;
    }
    await provider.set(name, value);
    process.stdout.write(`  (set ${value.length} chars)\n`);
  }

  process.stdout.write(
    "\nOptional current integrations (safe to skip; features degrade read-only/offline)\n",
  );
  for (const name of OPTIONAL_CURRENT) {
    const exists = await provider.has(name);
    const prompt = exists
      ? `${name}  [already set - enter to keep, paste new value to replace]: `
      : `${name}  [optional - paste value or Enter to skip]: `;
    const value = (await rl.question(prompt)).trim();
    if (value.length === 0) {
      process.stdout.write(exists ? "  (kept)\n" : "  (skipped - still optional)\n");
      continue;
    }
    await provider.set(name, value);
    process.stdout.write(`  (set ${value.length} chars)\n`);
  }

  rl.close();

  const results = await Promise.all(REQUIRED.map(async (n) => ({ n, ok: await provider.has(n) })));
  const missing = results.filter((x) => !x.ok).map((x) => x.n);

  if (missing.length > 0) {
    process.stderr.write(`\nMissing secrets: ${missing.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write("\nAll required Phase 1 secrets provisioned.\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`setup-credentials failed: ${String(err)}\n`);
  process.exit(1);
});
