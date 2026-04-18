// apps/core/src/gitleaks.test.ts
// Automated FND-10 verification: prove the gitleaks pre-commit rule from
// plan 01-01 actually blocks a staged mx0... key.
//
// Strategy:
//   1. Probe PATH for `gitleaks` — skip the suite if not installed.
//   2. Create a tmpdir (mkdtempSync).
//   3. Copy the project .gitleaks.toml into the tmpdir so the custom
//      `mexc-access-key` rule applies.
//   4. git init + git add a fixture file containing a planted mx0 string.
//   5. Spawn `gitleaks protect --staged --source .` in the tmpdir.
//   6. Assert non-zero exit (hook would reject).
//   7. Repeat with innocuous content → assert zero exit.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// apps/core/src/gitleaks.test.ts → repo root is 3 levels up
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GITLEAKS_TOML = path.join(REPO_ROOT, ".gitleaks.toml");

// Probe whether gitleaks is on PATH so we can skip gracefully instead of failing.
const GITLEAKS_OK: boolean = (() => {
  const probe = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  return probe.status === 0;
})();

function git(
  cwd: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runGitleaksProtect(cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(
    "gitleaks",
    [
      "protect",
      "--staged",
      "--source",
      ".",
      "--config",
      ".gitleaks.toml",
      "--verbose",
      "--redact",
    ],
    { cwd, encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!GITLEAKS_OK)(
  "FND-10 gitleaks pre-commit hook (subprocess — requires gitleaks on PATH)",
  () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(path.join(tmpdir(), "kr8tiv-gitleaks-test-"));
      copyFileSync(GITLEAKS_TOML, path.join(tmp, ".gitleaks.toml"));
      git(tmp, "init", "--initial-branch=main");
      git(tmp, "config", "user.email", "test@example.com");
      git(tmp, "config", "user.name", "Test Runner");
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("rejects a staged file containing a planted mx0 key (exit != 0, finding = mexc-access-key)", () => {
      // Construct the planted string from parts so gitleaks scanning this test
      // file itself doesn't trip the literal pattern.
      const planted = `mx0${"testkey"}0123456789abcdef`;
      const fixture = path.join(tmp, "LEAK.txt");
      writeFileSync(fixture, `MEXC_SPOT_ACCESS=${planted}\n`);
      const addRes = git(tmp, "add", "LEAK.txt");
      expect(addRes.status).toBe(0);

      const res = runGitleaksProtect(tmp);
      expect(res.status).not.toBe(0);
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).toMatch(/mexc-access-key/);
    });

    it("allows a staged file with innocuous content (exit 0)", () => {
      const fixture = path.join(tmp, "hello.txt");
      writeFileSync(fixture, "hello world — no secrets here\n");
      const addRes = git(tmp, "add", "hello.txt");
      expect(addRes.status).toBe(0);

      const res = runGitleaksProtect(tmp);
      expect(res.status).toBe(0);
    });
  },
);

describe.skipIf(GITLEAKS_OK)(
  "FND-10 gitleaks pre-commit hook (gitleaks NOT on PATH — live suite skipped)",
  () => {
    it("(skipped) install gitleaks via `winget install gitleaks.gitleaks` to enable", () => {
      expect(GITLEAKS_OK).toBe(false);
    });
  },
);
