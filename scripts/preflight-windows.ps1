# scripts/preflight-windows.ps1
# Invoked via: pnpm preflight
# Probes all Windows-side prerequisites for Phase 1 and prints a checklist
# with install commands for any missing item.

$ErrorActionPreference = "Continue"
$failures = @()

function Check-Cmd($name, $minVersion, $installCmd) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    Write-Host "[MISSING] $name" -ForegroundColor Red
    Write-Host "          Install: $installCmd"
    return $false
  }
  Write-Host "[OK]      $name found at $($cmd.Source)" -ForegroundColor Green
  return $true
}

Write-Host "`n=== kr8tiv-mexc-bot Windows preflight ===`n" -ForegroundColor Cyan

if (-not (Check-Cmd "node" "22" "winget install OpenJS.NodeJS.LTS")) { $failures += "node" }
else {
  $nodeVer = (& node --version) -replace '^v', ''
  $major = [int]($nodeVer -split '\.')[0]
  if ($major -lt 22 -or $major -ge 23) {
    Write-Host "[WARN]    node version $nodeVer is NOT 22.x (required)" -ForegroundColor Yellow
    $failures += "node-version"
  } else {
    Write-Host "          node version $nodeVer (OK)"
  }
}

if (-not (Check-Cmd "pnpm" "9" "npm install -g pnpm@9")) { $failures += "pnpm" }
if (-not (Check-Cmd "gitleaks" "8.24" "winget install gitleaks.gitleaks")) { $failures += "gitleaks" }
if (-not (Check-Cmd "git" "2" "winget install Git.Git")) { $failures += "git" }

# Memurai (Redis) -- check Windows service
$memurai = Get-Service -Name "Memurai" -ErrorAction SilentlyContinue
if ($null -eq $memurai) {
  Write-Host "[MISSING] Memurai service" -ForegroundColor Red
  Write-Host "          Install: winget install MemuraiDeveloper"
  $failures += "memurai"
} elseif ($memurai.Status -ne "Running") {
  Write-Host "[WARN]    Memurai service present but not Running (current: $($memurai.Status))" -ForegroundColor Yellow
  Write-Host "          Start:   Start-Service Memurai"
  $failures += "memurai-stopped"
} else {
  Write-Host "[OK]      Memurai service Running" -ForegroundColor Green
}

# Windows Credential Manager targets (cannot read values -- only existence)
# We can't probe WCM without a native binding. Just remind the operator.
Write-Host "`n-- Windows Credential Manager --"
Write-Host "Required targets (verify manually or via setup-credentials script after install):"
Write-Host "  - kr8tiv-mexc-bot/mexc-spot-access"
Write-Host "  - kr8tiv-mexc-bot/mexc-spot-secret"
Write-Host "  - kr8tiv-mexc-bot/mexc-whitelist-ip"

if ($failures.Count -gt 0) {
  Write-Host "`n=== $($failures.Count) prerequisite(s) missing ===`n" -ForegroundColor Red
  Write-Host "Fix the items above, then re-run: pnpm preflight"
  exit 1
}

Write-Host "`n=== All preflight checks passed ===`n" -ForegroundColor Green
exit 0
