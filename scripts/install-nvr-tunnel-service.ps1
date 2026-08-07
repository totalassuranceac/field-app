# Install always-on NVR tunnel + media proxy for Field App security cameras.
#
# Run in PowerShell AS ADMINISTRATOR:
#   cd C:\grok\fueltracker\scripts
#   .\install-nvr-tunnel-service.ps1
#
# Stack:
#   cloudflared -> http://127.0.0.1:8790 (media proxy)
#   media proxy -> NVR (snapshots/ISAPI) + /fieldapp/clip (ffmpeg MP4)

$ErrorActionPreference = 'Stop'
$NvrLan = 'http://192.168.1.111'
$ProxyPort = 8791
$ServiceName = 'TA-NVR-Tunnel'
$ProxyServiceName = 'TA-NVR-MediaProxy'
$InstallDir = 'C:\ProgramData\TotalAssurance\nvr-tunnel'
$RepoScripts = Split-Path -Parent $MyInvocation.MyCommand.Path

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host 'ERROR: Run this script as Administrator.' -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# cloudflared
$candidates = @(
  'C:\cloudflared\cloudflared.exe',
  'C:\Program Files\cloudflared\cloudflared.exe',
  (Join-Path $env:USERPROFILE 'Downloads\cloudflared.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if (-not $candidates) {
  New-Item -ItemType Directory -Force -Path 'C:\cloudflared' | Out-Null
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
    -OutFile 'C:\cloudflared\cloudflared.exe' -UseBasicParsing
  $Cloudflared = 'C:\cloudflared\cloudflared.exe'
} else {
  $Cloudflared = $candidates[0]
}
Copy-Item -LiteralPath $Cloudflared -Destination (Join-Path $InstallDir 'cloudflared.exe') -Force

# ffmpeg
$ffDest = Join-Path $InstallDir 'ffmpeg.exe'
if (-not (Test-Path -LiteralPath $ffDest)) {
  Write-Host 'Downloading ffmpeg...'
  $zip = Join-Path $env:TEMP 'ffmpeg-release-essentials.zip'
  Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip -UseBasicParsing
  $extract = Join-Path $env:TEMP 'ffmpeg-extract'
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $bin = Get-ChildItem -Path $extract -Recurse -Filter ffmpeg.exe | Select-Object -First 1
  if (-not $bin) { throw 'ffmpeg.exe not found in download' }
  Copy-Item $bin.FullName $ffDest -Force
}

# media proxy script
$proxySrc = Join-Path $RepoScripts 'nvr-media-proxy.mjs'
if (-not (Test-Path -LiteralPath $proxySrc)) { throw "Missing $proxySrc" }
Copy-Item -LiteralPath $proxySrc -Destination (Join-Path $InstallDir 'nvr-media-proxy.mjs') -Force

# proxy config (password: keep existing if present)
$cfgPath = Join-Path $InstallDir 'proxy-config.json'
$existingPass = ''
$existingUser = 'admin'
if (Test-Path $cfgPath) {
  try {
    $old = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($old.nvrPass) { $existingPass = [string]$old.nvrPass }
    if ($old.nvrUser) { $existingUser = [string]$old.nvrUser }
  } catch {}
}
if (-not $existingPass) {
  Write-Host 'Enter NVR admin password (stored only on this PC in proxy-config.json):'
  $sec = Read-Host -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $existingPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
}
$cfgObj = @{
  nvrBase = $NvrLan
  nvrUser = $existingUser
  nvrPass = $existingPass
  ffmpegPath = $ffDest
  listenPort = $ProxyPort
  maxClipSeconds = 1800
}
$cfgObj | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding utf8

# Node for media proxy
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $node) { throw 'Node.js is required for the media proxy. Install Node LTS and re-run.' }

function Install-ServiceSimple($name, $binPath, $display) {
  $existing = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-Service $name -Force -ErrorAction SilentlyContinue
    sc.exe delete $name | Out-Null
    Start-Sleep 2
  }
  sc.exe create $name binPath= $binPath start= auto DisplayName= $display | Out-Null
  sc.exe failure $name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  Start-Service $name
}

# Stop stray processes
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
    if ($cmd -and $cmd -match 'nvr-media-proxy') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  } catch {}
}
Start-Sleep 1

# Media proxy as a service: cmd launches node (sc.exe quoting is picky)
$proxySc = 'cmd.exe /c ""' + $node + '" "' + $InstallDir + '\nvr-media-proxy.mjs""'
Write-Host "Installing $ProxyServiceName ..."
Install-ServiceSimple $ProxyServiceName $proxySc 'Total Assurance NVR Media Proxy'
Start-Sleep 2

# Verify proxy
try {
  $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ProxyPort/fieldapp/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "Media proxy OK: $($h.Content)"
} catch {
  Write-Host "WARNING: media proxy health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

$logPath = Join-Path $InstallDir 'tunnel.log'
if (Test-Path $logPath) { Remove-Item $logPath -Force }
$tunnelBin = "`"$InstallDir\cloudflared.exe`" tunnel --url http://127.0.0.1:$ProxyPort --protocol http2 --logfile `"$logPath`" --loglevel info"
Write-Host "Installing $ServiceName ..."
Install-ServiceSimple $ServiceName $tunnelBin 'Total Assurance NVR Tunnel'

Write-Host 'Waiting for public URL...'
$publicUrl = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 2
  if (Test-Path $logPath) {
    $match = Select-String -Path $logPath -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
    if ($match) { $publicUrl = $match.Matches[0].Value; break }
  }
}

Write-Host ''
if ($publicUrl) {
  Write-Host '========================================' -ForegroundColor Green
  Write-Host "  PUBLIC URL: $publicUrl" -ForegroundColor Cyan
  Write-Host '========================================' -ForegroundColor Green
  Set-Content -Path (Join-Path $InstallDir 'current-url.txt') -Value $publicUrl -Encoding ascii
  Write-Host 'Save this URL as warehouse_nvr_url in Field App settings (admin/D1).'
} else {
  Write-Host 'Service started; check log for URL:' -ForegroundColor Yellow
  Write-Host "  Get-Content $logPath -Tail 40"
}

Write-Host ''
Write-Host 'Done. Services auto-start at boot.'
Write-Host "  Get-Service $ServiceName,$ProxyServiceName"
