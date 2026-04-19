// packages/secrets/src/win32-fallback.ts
//
// Win32 CredRead fallback for WindowsCredentialManagerProvider.
//
// Why this exists:
//   @zowe/secrets-for-zowe-sdk stores credentials with Win32 TargetName =
//   `${service}/${account}` (derived from keyring-rs semantics). The Windows
//   Credential Manager UI and `cmdkey /generic:target=<X> /user:<Y>` use a
//   different convention: TargetName = `${service}` alone, with the account
//   in the separate UserName field.
//
//   Both are legitimate WCM encodings for the same (service, account) pair.
//   Zowe only knows how to read its own format. This fallback reads the
//   cmdkey/UI convention so credentials provisioned outside our SecretProvider
//   still work.
//
// Safety:
//   - Windows-only; returns null on any other platform
//   - TargetName is validated against a strict whitelist before being
//     interpolated into the PowerShell script — no shell injection surface
//   - Spawned process has a 3-second timeout; we never block boot indefinitely
//   - The password value is returned base64-encoded over stdout to avoid any
//     UTF-16 / newline mangling by the shell pipe
//   - We NEVER log the password value. Callers receive it, caller is
//     responsible for wrapping in Secret<T> brand and using unsafeReveal.

import { spawnSync } from "node:child_process";

/** Only allow chars we know can legitimately appear in a WCM TargetName in our use. */
const SAFE_TARGET_RE = /^[A-Za-z0-9/_\-.]+$/;

/**
 * Build a self-contained PowerShell script that calls Win32 CredRead via
 * P/Invoke for the given TargetName. The target is interpolated directly
 * (safe because caller validated against SAFE_TARGET_RE — no quotes or other
 * injection chars possible). Using `-Command <script> -TargetName <val>`
 * does NOT work because positional args after the script are consumed by
 * powershell itself, not routed to the script.
 */
function buildScript(targetName: string): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class N {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct C {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@ -Language CSharp | Out-Null

[IntPtr]$ptr = [IntPtr]::Zero
# CRED_TYPE_GENERIC = 1. Target interpolated safely (whitelist-validated by caller).
$ok = [N]::CredRead('${targetName}', 1, 0, [ref]$ptr)
if (-not $ok) { exit 2 }
$c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][N+C])
if ($c.CredentialBlobSize -eq 0) { [N]::CredFree($ptr); exit 3 }
$bytes = New-Object byte[] $c.CredentialBlobSize
[System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, [int]$c.CredentialBlobSize)
[N]::CredFree($ptr)
# WCM stores the password as UTF-16 LE. Emit base64(UTF-8 of decoded value).
$value = [System.Text.Encoding]::Unicode.GetString($bytes)
[Console]::Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($value)))
`;
}

/**
 * Read a Windows Credential Manager entry whose TargetName equals `targetName`
 * (i.e., the cmdkey/UI bare-service convention, NOT Zowe's combined format).
 *
 * Returns the password value as a string, or null if:
 *   - we're not on Windows
 *   - the target does not exist
 *   - CredentialBlob is empty
 *   - PowerShell is unavailable or times out
 *   - the TargetName contains unsafe characters
 *
 * This is a READ-only fallback. Writes continue to go through Zowe
 * (preserves round-trip test coverage from Plan 01-02).
 */
export function winCredReadBareTarget(targetName: string): string | null {
  if (process.platform !== "win32") return null;
  if (!SAFE_TARGET_RE.test(targetName)) return null;

  try {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildScript(targetName),
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );
    if (result.status !== 0) return null;
    const b64 = (result.stdout ?? "").trim();
    if (!b64) return null;
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}
