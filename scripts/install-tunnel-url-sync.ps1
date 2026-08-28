#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install scheduled task so the camera tunnel URL is re-synced after reboot
  and every 2 minutes. Prevents "tunnel offline" when trycloudflare rotates.
#>
$ErrorActionPreference = "Continue"

$ScriptSrc = Join-Path $PSScriptRoot "sync-camera-tunnel-url.ps1"
if (-not (Test-Path $ScriptSrc)) {
  foreach ($c in @(
      "C:\grok\fueltracker\scripts\sync-camera-tunnel-url.ps1",
      "C:\Grok\FuelTracker\scripts\sync-camera-tunnel-url.ps1"
    )) {
    if (Test-Path $c) { $ScriptSrc = $c; break }
  }
}
if (-not (Test-Path $ScriptSrc)) {
  throw "Missing sync-camera-tunnel-url.ps1"
}

$InstallDir = "C:\ProgramData\TotalAssurance\nvr-tunnel"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Installed = Join-Path $InstallDir "sync-camera-tunnel-url.ps1"
Copy-Item -Force $ScriptSrc $Installed
Write-Host "  OK  Installed $Installed" -ForegroundColor Green

function Remove-TaskSafe([string]$name) {
  # schtasks prints "file not found" when missing — ignore that
  $null = cmd /c "schtasks /Delete /TN `"$name`" /F >nul 2>&1"
}

$taskName = "TA-NVR-UrlSync"
$taskLogon = "TA-NVR-UrlSync-Logon"
foreach ($n in @($taskName, $taskLogon, "TA-NVR-UrlSync-User", "TA-NVR-TunnelUrlWatch")) {
  Remove-TaskSafe $n
}

$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$tr = "$ps -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Installed`""

# Every 2 minutes
$out = cmd /c "schtasks /Create /TN `"$taskName`" /TR `"$tr`" /SC MINUTE /MO 2 /RL HIGHEST /F 2>&1"
Write-Host $out
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create $taskName : $out"
}
Write-Host "  OK  Registered $taskName (every 2 minutes)" -ForegroundColor Green

# At user logon
$out2 = cmd /c "schtasks /Create /TN `"$taskLogon`" /TR `"$tr`" /SC ONLOGON /RL HIGHEST /F 2>&1"
Write-Host $out2
if ($LASTEXITCODE -eq 0) {
  Write-Host "  OK  Registered $taskLogon (at logon)" -ForegroundColor Green
} else {
  Write-Host "  !!  Logon task skipped: $out2" -ForegroundColor Yellow
}

Write-Host "  ..  Running sync once..." -ForegroundColor Cyan
& $ps -NoProfile -ExecutionPolicy Bypass -File $Installed
$code = $LASTEXITCODE
Write-Host ""
if ($code -eq 0) {
  Write-Host "Done. After reboot the camera URL will auto-update within a couple of minutes." -ForegroundColor Green
} else {
  Write-Host "Task installed, but one-time sync exit code was $code (tunnel may still be starting)." -ForegroundColor Yellow
}
exit 0
