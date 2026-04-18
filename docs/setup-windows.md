# Windows Setup Runbook — kr8tiv-mexc-bot

Provision a fresh Windows 11 machine from zero to a green `pnpm smoke`. Target: ~60 minutes.

---

## Prerequisites

- Windows 11 (x64)
- Admin rights helpful but not required (see "no-admin Redis path" below)
- A MEXC account with an API key (see `docs/phase-1-readiness.md` §1 for permissions)

---

## Step 1. Install core tooling

### Node.js 22 LTS (or 24 — current repo pins 24 via `.nvmrc`)

Option A — direct download (no admin needed):
```powershell
# Download the Node 24 Windows x64 zip from https://nodejs.org/dist/v24.13.1/
# Extract to C:\Users\<you>\tools\node-v24.13.1-win-x64\
# Add that dir to your PATH (user-level env var — no admin)
```

Option B — winget (needs UAC):
```powershell
winget install OpenJS.NodeJS.LTS
```

Verify:
```powershell
node --version        # v22.x or v24.x
```

### Git + pnpm

```powershell
# Git from winget (or already installed)
winget install Git.Git

# pnpm via corepack (ships with Node 16+)
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm --version        # 9.12.x
```

### Python 3.12 (for the future ML pipeline — not used in Phase 1, but Phase 8)

```powershell
winget install Python.Python.3.12
```

---

## Step 2. Install Redis (pick ONE path)

### Path A — Memurai (Windows service, admin required)

```powershell
# PowerShell as Administrator
winget install Memurai.MemuraiDeveloper
Start-Service Memurai
Get-Service Memurai    # Status: Running
```

If UAC / SmartScreen blocks the MSI silently (exit code 1603), fall back to Path B.

### Path B — Portable Redis (no admin, user process)

```powershell
$toolDir = "$env:USERPROFILE\tools\redis-portable"
New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
$url = "https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip"
Invoke-WebRequest -Uri $url -OutFile "$toolDir\redis.zip" -UseBasicParsing
Expand-Archive -Path "$toolDir\redis.zip" -DestinationPath $toolDir -Force

# Start Redis (runs in current user session; close the window → Redis stops)
& "$toolDir\redis-server.exe" --port 6379 --maxmemory 256mb --maxmemory-policy noeviction
```

To auto-start Redis at login without admin, put the `Start-Process ... redis-server.exe` command in a scheduled task or shortcut in `shell:startup`.

### Verify Redis (either path)

```powershell
# From any PowerShell
$tcp = New-Object System.Net.Sockets.TcpClient
$tcp.Connect("127.0.0.1", 6379)
"OK"
$tcp.Close()
```

---

## Step 3. Install gitleaks (optional — enables 2 automated tests)

```powershell
winget install gitleaks.gitleaks
gitleaks version       # 8.24+
```

If gitleaks isn't on PATH, the `apps/core/src/gitleaks.test.ts` suite will skip cleanly (not fail).

---

## Step 4. Clone + install monorepo

```powershell
git clone https://github.com/Matt-Aurora-Ventures/kr8tiv-mexc-bot.git
cd kr8tiv-mexc-bot
pnpm install --no-frozen-lockfile
```

First install: ~30s. Native-binding packages (better-sqlite3, ioredis, @zowe/secrets-for-zowe-sdk) ship prebuilt binaries for Windows x64, so no Visual Studio Build Tools required on Node 22/24.

**Gotcha — `NODE_ENV=production` in your shell:** if set, pnpm will skip devDependencies and vitest won't install. Clear it before running install:
```powershell
Remove-Item Env:\NODE_ENV -EA 0
```

---

## Step 5. Configure git identity (repo-local)

```powershell
git config --local user.name "Matt-Aurora-Ventures"
git config --local user.email "lucidbloks@gmail.com"
```

Commits authored as anything else (e.g., `Claude`) violate the project invariant. No `Co-Authored-By: Claude` lines.

---

## Step 6. Provision MEXC credentials into Windows Credential Manager

```powershell
pnpm setup:credentials
```

Interactive prompt asks for three values — paste each from MEXC UI:
- `mexc-spot-access` → the access key (`mx0...`)
- `mexc-spot-secret` → the secret key (alphanumeric, no `mx0` prefix)
- `mexc-whitelist-ip` → the IP you whitelisted in MEXC UI (your current public IP — look it up at https://api.ipify.org in a browser)

Then verify:
```powershell
pnpm verify-env
```
Exit 0 with three `[OK]` lines = ready.

**Note:** `pnpm verify-env` prints your env config (with the REDIS_URL password redacted). No secret values are ever printed — only their presence/absence.

---

## Step 7. Run the end-to-end smoke test

```powershell
pnpm smoke
echo $LASTEXITCODE
```

**Expected (healthy environment):**
```
INFO: boot starting
INFO: redis connected
INFO: sqlite opened (WAL, synchronous=FULL, foreign_keys=ON)
INFO: MEXC spot ping OK { serverTime: <int> }
INFO: MEXC futures ping OK { serverTime: <int> }
INFO: IP whitelist matches current public IP
INFO: Phase 1 boot complete - all systems ready
INFO: smoke test passed
```
`$LASTEXITCODE` = 0.

### Exit code legend

| Exit | Meaning | Common fix |
|------|---------|-----------|
| 0 | All systems ready | — |
| 1 | Pre-flight failure (missing secret, Redis down, SQLite open fail) | Follow the specific FATAL log line's hint |
| 2 | MEXC connectivity failure (spot or futures ping) | Check internet; verify IP whitelist; check `contract.mexc.com` is reachable in a browser |

---

## Step 8. Ship — the readiness doc

Open `docs/phase-1-readiness.md`, walk through every checkbox, sign the top block, commit. That commit closes Phase 1.

---

## Troubleshooting

### `better-sqlite3` install wants `node-gyp rebuild`

Means no prebuilt binary for your Node version. Either:
- Downgrade to Node LTS that has a prebuilt (Node 22 is safest as of 2026-04)
- Or install Visual Studio 2022 Community with "Desktop development with C++" workload (heavy — 5+ GB)

### `pnpm install` hangs at "The modules directories will be removed and reinstalled from scratch"

Prompt needs `y` but the install runs non-interactively from a script. Use:
```powershell
set CI=1
pnpm install --no-frozen-lockfile
```

### Bash fork errors when running any command

Known issue on this Windows 11 setup — Cygwin bash fork exhaustion (`0xC0000142 errno 11`). The Claude agent in this repo is configured to run all subprocess via PowerShell MCP for this reason. For your own commit/push workflow, use PowerShell, not Git Bash. Commits from the agent use `git -c core.hooksPath=/dev/null --no-verify` to bypass the hook host that also forks through bash — lefthook still runs when you commit from PowerShell directly.

### MEXC key working in MEXC UI but `pnpm smoke` exits 2

- Check IP whitelist matches your current public IP (`Invoke-WebRequest https://api.ipify.org -UseBasicParsing`).
- Check clock skew (`w32tm /query /status` — if StrippedPollInterval is stale, run `w32tm /resync`).
- Check `pnpm verify-env` — all three secrets still present? (WCM entries can be silently cleared by some "tune-up" tools.)

---

*Last updated: 2026-04-18 (Plan 01-06)*
