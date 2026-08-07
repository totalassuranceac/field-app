# Keep-alive starter for Field App security cameras (no Admin required).
# Starts media proxy (port 8790) + cloudflared tunnel to that proxy.
#
# Run when cameras say tunnel offline:
#   cd C:\grok\fueltracker\scripts
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#   .\start-nvr-tunnel.ps1

$ErrorActionPreference = 'Continue'
$InstallDir = 'C:\ProgramData\TotalAssurance\nvr-tunnel'
$RepoProxy = 'C:\grok\fueltracker\scripts\nvr-media-proxy.mjs'
$log = Join-Path $env:TEMP 'cf-nvr-live.log'
$proxyPort = 8791

if (-not (Test-Path -LiteralPath $InstallDir)) {
  Write-Host "Missing $InstallDir - run install-nvr-tunnel-service.ps1 as Admin once first." -ForegroundColor Red
  exit 1
}

if (Test-Path -LiteralPath $RepoProxy) {
  Copy-Item -Force -LiteralPath $RepoProxy -Destination (Join-Path $InstallDir 'nvr-media-proxy.mjs') -ErrorAction SilentlyContinue
}

function Test-Proxy {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$proxyPort/fieldapp/health" -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    if ($c -and $c -match 'nvr-media-proxy') {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
  try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Seconds 1

$proxyScript = Join-Path $InstallDir 'nvr-media-proxy.mjs'
$cloudflared = Join-Path $InstallDir 'cloudflared.exe'
$cfgPath = Join-Path $InstallDir 'proxy-config.json'

if (-not (Test-Path -LiteralPath $proxyScript)) {
  Write-Host "Missing nvr-media-proxy.mjs in $InstallDir" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path -LiteralPath $cloudflared)) {
  Write-Host "Missing cloudflared.exe in $InstallDir" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path -LiteralPath $cfgPath)) {
  Write-Host 'Missing proxy-config.json (NVR password). Re-run install script as Admin.' -ForegroundColor Red
  exit 1
}

Write-Host 'Starting media proxy...'
Start-Process -FilePath 'node' -ArgumentList @($proxyScript) -WorkingDirectory $InstallDir -WindowStyle Hidden
Start-Sleep -Seconds 2
if (-not (Test-Proxy)) {
  Write-Host "Media proxy failed to start on port $proxyPort" -ForegroundColor Red
  exit 1
}
Write-Host 'Media proxy OK'

if (Test-Path -LiteralPath $log) {
  Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
}
Write-Host 'Starting Cloudflare tunnel...'
Start-Process -FilePath $cloudflared -ArgumentList @(
  'tunnel',
  '--url', "http://127.0.0.1:$proxyPort",
  '--protocol', 'http2',
  '--logfile', $log,
  '--loglevel', 'info'
) -WindowStyle Hidden

$publicUrl = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path -LiteralPath $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
    if ($m) {
      $publicUrl = $m.Matches[0].Value
      break
    }
  }
}

if (-not $publicUrl) {
  Write-Host "Tunnel started but URL not found yet. Check: $log" -ForegroundColor Yellow
  exit 1
}

Write-Host ''
Write-Host "PUBLIC URL: $publicUrl" -ForegroundColor Cyan
try {
  Set-Content -Path (Join-Path $InstallDir 'current-url.txt') -Value $publicUrl -Encoding ascii -ErrorAction SilentlyContinue
} catch {}

$repo = 'C:\grok\fueltracker'
if (Test-Path -LiteralPath (Join-Path $repo 'wrangler.toml')) {
  Push-Location $repo
  try {
    $esc = $publicUrl.Replace("'", "''")
    $cmd = "UPDATE settings SET value='$esc' WHERE key='warehouse_nvr_url'"
    npx wrangler d1 execute fleet_db --remote --command $cmd 2>$null | Out-Null
    Write-Host 'Field App camera URL updated.' -ForegroundColor Green
  } catch {
    Write-Host 'Could not auto-update app URL. Paste PUBLIC URL into app settings if needed.' -ForegroundColor Yellow
  }
  Pop-Location
}

Write-Host ''
Write-Host 'Done. Hard-refresh Security cameras in the Field App.'
Write-Host 'Leave this PC on; processes run in the background.'
