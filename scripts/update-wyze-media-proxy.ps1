#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Copy the latest nvr-media-proxy.mjs (with /fieldapp/wyze/*) to the shop install
  and restart the media proxy service / process.

  Run this on the shop NUC after pulling the repo (or copying the script + mjs).
#>
$ErrorActionPreference = "Stop"
$Repo = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $Repo 'scripts\nvr-media-proxy.mjs'))) {
  $Repo = "C:\grok\fueltracker"
}
$RepoProxy = Join-Path $Repo 'scripts\nvr-media-proxy.mjs'
$InstallDir = "C:\ProgramData\TotalAssurance\nvr-tunnel"
$DestProxy = Join-Path $InstallDir 'nvr-media-proxy.mjs'
$CfgPath = Join-Path $InstallDir 'proxy-config.json'

function Write-Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Info($m) { Write-Host "  ..  $m" -ForegroundColor Cyan }
function Write-Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }

Write-Host "`n=== Update media proxy for Wyze ===" -ForegroundColor White

if (-not (Test-Path $RepoProxy)) {
  throw "Missing $RepoProxy — clone/pull fueltracker first"
}
if (-not (Test-Path $InstallDir)) {
  throw "Missing $InstallDir — run easy-cameras-always-on.ps1 first"
}

Copy-Item -Force $RepoProxy $DestProxy
Write-Ok "Copied nvr-media-proxy.mjs → $DestProxy"

# Ensure Wyze keys exist in config
if (Test-Path $CfgPath) {
  $raw = Get-Content $CfgPath -Raw
  if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
  $cfg = $raw | ConvertFrom-Json
  if (-not $cfg.wyzeRtspBase) { $cfg | Add-Member -NotePropertyName wyzeRtspBase -NotePropertyValue 'rtsp://127.0.0.1:8554' -Force }
  if ($null -eq $cfg.wyzeRecord) { $cfg | Add-Member -NotePropertyName wyzeRecord -NotePropertyValue $true -Force }
  if (-not $cfg.wyzeRecordDir) { $cfg | Add-Member -NotePropertyName wyzeRecordDir -NotePropertyValue (Join-Path $InstallDir 'wyze-record') -Force }
  if (-not $cfg.wyzeCameras) {
    $cfg | Add-Member -NotePropertyName wyzeCameras -NotePropertyValue @(
      [pscustomobject]@{ id = 'warehouse'; label = 'Warehouse'; rtspPath = 'warehouse'; enabled = $true }
      [pscustomobject]@{ id = 'autoshop'; label = 'Autoshop'; rtspPath = 'autoshop'; enabled = $true }
      [pscustomobject]@{ id = 'autoshop-2'; label = 'Autoshop 2'; rtspPath = 'autoshop-2'; enabled = $true }
    ) -Force
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($CfgPath, (($cfg | ConvertTo-Json -Depth 6) + "`n"), $utf8)
  Write-Ok "proxy-config.json has Wyze settings"
}

# Restart proxy service if present
$svcNames = @('TA-NVR-MediaProxy', 'ta-nvr-media-proxy', 'NVR-MediaProxy')
$restarted = $false
foreach ($n in $svcNames) {
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  if ($s) {
    Write-Info "Restarting service $n…"
    Restart-Service -Name $n -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $restarted = $true
    Write-Ok "Service $n restarted"
    break
  }
}

if (-not $restarted) {
  Write-Warn "No NSSM media-proxy service found — kill old node proxy and start again"
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'nvr-media-proxy|run-proxy' } |
    ForEach-Object {
      Write-Info "Stopping PID $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  $node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
  if ($node -and (Test-Path (Join-Path $InstallDir 'run-proxy.mjs'))) {
    Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $InstallDir 'run-proxy.mjs')`"" -WorkingDirectory $InstallDir -WindowStyle Hidden
    Write-Ok "Started run-proxy.mjs"
  } else {
    Write-Warn "Start the media proxy manually (easy-cameras-always-on.ps1)"
  }
}

Start-Sleep -Seconds 2
try {
  $h = Invoke-RestMethod "http://127.0.0.1:8791/fieldapp/health" -TimeoutSec 5
  Write-Ok "Health: nvr=$($h.nvr) ffmpeg=$($h.ffmpeg)"
  if ($h.wyze) {
    Write-Ok "Wyze routes live: cams=$($h.wyze.cameras -join ', ')"
  } else {
    Write-Warn "Health has no wyze block — still running old proxy binary?"
  }
} catch {
  Write-Warn "Could not hit http://127.0.0.1:8791/fieldapp/health — is the proxy listening?"
}

Write-Host ""
Write-Host "Also need Wyze Bridge for live video:" -ForegroundColor Cyan
Write-Host "  .\scripts\install-wyze-bridge.ps1"
Write-Host "Then hard-refresh Field App Security cameras."
Write-Host ""
