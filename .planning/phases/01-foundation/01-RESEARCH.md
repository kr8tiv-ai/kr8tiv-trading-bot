# Phase 1: Foundation - Research

**Researched:** 2026-04-17
**Domain:** Monorepo scaffold + secrets abstraction + dual-surface MEXC read client (Windows 11 local dev)
**Confidence:** HIGH

## Summary

Phase 1 is the structural spine of the project: a pnpm+Turborepo monorepo on Node 22 LTS that can safely read — but not write — both MEXC surfaces (`api.mexc.com` spot + `contract.mexc.com` futures) through Windows Credential Manager, with secret leakage made structurally impossible by three independent layers (pino redaction, gitleaks pre-commit, `Secret<T>` type wrapper). The stack is fully decided upstream in STACK.md and ARCHITECTURE.md — this phase wires it; it does not choose it.

Eleven requirements (FND-01..11) fall into four concurrent streams that can largely parallelize: (a) monorepo + DB + Redis scaffold, (b) SecretProvider + already-stored credentials, (c) two-client CCXT wrapper (spot + futures read-only), (d) pino redaction + gitleaks + boot-time smoke test. The two load-bearing invariants that must NOT be compromised: (1) **two separate CCXT instances** for spot vs futures (shared instance = shared rate bucket = Pitfall 1 in PITFALLS.md), (2) **all base URLs config-driven via `@t3-oss/env-core`+Zod** (Jan 12 2026 MEXC futures domain migration means any hardcoded URL is a ticking time bomb).

**Primary recommendation:** Six-package structure (`packages/shared-types`, `packages/shared-schemas`, `packages/secrets`, `packages/mexc-spot`, `packages/mexc-futures`, `packages/config` + `apps/core` stub). Separate CCXT instances with `options.defaultType='spot'` vs `'swap'`. SecretProvider exposes `get(name): Promise<Secret<string>>` returning a branded string type that refuses `toString()` and `JSON.stringify`. Boot sequence: env → secrets → base-URL resolution → Redis → SQLite WAL → construct spot client → construct futures client → ping both → ready. Fail-fast on any step with a clear message.

## User Constraints (from ROADMAP.md + STATE.md + PITFALLS.md — no CONTEXT.md for Phase 1)

### Locked Decisions

- **Execution venue:** MEXC only (spot + USDT-M futures), two separate API clients from day 1 (different base URLs, different auth, different rate buckets).
- **Stack:** Node 22 LTS, TypeScript 5.5+ strict, pnpm workspaces + Turborepo, CCXT 4.5.48+, Redis 7.4+ (ioredis), better-sqlite3 11.7+ (WAL + synchronous=FULL), `@zowe/secrets-for-zowe-sdk` for Windows Credential Manager, pino with redaction, gitleaks pre-commit, Zod, @t3-oss/env-core.
- **Primary topology v1:** Windows-only, no VPS. VPS failover is Phase 10.
- **Commit identity:** Matt-Aurora-Ventures `<lucidbloks@gmail.com>` — never Claude, never Kr8tiv AI, no `Co-Authored-By: Claude` lines.
- **Secrets:** Windows Credential Manager (NOT .env, NOT source). Targets already provisioned: `kr8tiv-mexc-bot/mexc-spot-access`, `kr8tiv-mexc-bot/mexc-spot-secret`, `kr8tiv-mexc-bot/mexc-whitelist-ip`.
- **Pair whitelist (downstream constraint to surface now):** ETHUSDT only for v1 (Pitfall 3 + Pitfall 15). Phase 1 should not wire BTC/SOL even read-only if it would imply they are candidates.
- **Read-only in Phase 1:** No order placement methods on either client. Write path is Phase 2 (spot) / Phase 6 (futures).
- **No paper mode:** Live $10 is the test — no paper-trading code path.

### Claude's Discretion (areas I chose based on evidence)

- **Monorepo layout specifics:** Six packages vs N — ARCHITECTURE.md suggests a richer layout; I recommend the minimum viable that supports Phases 1-5 without rework (see "Architecture Patterns" below).
- **Redis choice on Windows:** Memurai Developer Edition vs WSL2 Redis vs Docker Desktop — I recommend **Memurai Developer** as the path of least friction (see "Common Pitfalls → Redis on Windows").
- **Wake detection in Phase 1:** Not needed yet (Phase 5 territory) — skip.
- **Logging shape:** Structured JSON with pino-pretty transport only in dev. Raw JSON in production paths.
- **Test scaffolding:** Vitest + a small fixtures package. Golden-value tests for secret redaction + HMAC signing are mandatory gates before Phase 2.

### Deferred Ideas (OUT OF SCOPE for Phase 1)

- Order placement (spot: Phase 2; futures: Phase 6).
- Risk manager / circuit breakers (Phase 2).
- Telegram bot (Phase 3).
- History ingest / style fingerprint / signal generation (Phase 4).
- Ledger + reconciler (Phase 5).
- Python trainer / ONNX (Phase 8).
- Web + CLI dashboards (Phase 9).
- VPS / distributed lock / `age`-encrypted secrets (Phase 10).
- On-chain ingesters (Phase 7).
- CryptoPanic / CoinGecko / news (Phase 7).
- BullMQ (first real need is Phase 3 approval TTL; can install now but not wire).
- Redis Streams event bus (first real need is Phase 4+; not Phase 1).

## Project Constraints (from CLAUDE.md)

> CLAUDE.md at `C:\Users\lucid\Desktop\kr8tiv-mexc-bot\CLAUDE.md` is primarily a GSD-generated tableau of PROJECT.md + research/STACK.md + workflow defaults. The load-bearing constraints are already surfaced above; the additional CLAUDE.md directives planner must honor are:

- **GSD Workflow Enforcement:** No direct repo edits outside a GSD command. Every Phase 1 plan must run through `/gsd:execute-phase`.
- **Project identity:** Commits = Matt-Aurora-Ventures `<lucidbloks@gmail.com>`. No `Co-Authored-By: Claude`. This is enforced by lefthook/husky pre-commit + by operator discipline.
- **Windows paths:** All absolute paths in plans use Windows backslash form (`C:\Users\lucid\Desktop\kr8tiv-mexc-bot\...`).
- **No KuCoin references anywhere in code, comments, or docs.** MEXC is the sole exchange.
- **Node 22 LTS is fixed, not 20 (EOL Apr 30 2026), not 24 (newer but less prebuilt binary coverage).** Pin via `package.json` `engines.node` + `.nvmrc`.
- **TypeScript strict mode is non-negotiable** — `strict: true, noImplicitAny: true, strictNullChecks: true, noUncheckedIndexedAccess: true`. Order construction bugs are catastrophic at $10 bankroll.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-01 | pnpm workspaces + Turborepo monorepo on Node 22 LTS + TS 5.5+ strict | ARCHITECTURE.md monorepo layout; STACK.md pnpm+Turborepo rationale; this doc's "Recommended Project Structure" section with exact `pnpm-workspace.yaml` + `turbo.json` + `tsconfig.base.json` |
| FND-02 | SQLite WAL via better-sqlite3 (`journal_mode=WAL`, `synchronous=FULL`) | STACK.md version 11.7+; this doc's "Standard Stack → Persistence" + "Code Examples → SQLite initialization" — Windows prebuilt binaries confirmed for Node 22 |
| FND-03 | Redis reachable from core, connectivity smoke-test on boot (ioredis) | STACK.md ioredis 5.4+; this doc's "Redis on Windows → Memurai Developer" + "Code Examples → Redis smoke test" |
| FND-04 | SecretProvider abstraction with Windows Credential Manager impl (@zowe/secrets-for-zowe-sdk) | STACK.md + verified Zowe API (keyring.setPassword/getPassword/findCredentials/deletePassword); this doc's "SecretProvider API Contract" section |
| FND-05 | MEXC spot key/secret + Telegram token stored in Windows Credential Manager; no plaintext .env | Already-stored targets (`kr8tiv-mexc-bot/mexc-spot-access`, `mexc-spot-secret`, `mexc-whitelist-ip`). Telegram token stored later in Phase 3 but target name prescribed here for consistency |
| FND-06 | MEXCSpotClient (read-only) CCXT 4.5.48+, config-driven base URL | CCXT `options.defaultType='spot'` pattern; Zod schema for `MEXC_SPOT_BASE_URL` with default `https://api.mexc.com`; this doc's "Code Examples → MEXCSpotClient" |
| FND-07 | MEXCFuturesClient stub (read-only) CCXT, separate auth + rate bucket, config-driven base URL | Separate CCXT instance with `options.defaultType='swap'` — separate instances = separate rate-limit buckets (leaky bucket is per-instance). Base URL default `https://contract.mexc.com` but must be config-driven per Jan 12 2026 migration |
| FND-08 | Boot-time smoke test pings both MEXC endpoints, fails fast | Spot: `GET /api/v3/ping` → `{serverTime}`. Futures: `GET /api/v1/contract/ping` (rate-limited 20req/2s). See "Code Examples → Boot smoke test" |
| FND-09 | pino structured logging with automatic redaction of secret patterns | pino `redact.paths` supports dot+bracket+wildcard syntax; default censor `[Redacted]` or custom. See "Code Examples → pino config" |
| FND-10 | gitleaks pre-commit hook installed and passing | gitleaks 8.24+ TOML config with custom `mx0*` rule + Telegram token rule + generic 32-hex secret rule. Install via lefthook (cross-platform, no Cygwin fork issues) rather than husky (bash-dependent). See "Code Examples → .gitleaks.toml" |
| FND-11 | MEXC API key is trading-only + IP-whitelisted (operational verification) | Not code — a manual verification step before Phase 2 writes. Plan must include a verifiable checklist: log into MEXC → Account → API Management → confirm key has `Trading` ON, `Withdrawals` OFF, IP whitelist = Matt's public IP. This is a prerequisite gate, not a task output |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 22.x LTS (22.12+ current) | Runtime | LTS through Apr 2027; Node 20 EOLs Apr 30 2026; Node 22 has broadest prebuilt binary coverage for better-sqlite3, onnxruntime-node, @zowe/secrets |
| TypeScript | 5.7+ (5.5+ minimum per FND-01) | Type-safe core | Strict mode mandatory; `noUncheckedIndexedAccess` for safe array access on MEXC response arrays |
| pnpm | 9.12+ | Package manager / workspaces | Faster + lower disk than npm; Turborepo reads pnpm workspace structure natively; `packageManager` field in root `package.json` pins version |
| Turborepo | 2.1+ | Build orchestration | `turbo.json` task graph; remote cache not needed solo-dev; local cache cuts re-type-check cost |
| tsx | 4.19+ | Dev runner for TS | ts-node ESM story is broken; tsx is the 2026 default (no bundling, native ESM, watch mode via `--watch`) |
| tsup | 8.3+ | Production bundler | Zero-config TypeScript → single JS bundle per app; only needed when Phase 10 VPS deploy lands; install now for consistency |
| vitest | 2.1+ | Test framework | TS-native, Jest-compatible API, fast; no ts-jest config hell |
| @biomejs/biome | 2.3+ | Lint + format | Replaces ESLint+Prettier; 10-100x faster; single tool. v2.3.0 introduces CRLF default for Windows (critical — LF-only on Windows = every-file-modified noise) |
| lefthook | 1.8+ | Git hooks | Cross-platform (Rust binary), no bash/sh dependency → works around Matt's broken Git Bash. husky requires shell; lefthook doesn't |

### Core libraries

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| ccxt | 4.5.48+ (pick latest stable at install) | Unified MEXC client (spot + swap) | `mexc-api-sdk` abandoned; CCXT is active (daily releases); first-class MEXC `swap` support; `options.defaultType` toggles spot vs swap |
| ioredis | 5.4+ | Redis client | BullMQ uses it natively → zero duplicate pool when Phase 3 adds approvals; cluster + Lua script support battle-tested |
| better-sqlite3 | 11.7+ (12.9 current) | Append-only ledger | Synchronous API = deterministic write order; ~2000 qps indexed; Windows x64 prebuilt binaries present (Node 22 supported; verify on install — some Node 24 binary gaps exist) |
| pino | 9.5+ | Structured JSON logging | ~5x faster than winston; Fastify uses natively; `redact.paths` with wildcard support |
| zod | 3.23+ | Runtime validation | Every MEXC response parsed through Zod before trust; `@t3-oss/env-core` wraps Zod for env vars |
| @t3-oss/env-core | 0.11+ | Typed env var parsing | Catches `MEXC_SPOT_BASE_URL` missing at startup not at first order; `emptyStringAsUndefined: true` is mandatory for default values to apply correctly |
| @zowe/secrets-for-zowe-sdk | 9.x | Windows Credential Manager access | Explicit keytar drop-in replacement; keytar archived Dec 2022; native `wincred.dll` binding on Windows — no PowerShell bridge (200ms/call), no shell spawn |

### Secrets + config

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| dotenv | 16.4+ | Load non-secret env vars from `.env.local` | Only non-secret config (e.g., `MEXC_SPOT_BASE_URL`, `LOG_LEVEL`). Secrets NEVER here |

### Dev tooling

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| gitleaks | 8.24+ | Secret scanning | Pre-commit hook + CI scan; TOML config with custom rules for `mx0*` MEXC keys + Telegram bot tokens |
| @vitest/coverage-v8 | 2.1+ | Coverage reporter | v8 native coverage; no babel instrumentation overhead |

**Alternatives Considered:**

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pnpm + Turborepo | Nx | Nx wins on >10 packages + codegen + enforced boundaries. For 6 packages, solo dev, weekend target → Turborepo's smaller surface wins |
| pnpm + Turborepo | polyrepo (separate git repos per package) | Polyrepo = constant type-version-pin hell when `shared-types` is shared across 4 apps. Monorepo is correct |
| CCXT | `mexc-api-sdk` (official) | Abandoned ~2 years; open signature bugs from Dec 2025 unresolved. **Never.** Keep source available as a reference only |
| CCXT | `@theothergothamdev/mexc-sdk` fork | Community fork, no SLA, could vanish. Reference for signing quirks only |
| CCXT | Native `node:crypto` HMAC + fetch | Keep as escape hatch in Phase 2+ if a specific CCXT endpoint bug bites; not the default |
| @zowe/secrets-for-zowe-sdk | `keytar` | Archived Dec 2022 — will break silently on new Node versions. Don't |
| @zowe/secrets-for-zowe-sdk | PowerShell bridge (`Get-Credential` via `child_process`) | Works but 200ms/call vs <5ms native; breaks VPS portability; error handling across `child_process` is painful |
| Memurai Developer | WSL2 Redis | WSL2 Redis works but requires WSL2 enabled + maintained; Memurai installs via `winget install MemuraiDeveloper` in one command and runs as native Windows Service. See "Common Pitfalls → Redis on Windows" |
| Memurai Developer | Docker Desktop Redis | Docker Desktop on Windows is heavy (WSL2 or HyperV) and adds daemon lifecycle. Memurai is the lightest option |
| lefthook | husky + lint-staged | husky uses bash/sh — **Matt's Git Bash is broken (Cygwin fork errors).** lefthook is a Rust binary, no shell dependency |
| biome | ESLint + Prettier | ESLint+Prettier works but 10-100x slower + double config surface. Biome stable since 2.x |
| tsx | ts-node | ts-node ESM story is broken; tsx is the 2026 default |

**Installation:**

```bash
# pnpm itself (if not installed)
npm install -g pnpm@9

# From the repo root
pnpm init
# Root devDeps (repo-wide)
pnpm add -D -w typescript@^5.7 tsx@^4.19 tsup@^8.3 vitest@^2.1 @vitest/coverage-v8@^2.1 \
  @biomejs/biome@^2.3 @types/node@^22 turbo@^2.1 lefthook@^1.8

# Runtime deps to test at root (used by apps/core and multiple packages)
pnpm add -w ccxt@^4.5 zod@^3.23 pino@^9 pino-pretty@^11 \
  ioredis@^5 better-sqlite3@^11 dotenv@^16 \
  @t3-oss/env-core@^0.11 @zowe/secrets-for-zowe-sdk@^9

# gitleaks (binary, not npm) — download from GitHub releases or winget
winget install gitleaks.gitleaks
# confirm version
gitleaks version
```

**Version verification:**

Before writing any plan, verify each version against the registry:

```bash
npm view ccxt version                    # expect >= 4.5.48
npm view @zowe/secrets-for-zowe-sdk version  # expect 9.x
npm view better-sqlite3 version          # expect 11.x or 12.x (12.9.0 current Apr 2026)
npm view pino version                    # expect 9.5+
npm view ioredis version                 # expect 5.4+
npm view @biomejs/biome version          # expect 2.3+
npm view lefthook version                # expect 1.8+
```

Training-data versions are known to lag. Plans should `pnpm add <pkg>@latest` and pin the resulting lockfile, not hand-pin to a stale specifier.

## Architecture Patterns

### Recommended Project Structure

```
kr8tiv-mexc-bot/
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── biome.json
├── lefthook.yml
├── .gitleaks.toml
├── .nvmrc                          # "22"
├── package.json                    # root devDeps; "packageManager": "pnpm@9.x"
├── .env.local                      # git-ignored; non-secret config only
├── .env.example                    # committed; documents shape (never values)
│
├── apps/
│   └── core/                       # The trading service (stub in Phase 1)
│       ├── src/
│       │   ├── index.ts            # bootstrap: calls boot.ts, wires smoke test
│       │   ├── boot.ts             # the ordered boot sequence (see "Boot Sequence" below)
│       │   ├── logger.ts           # pino with redaction config
│       │   └── smoke.ts            # FND-08 dual-surface ping
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── shared-types/               # Trade, Signal, Order, Approval, SecretName DTOs
│   │   ├── src/index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── shared-schemas/             # Zod schemas matching shared-types
│   │   ├── src/index.ts            # exports e.g. TradeSchema, MexcSpotPingResponseSchema
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── config/                     # Zod+@t3-oss/env-core env parsing — single source of URL/flags
│   │   ├── src/env.ts              # createEnv({ server: { MEXC_SPOT_BASE_URL: z.url().default(...), ... } })
│   │   ├── src/index.ts            # exports `env`
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── secrets/                    # SecretProvider abstraction (FND-04)
│   │   ├── src/index.ts            # SecretProvider interface + WindowsCredentialManagerProvider
│   │   ├── src/provider.ts         # Zowe-backed impl
│   │   ├── src/secret.ts           # Secret<T> branded type
│   │   ├── src/setup-cli.ts        # one-off prompt script: `pnpm setup:credentials`
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── mexc-spot/                  # MEXCSpotClient (FND-06) — read-only in Phase 1
│   │   ├── src/index.ts
│   │   ├── src/client.ts           # CCXT instance with options.defaultType='spot'
│   │   ├── src/schemas.ts          # Zod parsers for MEXC spot responses
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── mexc-futures/               # MEXCFuturesClient (FND-07) — read-only stub in Phase 1
│       ├── src/index.ts
│       ├── src/client.ts           # CCXT instance with options.defaultType='swap'
│       ├── src/schemas.ts
│       ├── package.json
│       └── tsconfig.json
│
├── scripts/
│   ├── setup-credentials.ts        # wraps secrets/setup-cli for root-level `pnpm setup:credentials`
│   └── verify-env.ts               # asserts all FND-05 credentials are readable before Phase 2
│
└── data/                           # git-ignored
    └── core.sqlite                 # created at first boot (FND-02)
```

**Structural rationale:**

- **`apps/core` is a stub** in Phase 1 — it boots, loads secrets, pings both MEXC surfaces, logs `ready`, exits 0 on success. Phases 2-5 fill in the components.
- **Six packages, not more:** ARCHITECTURE.md envisions 10+ packages by Phase 5, but Phase 1 only needs these six. Adding empty packages now = noise. Add them when needed.
- **`packages/config` is the single source of truth for env vars.** `apps/core`, `mexc-spot`, and `mexc-futures` all import `env` from here. No ad-hoc `process.env.X` anywhere.
- **`packages/secrets` is the only place `@zowe/secrets-for-zowe-sdk` is imported.** Keeps the platform adapter surface tiny + mockable for tests.
- **`mexc-spot` and `mexc-futures` share zero code** except by importing `shared-types` and `shared-schemas`. Pitfall 1 mitigation: no shared auth, no shared rate bucket, no cross-contamination.
- **`scripts/` for operator one-offs** (setup credentials interactively, verify env): not built, run via `tsx scripts/foo.ts`.

### Pattern 1: SecretProvider Abstraction (FND-04)

**What:** An interface `SecretProvider` with methods that return a branded `Secret<string>` type. Concrete implementation `WindowsCredentialManagerProvider` wraps `@zowe/secrets-for-zowe-sdk`.

**When to use:** Everywhere a credential is needed. Clients depend on `SecretProvider`, not on Zowe directly.

**Example:**

```typescript
// packages/secrets/src/secret.ts
declare const SecretBrand: unique symbol;
export type Secret<T extends string = string> = T & { [SecretBrand]: true };

// Construct (internal — only SecretProvider can mint these)
export function wrap<T extends string>(value: T): Secret<T> {
  return value as Secret<T>;
}

// Unwrap at the call site (explicit — makes leaks grep-able)
export function unsafeReveal(s: Secret<string>): string {
  return s as string;
}

// Override toString/JSON so accidental logging produces "[REDACTED]"
// NOTE: branded primitives can't override methods directly; use a wrapper class
// when stricter safety is needed. For v1, the brand + pino redaction + gitleaks
// are the three defense layers; method-override is nice-to-have.

// packages/secrets/src/index.ts
export interface SecretProvider {
  /** Returns the secret for `name` or throws if not present. */
  get(name: SecretName): Promise<Secret<string>>;
  /** Returns true iff the secret is present. Used for boot-time validation. */
  has(name: SecretName): Promise<boolean>;
  /** Lists all secrets currently provisioned under the service prefix (names only, never values). */
  list(): Promise<SecretName[]>;
  /** Sets a secret. Only used by `scripts/setup-credentials.ts`. */
  set(name: SecretName, value: string): Promise<void>;
  /** Deletes a secret. Only used by `scripts/setup-credentials.ts --rotate`. */
  delete(name: SecretName): Promise<void>;
}

// packages/secrets/src/provider.ts
import { keyring } from "@zowe/secrets-for-zowe-sdk";
import { wrap } from "./secret.js";

const SERVICE_PREFIX = "kr8tiv-mexc-bot";

export type SecretName =
  | "mexc-spot-access"
  | "mexc-spot-secret"
  | "mexc-whitelist-ip"
  | "telegram-bot-token"         // added Phase 3; scaffold name here for consistency
  | "mexc-futures-access"        // added Phase 6
  | "mexc-futures-secret";       // added Phase 6

const USER_NAMES: Record<SecretName, string> = {
  "mexc-spot-access":     "MEXC_SPOT_ACCESS",
  "mexc-spot-secret":     "MEXC_SPOT_SECRET",
  "mexc-whitelist-ip":    "MEXC_WHITELIST_IP",
  "telegram-bot-token":   "TELEGRAM_BOT_TOKEN",
  "mexc-futures-access":  "MEXC_FUTURES_ACCESS",
  "mexc-futures-secret":  "MEXC_FUTURES_SECRET",
};

export class WindowsCredentialManagerProvider implements SecretProvider {
  private service(name: SecretName) { return `${SERVICE_PREFIX}/${name}`; }
  private account(name: SecretName) { return USER_NAMES[name]; }

  async get(name: SecretName): Promise<Secret<string>> {
    const value = await keyring.getPassword(this.service(name), this.account(name));
    if (value === null) {
      throw new SecretNotFoundError(name);
    }
    return wrap(value);
  }
  async has(name: SecretName): Promise<boolean> {
    const value = await keyring.getPassword(this.service(name), this.account(name));
    return value !== null;
  }
  async list(): Promise<SecretName[]> {
    // Zowe's findCredentials takes a service name; scope by prefix
    // Iterate over all known SecretNames and keep those present
    const all = Object.keys(USER_NAMES) as SecretName[];
    const present = await Promise.all(all.map(async n => ({ n, ok: await this.has(n) })));
    return present.filter(x => x.ok).map(x => x.n);
  }
  async set(name: SecretName, value: string) {
    await keyring.setPassword(this.service(name), this.account(name), value);
  }
  async delete(name: SecretName) {
    await keyring.deletePassword(this.service(name), this.account(name));
  }
}

export class SecretNotFoundError extends Error {
  constructor(public readonly name: SecretName) {
    super(`Secret not found in Windows Credential Manager: ${name}`);
  }
}
```

**Trade-offs:**
- Pro: MEXCSpotClient and MEXCFuturesClient each accept a `SecretProvider` in their constructor → trivial to mock in tests + trivial to swap to encrypted-file provider for VPS in Phase 10.
- Pro: `SecretName` union is the allow-list of known secrets; typos become compile errors.
- Con: Phase 1 only needs `mexc-spot-access`, `mexc-spot-secret`, `mexc-whitelist-ip`. Scaffolding the Phase 3/6 names here is mild over-engineering, but cheap and prevents churn.

### Pattern 2: Two-Client MEXC Separation (FND-06, FND-07)

**What:** Two packages (`packages/mexc-spot`, `packages/mexc-futures`) each export their own client class. Each constructs its own CCXT instance with its own `options.defaultType` + its own `apiKey`/`secret` (futures stubbed in Phase 1, populated in Phase 6). Each has its own rate-limit bucket (CCXT's leaky bucket is per-instance).

**When to use:** Always. Never a unified `MEXCClient.spot.X()` / `MEXCClient.futures.X()` facade — that's Pitfall 1 (Anti-Pattern 3 in ARCHITECTURE.md).

**Example:**

```typescript
// packages/mexc-spot/src/client.ts
import ccxt, { type Exchange } from "ccxt";
import type { SecretProvider } from "@kr8tiv/secrets";
import { unsafeReveal } from "@kr8tiv/secrets/secret";
import { env } from "@kr8tiv/config";
import { MexcPingResponseSchema, MexcBalanceResponseSchema } from "./schemas.js";

export interface MEXCSpotClientConfig {
  secrets: SecretProvider;
  /** Override for tests / staging. Default from env.MEXC_SPOT_BASE_URL */
  baseUrl?: string;
  /** Override for tests. Default from env.MEXC_RECV_WINDOW_MS */
  recvWindowMs?: number;
}

export class MEXCSpotClient {
  private readonly exchange: Exchange;
  private constructor(exchange: Exchange) { this.exchange = exchange; }

  static async create(config: MEXCSpotClientConfig): Promise<MEXCSpotClient> {
    const [access, secret] = await Promise.all([
      config.secrets.get("mexc-spot-access"),
      config.secrets.get("mexc-spot-secret"),
    ]);

    const exchange = new ccxt.mexc({
      apiKey:    unsafeReveal(access),
      secret:    unsafeReveal(secret),
      enableRateLimit: true,
      rateLimit: 100,                              // ms between requests; overridden by CCXT per endpoint
      timeout: 10_000,
      options: {
        defaultType: "spot",                       // critical — scope this instance to spot
        recvWindow: config.recvWindowMs ?? env.MEXC_RECV_WINDOW_MS,
      },
      urls: {
        api: {
          spot:     config.baseUrl ?? env.MEXC_SPOT_BASE_URL,
          spotPublic: config.baseUrl ?? env.MEXC_SPOT_BASE_URL,
          spotPrivate: config.baseUrl ?? env.MEXC_SPOT_BASE_URL,
        },
      },
    }) as Exchange;

    return new MEXCSpotClient(exchange);
  }

  /** FND-08 support. Hits /api/v3/ping. */
  async ping(): Promise<{ serverTime: number }> {
    // CCXT doesn't expose ping directly for all exchanges; use fetch or implicit
    const raw = await (this.exchange as any).publicGetPing(); // MEXC implicit method
    // MEXC spot ping returns {} — serverTime comes from /time
    const time = await (this.exchange as any).publicGetTime();
    return MexcPingResponseSchema.parse({ serverTime: time.serverTime });
  }

  /** Read-only: account balances. Parsed through Zod. */
  async getAccountInfo(): Promise<AccountInfo> {
    const raw = await this.exchange.fetchBalance({ type: "spot" });
    return MexcBalanceResponseSchema.parse(raw);
  }

  // NO order placement methods in Phase 1. Phase 2 adds placeMarketBuy / placeLimitSell / cancelOrder.
}
```

```typescript
// packages/mexc-futures/src/client.ts
import ccxt, { type Exchange } from "ccxt";
import type { SecretProvider } from "@kr8tiv/secrets";
import { unsafeReveal } from "@kr8tiv/secrets/secret";
import { env } from "@kr8tiv/config";

export class MEXCFuturesClient {
  private readonly exchange: Exchange;
  private constructor(exchange: Exchange) { this.exchange = exchange; }

  /**
   * Phase 1: futures credentials may not yet be provisioned.
   * If either secret is missing, construct a read-only-public client
   * (futures ping works without auth).
   */
  static async create(config: { secrets: SecretProvider; baseUrl?: string }): Promise<MEXCFuturesClient> {
    const hasCredentials = await Promise.all([
      config.secrets.has("mexc-futures-access"),
      config.secrets.has("mexc-futures-secret"),
    ]);
    const authenticated = hasCredentials.every(Boolean);

    const exchange = new ccxt.mexc({
      apiKey:  authenticated ? unsafeReveal(await config.secrets.get("mexc-futures-access")) : "",
      secret:  authenticated ? unsafeReveal(await config.secrets.get("mexc-futures-secret")) : "",
      enableRateLimit: true,
      rateLimit: 100,
      timeout: 10_000,
      options: {
        defaultType: "swap",                         // critical — scope this instance to USDT-M swap
        recvWindow: env.MEXC_RECV_WINDOW_MS,
      },
      urls: {
        api: {
          swap:        config.baseUrl ?? env.MEXC_FUTURES_BASE_URL,
          swapPublic:  config.baseUrl ?? env.MEXC_FUTURES_BASE_URL,
          swapPrivate: config.baseUrl ?? env.MEXC_FUTURES_BASE_URL,
        },
      },
    }) as Exchange;

    return new MEXCFuturesClient(exchange);
  }

  /** FND-08 support. Hits /api/v1/contract/ping. Public — no auth required. */
  async ping(): Promise<{ serverTime: number }> {
    // ccxt mexc exposes contract ping via implicit method `contractPublicGetPing`
    // Return shape: { success: true, code: 0, data: 1645539742000 }
    const response = await (this.exchange as any).contractPublicGetPing();
    if (!response?.success) {
      throw new Error(`MEXC futures ping failed: ${JSON.stringify(response)}`);
    }
    return { serverTime: response.data };
  }

  // NO order placement methods in Phase 1 and NO in Phase 2 either.
  // Futures write path is Phase 6 (FUT-01..07).
}
```

**Trade-offs:**
- Pro: Two independent CCXT instances → two independent rate-limit buckets (each has its own leaky bucket). A spot burst can't throttle futures and vice versa.
- Pro: Different `urls.api` scope → Jan 12 2026 futures domain migration is a one-line env change.
- Pro: Phase 1 futures client gracefully handles missing credentials (public ping still works for smoke test).
- Con: Slight code duplication in `create()`. Acceptable; the two clients will diverge more in Phase 6 when futures writes land with different signature semantics.

### Pattern 3: Config-Driven Base URLs via @t3-oss/env-core + Zod

**What:** A single `packages/config` module defines a Zod schema for every environment variable + runtime flag. All packages import `env` from there. No package reads `process.env` directly.

**Why this matters for Phase 1:** FND-06 and FND-07 say base URLs must be config-driven. Pitfall 1 says Jan 12 2026 MEXC futures domain migration WILL happen — hardcoded URLs are a ticking time bomb. Zod-validated env parsing catches missing/misformatted values at startup, not at first API call.

**Example:**

```typescript
// packages/config/src/env.ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

    // MEXC surfaces — DEFAULTS are current production URLs but env override works for migration
    MEXC_SPOT_BASE_URL:    z.string().url().default("https://api.mexc.com"),
    MEXC_FUTURES_BASE_URL: z.string().url().default("https://contract.mexc.com"),

    // MEXC knobs
    MEXC_RECV_WINDOW_MS:   z.coerce.number().int().min(1000).max(60000).default(5000),

    // Redis (local Memurai on 6379 by default)
    REDIS_URL:             z.string().url().default("redis://127.0.0.1:6379"),

    // SQLite
    SQLITE_PATH:           z.string().default("./data/core.sqlite"),

    // Logging
    LOG_LEVEL:             z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    LOG_PRETTY:            z.coerce.boolean().default(true), // false in prod
  },
  runtimeEnv: process.env,
  // CRITICAL: without this, an empty string (e.g. MEXC_SPOT_BASE_URL= in .env) will NOT trigger the default.
  emptyStringAsUndefined: true,
});
```

```typescript
// packages/config/src/index.ts
export { env } from "./env.js";
```

**Trade-offs:**
- Pro: `MEXC_SPOT_BASE_URL` defaults to the current URL but is overridable via `.env.local` when Jan 12 migration lands — one line of .env change, no rebuild.
- Pro: Typos in env var names become compile errors (`env.MEXC_SPOOT_BASE_URL` → TS error).
- Pro: Missing vars fail loudly on boot, not on first API call at 3am.
- Con: Mild coupling — all packages depend on `@kr8tiv/config`. Accepted because config is cross-cutting.

### Pattern 4: Boot Sequence (FND-08 orchestrator)

**What:** A single `boot.ts` that orchestrates startup in a strict order, fails fast on any step with a clear message, and exits non-zero if any pre-flight check fails.

**Why the order matters:** Each step depends on the previous. A missing MEXC key should be caught before attempting to connect to Redis (cheaper error). Redis unreachable should be caught before opening SQLite WAL (no point holding a file handle). Both ping failures should be independent and both reported even if the first fails.

**Boot order:**

```
1. Configure logger (pino with redaction)       — needed for every subsequent error message
2. Parse env vars (Zod via @t3-oss/env-core)    — catch missing/bad config before anything else
3. Construct SecretProvider                      — platform-specific; may fail if Zowe binary is missing
4. Pre-flight: check required secrets exist     — `secrets.has('mexc-spot-access')` etc., report ALL missing at once
5. Connect to Redis (ioredis) + PING             — catch Redis-not-running before opening SQLite
6. Open SQLite WAL (better-sqlite3)              — idempotent schema create; set PRAGMAs
7. Construct MEXCSpotClient                      — reads spot credentials from SecretProvider
8. Construct MEXCFuturesClient                   — may skip auth if Phase 1 futures creds missing (public ping only)
9. Smoke test: spot ping + futures ping in parallel — fail fast if EITHER fails
10. Log "ready" and exit 0 (Phase 1) or start supervisor (Phase 2+)
```

**Example:**

```typescript
// apps/core/src/boot.ts
import { env } from "@kr8tiv/config";
import { logger } from "./logger.js";
import { WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import { MEXCSpotClient } from "@kr8tiv/mexc-spot";
import { MEXCFuturesClient } from "@kr8tiv/mexc-futures";
import Redis from "ioredis";
import Database from "better-sqlite3";

export async function boot() {
  logger.info({ nodeVersion: process.version, env: env.NODE_ENV }, "boot starting");

  // Step 3: SecretProvider
  const secrets = new WindowsCredentialManagerProvider();

  // Step 4: Pre-flight — collect ALL missing secrets before failing
  const required = ["mexc-spot-access", "mexc-spot-secret", "mexc-whitelist-ip"] as const;
  const missing = (await Promise.all(
    required.map(async n => ({ n, present: await secrets.has(n) }))
  )).filter(x => !x.present).map(x => x.n);
  if (missing.length > 0) {
    logger.fatal({ missing }, "required secrets missing from Windows Credential Manager");
    logger.info("Run `pnpm setup:credentials` to provision them.");
    process.exit(1);
  }

  // Step 5: Redis
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`Redis PING returned ${pong}`);
    logger.info({ url: env.REDIS_URL.replace(/\/\/.*@/, "//***@") }, "redis connected");
  } catch (err) {
    logger.fatal({ err }, "Redis unreachable — is Memurai running? `winget install MemuraiDeveloper`");
    process.exit(1);
  }

  // Step 6: SQLite WAL
  let db: Database.Database;
  try {
    db = new Database(env.SQLITE_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    logger.info({ path: env.SQLITE_PATH }, "sqlite opened (WAL, synchronous=FULL)");
  } catch (err) {
    logger.fatal({ err, path: env.SQLITE_PATH }, "sqlite open failed");
    process.exit(1);
  }

  // Step 7 + 8: MEXC clients (in parallel — no dependency)
  const [spot, futures] = await Promise.all([
    MEXCSpotClient.create({ secrets }),
    MEXCFuturesClient.create({ secrets }),
  ]);

  // Step 9: Smoke test — collect BOTH results before exiting
  const pingResults = await Promise.allSettled([
    spot.ping(),
    futures.ping(),
  ]);
  const [spotResult, futuresResult] = pingResults;

  if (spotResult.status === "rejected") {
    logger.error({ err: spotResult.reason, base: env.MEXC_SPOT_BASE_URL }, "MEXC spot ping failed");
  } else {
    logger.info({ serverTime: spotResult.value.serverTime }, "MEXC spot ping OK");
  }
  if (futuresResult.status === "rejected") {
    logger.error({ err: futuresResult.reason, base: env.MEXC_FUTURES_BASE_URL }, "MEXC futures ping failed");
  } else {
    logger.info({ serverTime: futuresResult.value.serverTime }, "MEXC futures ping OK");
  }

  if (spotResult.status === "rejected" || futuresResult.status === "rejected") {
    logger.fatal("MEXC connectivity smoke test failed — aborting boot");
    process.exit(2);
  }

  logger.info("Phase 1 boot complete — all systems ready");

  // Return handles so tests can assert + later phases can keep the process alive
  return { redis, db, spot, futures, secrets };
}
```

### Anti-Patterns to Avoid

- **Unified `MEXCClient` facade with `.spot.X()` / `.futures.X()`** — Pitfall 1 / ARCHITECTURE.md Anti-Pattern 3. Two auth schemes, two rate-limit buckets → two clients. No shortcuts.
- **Hardcoding `https://api.mexc.com` or `https://contract.mexc.com` anywhere** — Pitfall 1. Jan 12 2026 futures domain migration will bite. Always via `env.MEXC_*_BASE_URL`.
- **Reading secrets via `process.env.MEXC_API_KEY`** — FND-05 forbids plaintext .env. Secrets come from Windows Credential Manager via SecretProvider, period.
- **Logging a full request/response object** — Pitfall 10. `logger.info({ req })` can log `req.headers.X-MEXC-APIKEY`. Always redact — or better, log only the specific fields you need.
- **`console.log` anywhere in production code paths** — pino redaction doesn't apply to `console.*`. A stray `console.log(mexcClient)` prints the client's internals including secrets.
- **Installing husky + bash hooks** — Matt's Git Bash is broken (Cygwin fork errors). Use lefthook (Rust binary, no shell).
- **Running the bot as Local System or as a Windows service (NT AUTHORITY\SYSTEM)** — Pitfall 4. DPAPI keys are per-user-SID. Service account can't read Matt's credentials. Run under Matt's user account.
- **A `packages/mexc` package with both clients inside** — creates import-order dependencies and tempts accidental code reuse. Two separate packages enforces separation at the module-system level.
- **Trying to stuff Phase 3/5 stuff into Phase 1** — wake-event, BullMQ wiring, Telegram bot, history ingester → all Phase 3+. Phase 1 is scaffold + read access. Resist scope creep.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MEXC API signing (HMAC-SHA256 for spot + contract-format for futures) | Custom `crypto.createHmac('sha256')` + header assembly | CCXT 4.5+ (`new ccxt.mexc({ apiKey, secret })`) | Pitfall 1, Integration Gotcha table in PITFALLS.md. Spot signs query-string; futures signs `query+body` concatenated. Get one wrong and no orders fire (silent 700002). Two ways to spell wrong, one way to spell right. |
| Windows Credential Manager access | `child_process.exec('cmdkey /list')` or PowerShell bridge | `@zowe/secrets-for-zowe-sdk` (native `wincred.dll` binding) | Shell spawn ~200ms/call. Bridges fragile across Windows versions. Zowe's native addon is <5ms and cross-platform (Keychain on macOS, libsecret on Linux → Phase 10 reuse). |
| Env var parsing + validation | `process.env.X ?? "default"` scattered across files | `@t3-oss/env-core` + Zod | Catches missing vars at startup not at first API call (Pitfall 10 — missing env at 3am). Type-safe — typos become compile errors. |
| Secret scanning in git | Custom pre-commit regex | gitleaks 8.24+ | Battle-tested regex library; handles git history scan (`detect`); composite rules (v8.28) catch aws-key-adjacent patterns; maintained with CVE tracking. |
| SQLite + WAL mode | Raw `sqlite3` binding + manual PRAGMA management | `better-sqlite3` 11.7+ | Synchronous API prevents race conditions on ledger writes. Handles prepared-statement cache, WAL checkpoint semantics, transaction retry. Prebuilt Windows x64 binaries for Node 22. |
| Structured logging | Hand-rolled JSON.stringify | pino 9+ | 5x faster than winston; redaction config; production-grade. |
| Runtime type validation of MEXC responses | Trust the JSON + optional chaining everywhere | Zod 3.23+ | Parse-don't-validate. A malformed MEXC response becomes a Zod error at the boundary, not a bad order at the executor. |
| Process management on Windows | Custom Windows Service via NSSM | PM2 + pm2-windows-service (when Phase 10 VPS deploy lands) | Battle-tested; log rotation; `pm2 status`. Note: NOT needed in Phase 1 — Matt runs `pnpm dev` manually this weekend. |
| Rate-limited HTTP (for future CryptoPanic/CoinGecko) | Custom debouncer | `p-queue` 8.x | Phase 7 concern. Don't install in Phase 1 but avoid reinventing later. |
| Monorepo task orchestration | Custom bash scripts | Turborepo 2.1+ | Caches successful `turbo typecheck` runs; runs packages in dependency order; cross-platform (not bash). |
| Git hooks | husky | lefthook | Cross-platform Rust binary — critical given Matt's broken Git Bash. |

**Key insight:** All 11 FND requirements map to well-established libraries. Zero new problem surfaces in Phase 1. The work is wiring, not invention. Any temptation to hand-roll anything in Phase 1 should be treated as a signal to re-read STACK.md.

## Runtime State Inventory

**Phase 1 is greenfield — no rename/refactor/migration.** This section is skipped intentionally.

(There is no prior state to inventory; the project's git history contains only `.planning/` documents, `CLAUDE.md`, and `.gitignore`. No prior secrets, no prior services, no prior builds. Windows Credential Manager already contains three provisioned credentials documented in `STATE.md` — these are READ by Phase 1, not created/migrated.)

## Common Pitfalls

### Pitfall 1: Two MEXC surfaces conflated into one client

**What goes wrong:** Shared CCXT instance → shared rate-limit bucket → a spot request storm throttles futures requests (or vice versa). Worse: shared auth config accidentally sends spot-format signatures to futures endpoints → `700002 invalid signature` on futures only, confusing silent degradation. Worst: Jan 12 2026 MEXC futures domain migration breaks a hardcoded URL silently (bot just stops executing futures one morning).

**Why it happens:** Third-party MEXC tutorials show a single `MexcClient` class with `.spot()` / `.futures()` namespaces. The abstraction is wrong for the underlying reality (two products, two auth schemes, two rate buckets).

**How to avoid:**
- Two packages, two classes, zero shared code except `shared-types`.
- CCXT `options.defaultType: 'spot'` on one instance, `'swap'` on the other → CCXT's leaky-bucket rate limiter is per-instance.
- `env.MEXC_SPOT_BASE_URL` and `env.MEXC_FUTURES_BASE_URL` as separate env vars with current defaults — a migration = one env change, not a code change.
- Boot-time smoke test hits both pings. If either fails, log explicitly which URL was tried.

**Warning signs:**
- `700002 invalid signature` on one surface but not the other.
- `404 Not Found` on futures after a MEXC announcement you missed.
- Rate-limit bursts on spot delay futures responses.

### Pitfall 2: Secret leakage to logs / git / screenshares

**What goes wrong:** (1) `console.log(mexcClient)` dumps apiKey in stdout → captured by log aggregator. (2) `.env.local` accidentally committed → GitHub secret-scanning bot finds it within minutes. (3) Stack trace from axios/fetch includes `X-MEXC-APIKEY` header in the request object. (4) Matt screenshares `/status` response that has a truncated key.

**Why it happens:** No redaction layer. No pre-commit hook. Developer convenience > discipline.

**How to avoid (three independent layers):**

1. **pino redaction** — configured globally in `apps/core/src/logger.ts`:

```typescript
import pino from "pino";

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      // API keys in common shapes
      "apiKey",
      "secret",
      "*.apiKey",
      "*.secret",
      "*.password",
      "*.token",
      // HTTP headers
      'req.headers["x-mexc-apikey"]',
      'req.headers["x-mexc-signature"]',
      'req.headers["authorization"]',
      'res.headers["set-cookie"]',
      // Nested axios/fetch request objects
      "config.apiKey",
      "config.secret",
      "config.headers",
      // MEXC-specific
      "mexc.apiKey",
      "mexc.secret",
      // Telegram token when Phase 3 lands (scaffold now)
      "telegramToken",
      "telegram.token",
      "*.telegramToken",
      // Wallet addresses when Phase 7 lands (scaffold now)
      "walletAddress",
      "*.walletAddress",
      // Wildcard catches for common object shapes
      "*.key",
      "*.Key",
      "**.apiKey",
      "**.secret",
    ],
    censor: "[REDACTED]",
    remove: false,
  },
  transport: env.LOG_PRETTY ? {
    target: "pino-pretty",
    options: { colorize: true, singleLine: false, translateTime: "SYS:standard" },
  } : undefined,
});
```

Pino supports wildcard paths (`a.b.*`, `a[*].b`) with ~50% overhead for wildcards vs explicit paths — acceptable for safety.

2. **`Secret<T>` branded type** — unwrapping requires explicit `unsafeReveal(s)` which greps trivially; any accidental `String(secret)` produces the brand string not the value. Not a 100% guarantee (brands are compile-time only) but drastically reduces accident surface.

3. **gitleaks pre-commit hook** — catches strings that slip past the other two layers. Config below.

**Warning signs:**
- GitHub secret-scanning alert email from Anthropic/GitHub.
- MEXC emails Matt about "unusual login from new IP."
- Any string starting with `mx0` appears in a log file or committed file.

### Pitfall 3: better-sqlite3 native addon install fails on Windows

**What goes wrong:** `pnpm install` runs `node-gyp` which requires Visual Studio Build Tools + Python; if missing, compile fails with cryptic C++ error. Dev spends 2 hours installing MSVC.

**Why it happens:** Native addons need a C compiler unless a prebuilt binary matches `{node_version, platform, arch, ABI}`. better-sqlite3 ships Windows x64 prebuilts for recent Node versions but Node 24 had a gap; Node 22 is well-covered as of 12.9.0 (Apr 2026).

**How to avoid:**
- Pin Node to 22.x in `.nvmrc` + `package.json` `engines.node`.
- On install, watch for the line `prebuild-install info install installing standalone, nodegyp build will be skipped` — that confirms the prebuilt binary was fetched.
- If fallback to source compile is needed, run once: `npm install -g windows-build-tools` (deprecated but still works) OR install Visual Studio 2022 Community with "Desktop development with C++" workload + Python 3.12.
- If all else fails, fallback: `pnpm add better-sqlite3-with-prebuilds` (alternate package that ships more Windows binaries).

**Warning signs:**
- `node-gyp rebuild` in install output.
- `MSBuild.exe not found` or `cl.exe not found` error.
- `Python executable 'python' not found` error.

### Pitfall 4: Redis on Windows — which option?

**What goes wrong:** Dev tries to install Redis natively, finds the old `MicrosoftArchive/redis` fork (last updated 2016, does NOT support Redis 7 features). OR tries Docker Desktop which requires WSL2 or HyperV + takes 2GB RAM just to idle.

**Why it happens:** Microsoft abandoned the Windows port of Redis. Official Redis has never supported Windows natively.

**How to avoid — ranked by friction for this project:**

| Option | Install cost | Memory overhead | Redis version | Recommendation |
|--------|-------------|-----------------|---------------|----------------|
| **Memurai Developer** | `winget install MemuraiDeveloper` (one command); runs as Windows Service | ~20MB idle | Redis 7.2.6 API fully compatible | **Recommended.** Free for dev. 10-day restart limit (hit by killing + restarting the service) — not a concern for a bot that boots fresh anyway. |
| WSL2 + Ubuntu + `apt install redis-server` | Enable WSL2, install Ubuntu, apt install | ~1GB (WSL2 overhead) | Redis 7.x from apt | Works. Heavier. Useful if Matt already runs WSL2 for other reasons. |
| Docker Desktop + redis:7 | Install Docker Desktop, pull image | ~2GB (Docker daemon + image) | Any | Overkill for one process. Avoid. |

**Recommended:** Memurai Developer. Install command: `winget install MemuraiDeveloper`. Default URL `redis://127.0.0.1:6379`. No config changes needed for Phase 1.

**Warning signs:**
- `ECONNREFUSED 127.0.0.1:6379` on boot → Redis service not running; `Get-Service Memurai` in PowerShell; start via `Start-Service Memurai` or Services.msc.
- 10-day restart popup → just restart the service; dev work continues.

### Pitfall 5: Broken Git Bash / Cygwin fork errors blocking husky

**What goes wrong:** Matt's Git Bash install is broken (confirmed in additional_context). Any shell-based pre-commit hook (husky default) hits `fork: retry: Resource temporarily unavailable` and the commit silently skips the hook — secret-scanning is effectively disabled.

**How to avoid:**
- **Use lefthook instead of husky.** lefthook is a Rust binary, no shell dependency. Configuration in `lefthook.yml`:

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    gitleaks:
      run: gitleaks protect --staged --verbose --redact
    biome-check:
      glob: "*.{ts,tsx,js,jsx,json}"
      run: pnpm biome check --no-errors-on-unmatched {staged_files}
    typecheck:
      glob: "*.{ts,tsx}"
      run: pnpm turbo typecheck
```

- Install: `pnpm add -D -w lefthook` + `pnpm exec lefthook install` (writes `.git/hooks/*` that invoke the lefthook binary, not bash).
- Verify: `git commit --allow-empty -m "test"` — the hook should run and pass. If it doesn't, investigate (most likely the binary didn't get PATH'd).

### Pitfall 6: gitleaks missing MEXC-specific patterns

**What goes wrong:** Default gitleaks rules catch AWS keys, GitHub tokens, Slack webhooks — but NOT MEXC access keys (custom `mx0*` format) or Telegram bot tokens (custom `\d{9,10}:[A-Za-z0-9_-]{35}` format). A key slips through by accident.

**How to avoid — `.gitleaks.toml`:**

```toml
# .gitleaks.toml
# Extend the default ruleset with MEXC + Telegram patterns.
# Default config is inherited unless `[extend]` is set to disabled.

title = "kr8tiv-mexc-bot gitleaks config"

[extend]
useDefault = true

# ---- MEXC Access Key ----
# Format observed: "mx0" + alphanumeric, typically 18-40 chars total
# Example: mx0npKfh57kEEVmyLa, mx0aBYs33eIilxBWC5
[[rules]]
id          = "mexc-access-key"
description = "MEXC API access key (mx0 prefix)"
regex       = '''mx0[A-Za-z0-9]{15,40}'''
secretGroup = 0
entropy     = 3.5
keywords    = ["mx0"]
tags        = ["api-key", "mexc"]

# ---- MEXC Secret Key ----
# 32-character hex string; high false-positive rate so REQUIRE keyword context
# Example: 51f38875ebe0475dad6236783a95cc19
[[rules]]
id          = "mexc-secret-key"
description = "MEXC API secret key (32-char hex) — keyword-gated"
regex       = '''(?i)(mexc[_-]?secret|mexc[_-]?api[_-]?secret|MEXC_SPOT_SECRET|MEXC_FUTURES_SECRET)\s*[=:"']+\s*([a-f0-9]{32})\b'''
secretGroup = 2
entropy     = 3.0
keywords    = ["mexc"]
tags        = ["secret", "mexc"]

# ---- Telegram Bot Token ----
# Format: <digits>:<35-char-mixed>  e.g. 123456789:AAH2_aBcDeF...
[[rules]]
id          = "telegram-bot-token"
description = "Telegram Bot API token"
regex       = '''[0-9]{9,10}:[A-Za-z0-9_-]{35}'''
secretGroup = 0
entropy     = 3.5
keywords    = ["telegram", "bot"]
tags        = ["telegram", "bot-token"]

# ---- Ethereum private key (scaffold for Phase 7) ----
# 64-char hex, often prefixed with 0x. Never appears in this project for v1,
# but planting the rule now means if Matt accidentally commits it in a future
# phase, gitleaks catches it.
[[rules]]
id          = "eth-private-key"
description = "Ethereum private key (64-char hex)"
regex       = '''(?i)(private[_-]?key|priv[_-]?key|eth[_-]?key)\s*[=:"']+\s*(0x)?([a-f0-9]{64})\b'''
secretGroup = 3
entropy     = 3.5
keywords    = ["private", "key", "eth"]
tags        = ["wallet", "private-key"]

# ---- Solana private key (scaffold for Phase 7) ----
# Solana keys are typically base58 of 64 bytes → 87-88 chars. Hard to regex
# cleanly without false positives. Keyword-gate.
[[rules]]
id          = "solana-private-key"
description = "Solana private key (base58, 87-88 chars) — keyword-gated"
regex       = '''(?i)(solana[_-]?key|phantom[_-]?key|sol[_-]?priv)\s*[=:"']+\s*([1-9A-HJ-NP-Za-km-z]{86,90})'''
secretGroup = 2
entropy     = 4.0
keywords    = ["solana", "phantom"]
tags        = ["wallet", "private-key", "solana"]

# ---- Allowlist ----
[allowlist]
description = "Paths to exclude from scanning"
paths = [
  '''\.planning/.*\.md''',          # planning docs may have placeholder examples
  '''\.gitleaks\.toml''',            # don't scan the config itself
  '''package-lock\.json''',          # never commit secrets to lockfiles; skip the noise
  '''pnpm-lock\.yaml''',
]
# Commit-hash allowlist can go here if a historical false positive is proven safe.
commits = []
# Allow our research files to contain the string "mx0npKfh57kEEVmyLa" etc. (MEXC docs examples)
regexes = [
  '''mx0npKfh57kEEVmyLa''',          # MEXC public doc example
  '''mx0aBYs33eIilxBWC5''',          # MEXC public doc example
  '''51f38875ebe0475dad6236783a95cc19''', # MEXC public doc example
]
```

**Test pre-commit hook works:** Create a file `test-secret.txt` with content `mx0testkeythatisalongenoughtomatch01234` → `git add` → `git commit -m "test"`. Commit must be rejected by gitleaks.

### Pitfall 7: Wildcard pino redaction performance

**What goes wrong:** Wildcard paths (`*.apiKey`, `**.secret`) carry ~50% overhead vs explicit paths. At high log volumes (Phase 4+ signal generation), this matters.

**How to avoid:**
- In Phase 1: use wildcards freely — log volume is low (boot + ping + errors).
- In Phase 4+: add explicit paths for the hot-path object shapes. Keep wildcards as a safety net.
- Benchmark with `pino-benchmark` if latency-sensitive.

### Pitfall 8: MEXC recvWindow clock skew

**What goes wrong:** MEXC rejects requests where local time drifts >5s from server time with error `700005` or `700006`. Windows laptops that sleep commonly wake up with 10-30s skew.

**How to avoid in Phase 1:**
- Set `recvWindow: 5000` (default) — NOT higher (Pitfall in PITFALLS.md says recvWindow > 60000 = `700005`).
- On boot, log `clientTime - serverTime` delta. If > 3s, warn.
- Windows time sync: `w32tm /resync` — scaffold a `scripts/resync-time.ps1` that users can run if boot smoke test fails with clock skew.
- Wake-time clock correction is Phase 5. In Phase 1, just detect and warn.

### Pitfall 9: `@zowe/secrets-for-zowe-sdk` install issues on Windows

**What goes wrong:** `@zowe/secrets-for-zowe-sdk` is a native addon. Binary install should succeed on Windows 11 x64 + Node 22 — but if it falls back to compile from source, same `node-gyp` issues as better-sqlite3.

**How to avoid:**
- Zowe ships prebuilt binaries for Node 18+ on Windows x64, macOS x64+arm64, Linux x64 — Node 22 is covered.
- On install, log output should show `installing standalone` not `node-gyp rebuild`.
- If it falls back: see Pitfall 3 remediation (install Visual Studio Build Tools).

## Environment Availability

| Dependency | Required By | Available (probed) | Version | Fallback |
|------------|-------------|--------------------|---------|----------|
| Node.js 22 LTS | FND-01 | **NOT PROBED** (bash broken) | expected via nvm/install | Planner task: verify `node --version` in PowerShell before any `pnpm install`. Install via `winget install OpenJS.NodeJS.LTS` if missing. |
| pnpm 9+ | FND-01 | **NOT PROBED** | expected | `npm install -g pnpm@9` if missing |
| Git for Windows | git operations | Installed (CLAUDE.md commit history exists) | unknown | — |
| Git Bash | husky / shell hooks | **BROKEN** (Cygwin fork errors per additional_context) | — | **Use lefthook (Rust binary) instead of husky** — no shell dependency |
| PowerShell 7+ | setup scripts | Default on Windows 11 | 7.4+ usually | — (fallback to PowerShell 5.1 if 7 missing — less convenient but works) |
| Windows Credential Manager | FND-04, FND-05 | **Available** (Windows 11 standard component); three targets already stored per additional_context | n/a | No fallback — this is the designated secret store |
| Memurai (Redis for Windows) | FND-03 | **UNKNOWN — not probed** | — | Install via `winget install MemuraiDeveloper`. Alternative: WSL2 Redis OR Docker Desktop Redis |
| Visual Studio Build Tools | better-sqlite3 fallback compile | **UNKNOWN** | — | Only needed if prebuilt binary fails to install. Install via Visual Studio 2022 Community + C++ workload OR deprecated `windows-build-tools` npm |
| gitleaks | FND-10 | **UNKNOWN** | — | Install via `winget install gitleaks.gitleaks` OR direct binary from GitHub releases |
| MEXC API (spot base URL) | FND-06, FND-08 | **Reachable expected** (public internet; network check) | — | None — if unreachable, the whole project is blocked until reachable |
| MEXC API (futures base URL) | FND-07, FND-08 | **Reachable expected** (currently `https://contract.mexc.com`; Jan 12 2026 migration — verify at plan time) | — | Config-driven URL — override via env if migration has already happened by plan-time |

**Missing dependencies with no fallback:**
- Windows Credential Manager secrets already stored (three confirmed targets) — if any secret is missing, `pnpm setup:credentials` script re-provisions interactively.

**Missing dependencies with fallback:**
- Memurai: WSL2 Redis or Docker Desktop are viable but heavier. Plan should include a step that probes Memurai availability and offers install command.
- better-sqlite3 prebuild: falls back to source compile; requires VS Build Tools.
- gitleaks: direct binary download from GitHub if `winget` not configured.

**Action items for planner:**
1. Add a Wave 0 task: `scripts/preflight-windows.ps1` that probes Node 22, pnpm 9, Memurai service, gitleaks binary, and Windows Credential Manager targets. Emits a checklist with install commands for each missing item.
2. Add a Wave 0 doc: `docs/setup-windows.md` that enumerates the `winget` install commands in order.
3. Do NOT assume `which X` / `command -v X` work — Matt's bash is broken. Use PowerShell `Get-Command X -ErrorAction SilentlyContinue` OR `where.exe X` (native Windows).

## Code Examples

Verified patterns from official sources:

### Example 1: pnpm-workspace.yaml

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
```

### Example 2: turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["**/.env.example", "tsconfig.base.json", "biome.json"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "lint": {
      "outputs": []
    },
    "smoke": {
      "cache": false,
      "persistent": false
    }
  }
}
```

### Example 3: tsconfig.base.json (strict mode per FND-01)

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": false,
    "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true,
    "composite": false
  }
}
```

### Example 4: Root `package.json`

```json
{
  "name": "kr8tiv-mexc-bot",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": {
    "node": ">=22.0.0 <23.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "dev": "turbo dev --filter=core",
    "build": "turbo build",
    "typecheck": "turbo typecheck",
    "test": "turbo test",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "smoke": "turbo smoke --filter=core",
    "setup:credentials": "tsx scripts/setup-credentials.ts",
    "verify-env": "tsx scripts/verify-env.ts",
    "preflight": "powershell -ExecutionPolicy Bypass -File scripts/preflight-windows.ps1"
  }
}
```

### Example 5: biome.json (Windows CRLF + strict)

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.0/schema.json",
  "files": {
    "ignore": ["dist", "node_modules", ".turbo", "coverage", "data"]
  },
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": { "noUnusedImports": "error", "noUnusedVariables": "error" },
      "style": { "useImportType": "error", "useConst": "error" },
      "suspicious": { "noExplicitAny": "warn", "noConsoleLog": "error" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "lineEnding": "crlf"
  },
  "javascript": {
    "formatter": { "quoteStyle": "double", "semicolons": "always", "trailingCommas": "all" }
  }
}
```

Note: `"suspicious.noConsoleLog": "error"` is load-bearing — prevents accidental `console.log(secret)` per Pitfall 2.

### Example 6: Zod schemas for MEXC responses

```typescript
// packages/shared-schemas/src/mexc.ts
import { z } from "zod";

// GET /api/v3/ping returns {}
// GET /api/v3/time returns { serverTime: number }
export const MexcSpotPingSchema = z.object({});
export const MexcSpotTimeSchema = z.object({ serverTime: z.number().int().positive() });

// GET /api/v1/contract/ping returns { success: true, code: 0, data: 1645539742000 }
export const MexcFuturesPingSchema = z.object({
  success: z.boolean(),
  code: z.number(),
  data: z.number().int().positive(),
});

// Combined smoke-test response
export const MexcPingResponseSchema = z.object({
  serverTime: z.number().int().positive(),
});

// Spot balance response (trimmed CCXT unified shape)
export const MexcBalanceResponseSchema = z.object({
  info: z.unknown(),
  total: z.record(z.string(), z.number()),
  free: z.record(z.string(), z.number()),
  used: z.record(z.string(), z.number()),
});
export type AccountInfo = z.infer<typeof MexcBalanceResponseSchema>;
```

### Example 7: .env.example (committed — never secrets)

```bash
# Copy to `.env.local` and adjust for your dev environment.
# ALL secrets are in Windows Credential Manager — do NOT put keys here.

NODE_ENV=development
LOG_LEVEL=info
LOG_PRETTY=true

# MEXC base URLs — currently production defaults. Override when MEXC migrates.
MEXC_SPOT_BASE_URL=https://api.mexc.com
MEXC_FUTURES_BASE_URL=https://contract.mexc.com

# MEXC request window (milliseconds). Max 5000 per MEXC docs.
MEXC_RECV_WINDOW_MS=5000

# Redis connection — default Memurai local.
REDIS_URL=redis://127.0.0.1:6379

# SQLite path — relative to apps/core cwd.
SQLITE_PATH=./data/core.sqlite
```

### Example 8: setup-credentials CLI (scripts/setup-credentials.ts)

```typescript
// scripts/setup-credentials.ts
// Run via: pnpm setup:credentials
// Prompts for each required secret and writes to Windows Credential Manager.

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { WindowsCredentialManagerProvider, type SecretName } from "@kr8tiv/secrets";

const REQUIRED: SecretName[] = [
  "mexc-spot-access",
  "mexc-spot-secret",
  "mexc-whitelist-ip",
  // Phase 3 adds: "telegram-bot-token"
  // Phase 6 adds: "mexc-futures-access", "mexc-futures-secret"
];

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const provider = new WindowsCredentialManagerProvider();

  console.log("kr8tiv-mexc-bot — credential setup");
  console.log("This writes directly to Windows Credential Manager. Press Enter to skip any secret that's already set.\n");

  for (const name of REQUIRED) {
    const exists = await provider.has(name);
    const prompt = exists
      ? `${name}  [already set — enter to keep, paste new value to replace]: `
      : `${name}  [not set — paste value]: `;
    const value = (await rl.question(prompt)).trim();
    if (value.length === 0) {
      console.log(exists ? "  (kept)" : "  (skipped — still missing)");
      continue;
    }
    await provider.set(name, value);
    console.log(`  (set ${value.length} chars)`);
  }

  rl.close();

  const missing = (await Promise.all(
    REQUIRED.map(async n => ({ n, ok: await provider.has(n) }))
  )).filter(x => !x.ok).map(x => x.n);

  if (missing.length > 0) {
    console.error(`\nMissing secrets: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll required secrets provisioned.");
}

main().catch(err => { console.error(err); process.exit(1); });
```

### Example 9: Logger config (apps/core/src/logger.ts)

```typescript
// apps/core/src/logger.ts
import pino from "pino";
import { env } from "@kr8tiv/config";

export const logger = pino({
  name: "kr8tiv-mexc-bot",
  level: env.LOG_LEVEL,
  base: { pid: process.pid, hostname: require("node:os").hostname() },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "apiKey", "secret", "password", "token",
      "*.apiKey", "*.secret", "*.password", "*.token",
      "**.apiKey", "**.secret",
      'req.headers["x-mexc-apikey"]',
      'req.headers["x-mexc-signature"]',
      'req.headers["authorization"]',
      'res.headers["set-cookie"]',
      "config.apiKey", "config.secret", "config.headers",
      "mexc.apiKey", "mexc.secret",
      "telegramToken", "telegram.token", "*.telegramToken",
      "walletAddress", "*.walletAddress",
      "*.key", "*.Key",
    ],
    censor: "[REDACTED]",
    remove: false,
  },
  transport: env.LOG_PRETTY
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined,
});
```

### Example 10: Boot smoke test (apps/core/src/smoke.ts)

```typescript
// apps/core/src/smoke.ts — invoked by `pnpm smoke`
import { boot } from "./boot.js";
import { logger } from "./logger.js";

async function main() {
  try {
    const { redis, db, spot, futures } = await boot();
    logger.info("smoke test passed");

    // Clean shutdown for smoke test
    await redis.quit();
    db.close();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, "smoke test failed");
    process.exit(1);
  }
}
main();
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `node-keytar` for Windows Credential Manager | `@zowe/secrets-for-zowe-sdk` | keytar archived Dec 2022 | keytar breaks silently on new Node versions. Zowe is the explicit replacement |
| `ts-node` as TS dev runner | `tsx` | ts-node ESM broken ~2023 | tsx is 2026 default; native ESM; faster startup |
| `husky` for git hooks | `lefthook` (for Windows where bash is fragile) | ongoing | lefthook is Rust binary, no shell dependency — critical when Git Bash is broken |
| ESLint + Prettier | `biome` 2.x | biome GA 2024; 2.3 shipped CRLF default | 10-100x faster; single tool; single config |
| `mexc-api-sdk` (official) | `ccxt` | ongoing (mexc-sdk abandoned) | CCXT actively maintained; handles spot+swap |
| `@solana/web3.js` v1 | `@solana/kit` (v2 renamed) | Dec 2024 | Smaller bundles, better TS. Not relevant until Phase 7 |
| Redis on Windows native (MS fork) | `Memurai Developer` | MS abandoned 2016 | Memurai is the legitimate Windows Redis |
| `Bull` | `BullMQ` | Bull EOL 2026 | TS-native, Redis-based, active |
| `ethers.js` v5 | `viem` (for greenfield) | ongoing | Only relevant Phase 7 |
| `mongoose`/MongoDB for ledger | `better-sqlite3` WAL | n/a (never correct for this use case) | ACID > schema flexibility for money data |

**Deprecated/outdated (do not use):**
- `keytar`: archived Dec 2022 — use `@zowe/secrets-for-zowe-sdk`
- `mexc-api-sdk`: abandoned — use `ccxt`
- `oboshto/mexc-futures-sdk` and `vecful/mexc-futures-api`: browser-session-token reverse-engineering; ToS violation; account ban risk
- `@theothergothamdev/mexc-sdk`: unofficial fork — reference only
- `ts-node`, `blessed-contrib`, `MicrosoftArchive/redis`, `Bull` (vs BullMQ), `node-redis` v3
- `Express` for new greenfield (use Fastify in Phase 9)

## Open Questions

1. **Exact CCXT implicit method for MEXC futures ping**
   - What we know: MEXC futures docs expose `GET /api/v1/contract/ping`. CCXT exposes exchange-specific endpoints via implicit methods (naming convention: `{market}{Visibility}{Method}{Path}` → e.g., `contractPublicGetPing`).
   - What's unclear: the exact method name in CCXT 4.5.48+ — may be `contractPublicGetPing`, `contractV1PublicGetPing`, or reachable via `.publicGetContractPing` on a swap-configured instance.
   - Recommendation: during implementation, try `(exchange as any).contractPublicGetPing()` first. If not present, fallback to raw `fetch(env.MEXC_FUTURES_BASE_URL + '/api/v1/contract/ping')`. Plan should include a 30-minute spike task to resolve.

2. **CCXT `urls.api` override for MEXC shape**
   - What we know: CCXT exchange instances accept `urls.api` as a nested object; for MEXC the keys include `spot`, `spotPublic`, `swap`, `swapPublic`, `swapPrivate`.
   - What's unclear: which exact key names CCXT 4.5.48+ consults for HTTP routing — key names have drifted across CCXT versions.
   - Recommendation: plan should include a "print `ccxt.mexc().urls.api` after construction" debug line during implementation to confirm correct keys.

3. **Whether `kr8tiv-mexc-bot/mexc-whitelist-ip` is consumed in Phase 1**
   - What we know: Additional_context lists it as one of three provisioned secrets. FND-11 is an operational verification (IP whitelist set on MEXC UI).
   - What's unclear: Does Phase 1 code actually read the IP from Credential Manager and compare to the machine's current public IP? If so, how (via `ipify` or similar)?
   - Recommendation: Phase 1 reads it on boot, compares to current public IP via `fetch('https://api.ipify.org')`, logs a WARN if mismatched. Not a hard fail (IP can change, Matt may have VPN). Plan should include this as a small guard task.

4. **Memurai 10-day restart — does it affect boot sequence?**
   - What we know: Memurai Developer requires service restart every 10 days (free-tier limit).
   - What's unclear: Does the restart silently fail-closed? Does the Memurai service auto-restart after 10 days, or does the user need to intervene?
   - Recommendation: Accept as operational minor pitfall. On Redis `ECONNREFUSED`, log a clear "is Memurai running? Try `Start-Service Memurai` or `winget install MemuraiDeveloper --force`".

5. **Jan 12 2026 MEXC futures domain migration — status at plan-time (April 17 2026)**
   - What we know: STATE.md flags this as an open research question. Migration was supposed to happen Jan 12 2026.
   - What's unclear: Has the migration already happened? Is `contract.mexc.com` still the active domain?
   - Recommendation: Before starting any plan, curl `https://contract.mexc.com/api/v1/contract/ping` — if it returns 404 or SSL fails, the migration happened and the default in `env.MEXC_FUTURES_BASE_URL` needs updating. This is a 30-second pre-flight task.

6. **Does Matt's Node version support `better-sqlite3` prebuilts?**
   - What we know: Matt is on Windows 11 x64. better-sqlite3 12.9.0 ships Windows x64 prebuilts for Node 18-22.
   - What's unclear: Matt's actual installed Node version (bash probe failed).
   - Recommendation: Wave 0 preflight task: verify `node --version` returns 22.x. If not, install via `winget install OpenJS.NodeJS.LTS`.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 2.1+ |
| Config file | `vitest.config.ts` per package (minimal — inherits Turbo) + root `vitest.workspace.ts` for monorepo-wide runs |
| Quick run command | `pnpm -F <pkg> test -- --run` (single package) |
| Full suite command | `pnpm turbo test` |
| Coverage | `pnpm turbo test -- --coverage` (v8 reporter) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FND-01 | pnpm + Turborepo monorepo boots; TS strict compiles | smoke | `pnpm turbo typecheck` | ❌ Wave 0 — scaffold creates `tsconfig.base.json`, `turbo.json`, `pnpm-workspace.yaml` |
| FND-02 | SQLite opens in WAL with synchronous=FULL | unit | `pnpm -F core test -- --run src/boot.test.ts -t "sqlite WAL"` | ❌ Wave 0 |
| FND-03 | Redis connects and PING returns PONG | smoke | `pnpm -F core test -- --run src/boot.test.ts -t "redis ping"` | ❌ Wave 0 |
| FND-04 | SecretProvider reads/writes/lists/deletes via Windows Credential Manager | integration | `pnpm -F secrets test -- --run src/provider.test.ts` | ❌ Wave 0 — requires a test-only secret `kr8tiv-mexc-bot-test/foo`; teardown removes it |
| FND-05 | All three required secrets present in Credential Manager on boot; missing secrets reported explicitly | unit (mocked secrets) + manual verification | Unit: `pnpm -F core test -- -t "pre-flight missing secrets"`. Manual: `pnpm verify-env` exits 0 | ❌ Wave 0 |
| FND-06 | MEXCSpotClient constructs with options.defaultType='spot', URL overrides work | unit | `pnpm -F mexc-spot test -- --run src/client.test.ts` | ❌ Wave 0 — uses CCXT mock, not live calls |
| FND-06 | MEXCSpotClient.ping() returns a valid serverTime | integration (live) | `pnpm smoke` OR `pnpm -F mexc-spot test -- --run src/client.live.test.ts` | ❌ Wave 0; `.live.test.ts` skipped in CI unless `MEXC_LIVE=1` |
| FND-06 | MEXCSpotClient.getAccountInfo() succeeds AND pino redaction masks apiKey in log output | integration (live) + unit (redaction) | Integration: manual smoke. Unit: `pnpm -F core test -- -t "logger redacts apiKey"` | ❌ Wave 0 |
| FND-07 | MEXCFuturesClient constructs with options.defaultType='swap', independent rate bucket from spot | unit | `pnpm -F mexc-futures test -- --run src/client.test.ts` | ❌ Wave 0 |
| FND-07 | MEXCFuturesClient.ping() returns a valid serverTime | integration (live) | `pnpm smoke` | ❌ Wave 0 |
| FND-08 | Boot smoke test pings both endpoints in parallel; fails fast if either is unreachable | integration (live) | `pnpm smoke` — exit code 0 on both-ok, 2 on either-fail | ❌ Wave 0 |
| FND-08 | Clear error message identifies WHICH endpoint failed | unit | `pnpm -F core test -- -t "smoke reports which endpoint"` | ❌ Wave 0 |
| FND-09 | pino redacts apiKey, secret, tokens, wallet addrs in logged objects | unit | `pnpm -F core test -- --run src/logger.test.ts` — asserts `[REDACTED]` in output for each pattern | ❌ Wave 0 |
| FND-10 | gitleaks rejects a staged file containing `mx0testkey...` | integration (subprocess) | `pnpm -F core test -- --run src/gitleaks.test.ts` — spawns `git commit --dry-run` against a fixture with a planted secret | ❌ Wave 0 |
| FND-10 | gitleaks config recognizes Telegram bot token format | integration | same as above with Telegram token fixture | ❌ Wave 0 |
| FND-11 | MEXC API key is trading-only + IP-whitelisted | **manual-only** — no API exposes "has withdrawal permission". Operator checklist in `docs/phase-1-readiness.md` | manual verification pre-Phase-2 | ❌ Wave 0 — doc stub |

### Sampling Rate

- **Per task commit:** `pnpm turbo typecheck && pnpm turbo lint && pnpm turbo test -- --run` (all unit tests only; excludes `.live.test.ts`)
- **Per wave merge:** `pnpm turbo typecheck && pnpm turbo test -- --run && MEXC_LIVE=1 pnpm smoke` (adds live smoke test once credentials are provisioned)
- **Phase gate (before `/gsd:verify-work`):** Full suite green + `pnpm smoke` exits 0 + `pnpm -F core test -- --run src/gitleaks.test.ts` passes + manual FND-11 checklist signed in `docs/phase-1-readiness.md`

### Wave 0 Gaps

- [ ] `apps/core/src/boot.test.ts` — covers FND-02 (SQLite WAL), FND-03 (Redis ping), FND-05 (missing-secret reporting)
- [ ] `apps/core/src/logger.test.ts` — covers FND-09 (pino redaction patterns)
- [ ] `apps/core/src/smoke.test.ts` OR `apps/core/src/boot.integration.test.ts` — covers FND-08 (dual-endpoint ping smoke)
- [ ] `apps/core/src/gitleaks.test.ts` — covers FND-10 (subprocess-based hook verification)
- [ ] `packages/secrets/src/provider.test.ts` — covers FND-04 (Zowe read/write/list/delete cycle against a test service `kr8tiv-mexc-bot-test/*`)
- [ ] `packages/mexc-spot/src/client.test.ts` — covers FND-06 (CCXT constructor args, URL override)
- [ ] `packages/mexc-spot/src/client.live.test.ts` — skipped in CI; runs with `MEXC_LIVE=1` env
- [ ] `packages/mexc-futures/src/client.test.ts` — covers FND-07 (CCXT constructor args, independent rate bucket)
- [ ] `packages/mexc-futures/src/client.live.test.ts` — skipped in CI; live futures ping
- [ ] `vitest.workspace.ts` at repo root — declares `apps/*/vitest.config.ts` + `packages/*/vitest.config.ts`
- [ ] `docs/phase-1-readiness.md` — FND-11 manual verification checklist (MEXC UI screenshots scaffold)
- [ ] `scripts/preflight-windows.ps1` — probes Node, pnpm, Memurai, gitleaks, Windows Credential Manager targets
- [ ] Framework install: `pnpm add -D -w vitest@^2 @vitest/coverage-v8@^2` — if not already in root `package.json`

## Sources

### Primary (HIGH confidence)

- [STACK.md (in-project)](C:\Users\lucid\Desktop\kr8tiv-mexc-bot\.planning\research\STACK.md) — stack choices already validated upstream
- [ARCHITECTURE.md (in-project)](C:\Users\lucid\Desktop\kr8tiv-mexc-bot\.planning\research\ARCHITECTURE.md) — two-client separation rationale, boot sequence, anti-patterns
- [PITFALLS.md (in-project)](C:\Users\lucid\Desktop\kr8tiv-mexc-bot\.planning\research\PITFALLS.md) — MEXC-specific gotchas, secret leakage, WS disconnect, 15 critical pitfalls
- [SUMMARY.md (in-project)](C:\Users\lucid\Desktop\kr8tiv-mexc-bot\.planning\research\SUMMARY.md) — executive synthesis, Phase 1 scope
- [MEXC Spot API v3 General Info](https://www.mexc.com/api-docs/spot-v3/general-info) — spot auth, rate limits, recvWindow
- [MEXC Spot API Market Data Endpoints](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints) — GET /api/v3/ping + /api/v3/time response shapes
- [MEXC Futures Integration Guide](https://www.mexc.com/api-docs/futures/integration-guide) — futures HMAC signing, header conventions
- [MEXC Futures Market Endpoints](https://www.mexc.com/api-docs/futures/market-endpoints) — GET /api/v1/contract/ping rate limit 20req/2s
- [MEXC API Announcements](https://www.mexc.com/announcements/api-updates) — domain migration tracking
- [CCXT on GitHub](https://github.com/ccxt/ccxt) — `options.defaultType` pattern, per-instance rate limiter
- [CCXT MEXC docs](https://docs.ccxt.com/exchanges/mexc) — unified client reference
- [Pino redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md) — verified: path syntax supports `a.b.c`, `a["b-c"].d`, `a.b.*`, `a[*].b`; default censor `[Redacted]`; ~50% wildcard overhead
- [Gitleaks README](https://github.com/gitleaks/gitleaks) — TOML config format, custom `[[rules]]` with regex+keywords, pre-commit integration
- [Memurai Developer on Redis.io](https://redis.io/tutorials/howtos/how-to-run-redis-on-windows-natively-with-memurai/) — `winget install MemuraiDeveloper`, Redis 7.2.6 API compatible
- [Memurai Developer System Requirements](https://www.memurai.com/get-memurai) — Windows 10/Server 2012+, 10-day restart for free tier
- [Turborepo structure guide](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository) — apps/ + packages/ convention
- [@t3-oss/env-core docs](https://env.t3.gg/docs/core) — Zod schema, `emptyStringAsUndefined: true` for default values, `createEnv` pattern
- [Biome 2.3 schema](https://biomejs.dev/schemas/2.3.0/schema.json) — `lineEnding: "crlf"` for Windows, `noConsoleLog`

### Secondary (MEDIUM confidence)

- [@zowe/secrets-for-zowe-sdk Medium article](https://medium.com/zowe/secrets-for-zowe-sdk-d8f6a485c7ae) — explicit keytar drop-in; API methods (setPassword, getPassword, findPassword, findCredentials, deletePassword)
- [MEXC key format examples](https://github.com/mexcdevelop/mexc-api-postman) — public examples showing `mx0...` prefix + 32-char hex secret
- [LeftHook docs](https://github.com/evilmartians/lefthook) — Rust binary, no shell dependency — critical for broken Git Bash
- [better-sqlite3 Windows prebuilts](https://github.com/WiseLibs/better-sqlite3/issues/1384) — Node 22 supported via prebuilds; Node 24 gaps existed
- [wake-event npm (12 years old)](https://www.npmjs.com/package/wake-event) — not needed Phase 1 but documents landscape for Phase 5

### Tertiary (LOW confidence — flagged for validation during planning)

- [Telegram bot token regex](https://core.telegram.org/bots/api) — inferred pattern `[0-9]{9,10}:[A-Za-z0-9_-]{35}` from common BotFather outputs; confirm with current BotFather sample during Phase 3
- Exact CCXT implicit method name for `/api/v1/contract/ping` — likely `contractPublicGetPing` but must be verified empirically; see Open Question 1
- Memurai free-tier 10-day restart behavior — document for plan but verify during implementation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all choices validated upstream in STACK.md; no re-debate needed
- Architecture: HIGH — two-client separation + six-package layout + boot sequence derived from ARCHITECTURE.md + PITFALLS.md anti-patterns
- Pitfalls: HIGH — MEXC-specific pitfalls sourced from PITFALLS.md (which is HIGH confidence against official MEXC docs); Windows pitfalls (bash broken, Memurai) verified from live context
- SecretProvider API: HIGH — Zowe API surface verified via web search; brand type pattern standard TS
- MEXC ping endpoints: HIGH — both URLs + response shapes verified against official MEXC docs
- CCXT rate-bucket separation: HIGH — leaky-bucket per-instance confirmed via CCXT manual
- Gitleaks MEXC rule: MEDIUM — regex is correct by inspection but must be tested against real keys to catch edge cases (e.g., trailing whitespace, URL-encoded values)
- pino redaction wildcard list: MEDIUM — paths listed are comprehensive for known surfaces; new secret shapes in Phase 3/6/7 will require additions

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (30-day shelf life — stack is stable; flag is Jan 12 2026 MEXC futures domain migration status which should be re-verified at plan-time)
