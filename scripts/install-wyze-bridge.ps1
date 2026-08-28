#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install Docker Wyze Bridge on the shop PC so Field App can show Wyze cams
  (Warehouse, Autoshop, Autoshop 2) next to the NVR wall.

.DESCRIPTION
  1. Requires Docker Desktop (or docker engine) already installed.
  2. Creates C:\ProgramData\TotalAssurance\wyze-bridge\
  3. Starts mrlt8/wyze-bridge with RTSP on 8554
  4. Merges Wyze camera defaults into nvr-tunnel proxy-config.json
  5. Reminds you to set WYZE_EMAIL / WYZE_PASSWORD once

  After install:
  - Open http://127.0.0.1:5000 on the shop PC to confirm cameras
  - Match stream names (usually lowercased nicknames) to rtspPath in proxy-config
  - Restart media proxy (easy-cameras-always-on.ps1 or TA-NVR-MediaProxy service)

.PARAMETER WyzeEmail
  Optional Wyze account email (stored only on this PC in .env — never in Field App cloud).

.PARAMETER WyzePassword
  Optional Wyze password.
#>
param(
  [string]$WyzeEmail = "",
  [string]$WyzePassword = "",
  [string]$InstallDir = "C:\ProgramData\TotalAssurance\wyze-bridge",
  [string]$ProxyConfig = "C:\ProgramData\TotalAssurance\nvr-tunnel\proxy-config.json",
  [switch]$SkipDockerPull
)

$ErrorActionPreference = "Stop"

function Write-Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Write-Info($m) { Write-Host "  ..  $m" -ForegroundColor Cyan }
function Write-Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }

Write-Host "`n=== Total Assurance — Wyze Bridge install ===" -ForegroundColor White

# Docker check
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  Write-Warn "Docker not found. Install Docker Desktop for Windows, then re-run this script."
  Write-Host "  https://docs.docker.com/desktop/setup/install/windows-install/"
  exit 1
}
Write-Ok "Docker found: $((docker version --format '{{.Server.Version}}' 2>$null) -or 'ok')"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$envFile = Join-Path $InstallDir ".env"
if (-not (Test-Path $envFile)) {
  if (-not $WyzeEmail) {
    $WyzeEmail = Read-Host "Wyze account email"
  }
  if (-not $WyzePassword) {
    $sec = Read-Host "Wyze account password" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $WyzePassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
  }
  @"
WYZE_EMAIL=$WyzeEmail
WYZE_PASSWORD=$WyzePassword
WB_AUTH=false
API=true
"@ | Set-Content -Path $envFile -Encoding UTF8
  Write-Ok "Wrote $envFile (keep private — shop PC only)"
} else {
  Write-Info "Using existing $envFile"
}

$compose = Join-Path $InstallDir "docker-compose.yml"
@"
services:
  wyze-bridge:
    image: mrlt8/wyze-bridge:latest
    container_name: ta-wyze-bridge
    restart: unless-stopped
    ports:
      - "8554:8554"   # RTSP
      - "5000:5000"   # Web UI / API
      - "8888:8888"   # HLS (optional)
    env_file:
      - .env
    environment:
      - WB_AUTH=false
      - API=true
"@ | Set-Content -Path $compose -Encoding UTF8
Write-Ok "Wrote $compose"

if (-not $SkipDockerPull) {
  Write-Info "Pulling mrlt8/wyze-bridge (first time can take a few minutes)…"
  docker pull mrlt8/wyze-bridge:latest
}

Write-Info "Starting container…"
Push-Location $InstallDir
try {
  docker compose down 2>$null | Out-Null
  docker compose up -d
} finally {
  Pop-Location
}
Write-Ok "Container ta-wyze-bridge started (restart: unless-stopped)"

# Merge Wyze defaults into media proxy config
if (Test-Path $ProxyConfig) {
  try {
    $raw = Get-Content $ProxyConfig -Raw -Encoding UTF8
    if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
    $cfg = $raw | ConvertFrom-Json
  } catch {
    $cfg = [pscustomobject]@{}
  }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $ProxyConfig) | Out-Null
  $cfg = [pscustomobject]@{}
}

$cfg | Add-Member -NotePropertyName wyzeRtspBase -NotePropertyValue "rtsp://127.0.0.1:8554" -Force
$cfg | Add-Member -NotePropertyName wyzeRecord -NotePropertyValue $true -Force
$cfg | Add-Member -NotePropertyName wyzeRecordDir -NotePropertyValue "C:\ProgramData\TotalAssurance\nvr-tunnel\wyze-record" -Force
$cfg | Add-Member -NotePropertyName wyzeRecordRetainHours -NotePropertyValue 72 -Force
$cfg | Add-Member -NotePropertyName wyzeSegmentSec -NotePropertyValue 150 -Force
$cfg | Add-Member -NotePropertyName wyzeCameras -NotePropertyValue @(
  [pscustomobject]@{ id = "warehouse"; label = "Warehouse"; rtspPath = "warehouse"; enabled = $true }
  [pscustomobject]@{ id = "autoshop"; label = "Autoshop"; rtspPath = "autoshop"; enabled = $true }
  [pscustomobject]@{ id = "autoshop-2"; label = "Autoshop 2"; rtspPath = "autoshop-2"; enabled = $true }
) -Force

($cfg | ConvertTo-Json -Depth 6) | Set-Content -Path $ProxyConfig -Encoding UTF8
Write-Ok "Updated $ProxyConfig with Wyze cameras + recording"

Write-Host "`nNext steps:" -ForegroundColor White
Write-Host "  1. Open http://127.0.0.1:5000 on the shop PC — confirm Warehouse, Autoshop, Autoshop 2."
Write-Host "  2. If stream names differ, edit wyzeCameras.rtspPath in proxy-config.json to match the bridge."
Write-Host "  3. Copy latest nvr-media-proxy.mjs from the repo and restart the media proxy service."
Write-Host "     (re-run scripts\easy-cameras-always-on.ps1 or restart TA-NVR-MediaProxy)"
Write-Host "  4. Hard-refresh Field App → Security cameras — Wyze tiles appear with the NVR."
Write-Host "  5. Playback history fills as the ring-buffer records (2.5 min segments, ~72h retain)."
Write-Host ""
Write-Ok "Wyze Bridge install complete."
