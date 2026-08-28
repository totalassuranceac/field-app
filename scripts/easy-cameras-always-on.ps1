#Requires -RunAsAdministrator
<#
.SYNOPSIS
  One-time setup so Field App security cameras stay online without babysitting.

.DESCRIPTION
  Run this ONCE as Administrator on the shop always-on PC (this ASUS NUC is ideal).

  What it does:
    1. Installs media proxy as a real Windows service (NSSM) so it survives reboot
    2. Points Cloudflare tunnel service at the media proxy (not the NVR)
    3. Auto-syncs the public tunnel URL into Field App every few minutes
    4. Stops the PC from sleeping on AC power
    5. Removes flaky user-session workarounds (port 8792)

  After this: leave this PC plugged in at the shop. Your laptop can sleep/travel.

  Usage:
    Right-click PowerShell -> Run as administrator
    cd C:\grok\fueltracker\scripts
    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\easy-cameras-always-on.ps1
#>

$ErrorActionPreference = 'Stop'

$InstallDir = 'C:\ProgramData\TotalAssurance\nvr-tunnel'
$Repo = 'C:\grok\fueltracker'
$RepoProxy = Join-Path $Repo 'scripts\nvr-media-proxy.mjs'
$ProxyPort = 8791
$ProxySvc = 'TA-NVR-MediaProxy'
$TunnelSvc = 'TA-NVR-Tunnel'
$WatchTask = 'TA-NVR-TunnelUrlWatch'
$AccountId = 'f6da342467e60df683731c55dfc0e7b4'

function Write-Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    $msg" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host 'ERROR: Run PowerShell as Administrator, then re-run this script.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '  Field App cameras - easy always-on setup' -ForegroundColor White
Write-Host '  Leave THIS PC plugged in at the shop. That is the whole trick.' -ForegroundColor Gray
Write-Host ''

# -- 0. Prerequisites ------------------------------------------------
Write-Step 'Checking prerequisites'
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $node) { throw 'Node.js is required. Install from https://nodejs.org and re-run.' }
Write-Ok "Node: $node"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$cfDest = Join-Path $InstallDir 'cloudflared.exe'
if (-not (Test-Path $cfDest)) {
  Write-Warn 'Downloading cloudflared...'
  $tmp = Join-Path $env:TEMP 'cloudflared.exe'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
    -OutFile $tmp -UseBasicParsing
  Copy-Item $tmp $cfDest -Force
}
Write-Ok "cloudflared: $cfDest"

$ffDest = Join-Path $InstallDir 'ffmpeg.exe'
if (-not (Test-Path $ffDest)) {
  throw "Missing $ffDest - copy ffmpeg.exe there or re-run install-nvr-tunnel-service.ps1 first."
}
Write-Ok "ffmpeg: $ffDest"

$nssm = Join-Path $InstallDir 'nssm.exe'
if (-not (Test-Path $nssm)) {
  Write-Warn 'Downloading NSSM (service wrapper)...'
  $zip = Join-Path $env:TEMP 'nssm.zip'
  $unz = Join-Path $env:TEMP 'nssm-extract'
  Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
  if (Test-Path $unz) { Remove-Item $unz -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $unz -Force
  $src = Get-ChildItem -Path $unz -Recurse -Filter 'nssm.exe' | Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1
  if (-not $src) { $src = Get-ChildItem -Path $unz -Recurse -Filter 'nssm.exe' | Select-Object -First 1 }
  if (-not $src) { throw 'Could not find nssm.exe in download' }
  Copy-Item $src.FullName $nssm -Force
}
Write-Ok "NSSM: $nssm"

# -- 1. Proxy files --------------------------------------------------
Write-Step 'Installing media proxy files'
if (Test-Path $RepoProxy) {
  Copy-Item -Force $RepoProxy (Join-Path $InstallDir 'nvr-media-proxy.mjs')
  Write-Ok 'Copied latest nvr-media-proxy.mjs from repo'
} elseif (-not (Test-Path (Join-Path $InstallDir 'nvr-media-proxy.mjs'))) {
  throw "Missing nvr-media-proxy.mjs in $InstallDir and no repo copy at $RepoProxy"
}

$cfgPath = Join-Path $InstallDir 'proxy-config.json'
if (-not (Test-Path $cfgPath)) {
  $userCfg = Join-Path $env:USERPROFILE 'ta-nvr-proxy\proxy-config.json'
  if (Test-Path $userCfg) {
    Copy-Item $userCfg $cfgPath -Force
  } else {
    throw "Missing $cfgPath - need NVR password config (nvrBase/nvrUser/nvrPass)."
  }
}

# Force listenPort 8791 via PowerShell (UTF-8 WITHOUT BOM - BOM breaks node JSON.parse)
$rawCfg = Get-Content $cfgPath -Raw
if ($rawCfg.Length -gt 0 -and [int][char]$rawCfg[0] -eq 0xFEFF) { $rawCfg = $rawCfg.Substring(1) }
$cfgObj = $rawCfg | ConvertFrom-Json
$cfgObj.listenPort = 8791
$cfgObj.ffmpegPath = $ffDest
if (-not $cfgObj.nvrBase) { $cfgObj | Add-Member -NotePropertyName nvrBase -NotePropertyValue 'http://192.168.1.111' -Force }
# Wyze defaults (Bridge RTSP + local ring-buffer for Field App playback)
if (-not $cfgObj.wyzeRtspBase) { $cfgObj | Add-Member -NotePropertyName wyzeRtspBase -NotePropertyValue 'rtsp://127.0.0.1:8554' -Force }
if ($null -eq $cfgObj.wyzeRecord) { $cfgObj | Add-Member -NotePropertyName wyzeRecord -NotePropertyValue $true -Force }
if (-not $cfgObj.wyzeRecordDir) {
  $cfgObj | Add-Member -NotePropertyName wyzeRecordDir -NotePropertyValue (Join-Path $InstallDir 'wyze-record') -Force
}
if (-not $cfgObj.wyzeRecordRetainHours) { $cfgObj | Add-Member -NotePropertyName wyzeRecordRetainHours -NotePropertyValue 72 -Force }
if (-not $cfgObj.wyzeSegmentSec) { $cfgObj | Add-Member -NotePropertyName wyzeSegmentSec -NotePropertyValue 150 -Force }
if (-not $cfgObj.wyzeCameras) {
  $cfgObj | Add-Member -NotePropertyName wyzeCameras -NotePropertyValue @(
    [pscustomobject]@{ id = 'warehouse'; label = 'Warehouse'; rtspPath = 'warehouse'; enabled = $true }
    [pscustomobject]@{ id = 'autoshop'; label = 'Autoshop'; rtspPath = 'autoshop'; enabled = $true }
    [pscustomobject]@{ id = 'autoshop-2'; label = 'Autoshop 2'; rtspPath = 'autoshop-2'; enabled = $true }
  ) -Force
}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($cfgPath, (($cfgObj | ConvertTo-Json -Depth 6) + "`n"), $utf8NoBom)
Write-Ok "config ok port=$($cfgObj.listenPort) nvr=$($cfgObj.nvrBase) passSet=$([bool]$cfgObj.nvrPass) wyze=$($cfgObj.wyzeCameras.Count)"

$launch = Join-Path $InstallDir 'run-proxy.mjs'
$cfgUnix = ($InstallDir -replace '\\', '/') + '/proxy-config.json'
$launchBody = "process.env.NVR_PROXY_PORT = '8791';`nprocess.env.NVR_PROXY_CONFIG = '$cfgUnix';`nawait import('./nvr-media-proxy.mjs');`n"
[System.IO.File]::WriteAllText($launch, $launchBody)
Write-Ok "Launcher: $launch"

# -- 2. Stop flaky user-space stack ----------------------------------
Write-Step 'Stopping old / flaky camera processes'
foreach ($svc in @($TunnelSvc, $ProxySvc)) {
  if (Get-Service $svc -ErrorAction SilentlyContinue) {
    Stop-Service $svc -Force -ErrorAction SilentlyContinue
  }
}
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and ($_.CommandLine -match 'nvr-media-proxy|proxy-supervisor|ta-nvr-proxy|run-proxy')) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Unregister-ScheduledTask -TaskName 'TA-NVR-KeepAlive' -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep 2
Write-Ok 'Cleared old processes'

# -- 3. Media proxy as NSSM service ----------------------------------
Write-Step "Installing $ProxySvc (real auto-restart service)"
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
if (Get-Service $ProxySvc -ErrorAction SilentlyContinue) {
  & $nssm stop $ProxySvc 2>&1 | Out-Null
  & $nssm remove $ProxySvc confirm 2>&1 | Out-Null
  sc.exe delete $ProxySvc 2>&1 | Out-Null
  Start-Sleep 1
}

$installOut = & $nssm install $ProxySvc $node $launch 2>&1
Write-Host "    nssm install: $installOut"
& $nssm set $ProxySvc AppDirectory $InstallDir 2>&1 | Out-Null
& $nssm set $ProxySvc DisplayName 'Total Assurance NVR Media Proxy' 2>&1 | Out-Null
& $nssm set $ProxySvc Description 'Field App security cameras - NVR snapshot/clip proxy + ffmpeg' 2>&1 | Out-Null
& $nssm set $ProxySvc Start SERVICE_AUTO_START 2>&1 | Out-Null
& $nssm set $ProxySvc AppStdout (Join-Path $InstallDir 'proxy-stdout.log') 2>&1 | Out-Null
& $nssm set $ProxySvc AppStderr (Join-Path $InstallDir 'proxy-stderr.log') 2>&1 | Out-Null
& $nssm set $ProxySvc AppRotateFiles 1 2>&1 | Out-Null
& $nssm set $ProxySvc AppRotateBytes 2000000 2>&1 | Out-Null
& $nssm set $ProxySvc AppExit Default Restart 2>&1 | Out-Null
& $nssm set $ProxySvc AppRestartDelay 3000 2>&1 | Out-Null
& $nssm set $ProxySvc ObjectName LocalSystem 2>&1 | Out-Null
sc.exe failure $ProxySvc reset= 86400 actions= restart/3000/restart/5000/restart/10000 | Out-Null
$ErrorActionPreference = $prevEap
Start-Service $ProxySvc
Start-Sleep 3

$proxyOk = $false
for ($i = 0; $i -lt 12; $i++) {
  try {
    $h = Invoke-WebRequest "http://127.0.0.1:$ProxyPort/fieldapp/health" -UseBasicParsing -TimeoutSec 3
    Write-Ok "Media proxy healthy: $($h.Content)"
    $proxyOk = $true
    break
  } catch {
    Start-Sleep 1
  }
}
if (-not $proxyOk) {
  Write-Warn "Proxy health failed. Check $(Join-Path $InstallDir 'proxy-stderr.log')"
  if (Test-Path (Join-Path $InstallDir 'proxy-stderr.log')) {
    Get-Content (Join-Path $InstallDir 'proxy-stderr.log') -Tail 20
  }
  throw 'Media proxy did not become healthy on port 8791'
}

# -- 4. Tunnel service -> proxy --------------------------------------
Write-Step "Installing $TunnelSvc -> http://127.0.0.1:$ProxyPort"
$logPath = Join-Path $InstallDir 'tunnel.log'
if (Test-Path $logPath) { Clear-Content $logPath -ErrorAction SilentlyContinue }

$tunnelBin = "`"$cfDest`" tunnel --url http://127.0.0.1:$ProxyPort --protocol http2 --logfile `"$logPath`" --loglevel info"
if (Get-Service $TunnelSvc -ErrorAction SilentlyContinue) {
  Stop-Service $TunnelSvc -Force -ErrorAction SilentlyContinue
  sc.exe config $TunnelSvc binPath= $tunnelBin start= auto | Out-Null
} else {
  sc.exe create $TunnelSvc binPath= $tunnelBin start= auto DisplayName= 'Total Assurance NVR Tunnel' | Out-Null
}
sc.exe failure $TunnelSvc reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
sc.exe config $TunnelSvc depend= $ProxySvc | Out-Null
Start-Service $TunnelSvc

Write-Host '    Waiting for public tunnel URL...' -ForegroundColor Gray
$publicUrl = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep 2
  if (Test-Path $logPath) {
    $m = Select-String -Path $logPath -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
    if ($m) { $publicUrl = $m.Matches[0].Value; break }
  }
}
if (-not $publicUrl) {
  Write-Warn "No public URL yet - check $logPath"
  Write-Warn 'Services are installed; URL watch will pick it up when ready.'
} else {
  Write-Ok "PUBLIC URL: $publicUrl"
  Set-Content (Join-Path $InstallDir 'current-url.txt') $publicUrl -Encoding ascii

  if (Test-Path (Join-Path $Repo 'wrangler.toml')) {
    Push-Location $Repo
    try {
      $env:CLOUDFLARE_ACCOUNT_ID = $AccountId
      $esc = $publicUrl.Replace("'", "''")
      npx wrangler d1 execute fleet_db --remote --command "UPDATE settings SET value='$esc' WHERE key='warehouse_nvr_url'" 2>$null | Out-Null
      Write-Ok 'Field App camera URL updated in database'
    } catch {
      Write-Warn "Could not auto-update Field App URL: $($_.Exception.Message)"
      Write-Warn "Paste into admin camera settings: $publicUrl"
    }
    Pop-Location
  }
}

# -- 5. URL + health watch every 5 minutes ---------------------------
Write-Step 'Installing keep-alive watch (URL sync + restart if down)'
$watchScript = Join-Path $InstallDir 'watch-tunnel-url.ps1'
$watchBody = @'
$ErrorActionPreference = "Continue"
$InstallDir = "C:\ProgramData\TotalAssurance\nvr-tunnel"
$ProxyPort = 8791
$ProxySvc = "TA-NVR-MediaProxy"
$TunnelSvc = "TA-NVR-Tunnel"
$logPath = Join-Path $InstallDir "tunnel.log"
$repo = "C:\grok\fueltracker"
$AccountId = "f6da342467e60df683731c55dfc0e7b4"
$watchLog = Join-Path $InstallDir "watch.log"
function Log($m) { Add-Content $watchLog "$(Get-Date -Format o) $m" -ErrorAction SilentlyContinue }

$proxyUp = $false
try {
  $r = Invoke-WebRequest "http://127.0.0.1:$ProxyPort/fieldapp/health" -UseBasicParsing -TimeoutSec 4
  $proxyUp = $r.StatusCode -eq 200
} catch {}
if (-not $proxyUp) {
  Log "proxy down - restarting service"
  try { Restart-Service $ProxySvc -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep 3
}

$ts = Get-Service $TunnelSvc -ErrorAction SilentlyContinue
if ($ts -and $ts.Status -ne "Running") {
  Log "tunnel service not running - starting"
  try { Start-Service $TunnelSvc -ErrorAction SilentlyContinue } catch {}
  Start-Sleep 4
}

if (Test-Path $logPath) {
  $m = Select-String -Path $logPath -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -Last 1
  if ($m) {
    $url = $m.Matches[0].Value
    $curFile = Join-Path $InstallDir "current-url.txt"
    $prev = if (Test-Path $curFile) { (Get-Content $curFile -Raw).Trim() } else { "" }
    if ($url -ne $prev) {
      Set-Content $curFile $url -Encoding ascii
      if (Test-Path (Join-Path $repo "wrangler.toml")) {
        Push-Location $repo
        $env:CLOUDFLARE_ACCOUNT_ID = $AccountId
        $esc = $url.Replace("'", "''")
        npx wrangler d1 execute fleet_db --remote --command "UPDATE settings SET value='$esc' WHERE key='warehouse_nvr_url'" 2>$null | Out-Null
        Pop-Location
        Log "synced url $url"
      }
    }
  }
}
'@
[System.IO.File]::WriteAllText($watchScript, $watchBody)

Unregister-ScheduledTask -TaskName $WatchTask -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchScript`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $WatchTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Ok "Scheduled task $WatchTask (every 5 min)"

# -- 6. Power: never sleep on AC -------------------------------------
Write-Step 'Power settings (stay awake on wall power)'
try {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  powercfg /change monitor-timeout-ac 0 | Out-Null
  powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP HYBRIDSLEEP 0 | Out-Null
  powercfg /setactive SCHEME_CURRENT | Out-Null
  Write-Ok 'AC sleep/hibernate set to Never (screen can still turn off)'
} catch {
  Write-Warn "Could not change all power settings: $($_.Exception.Message)"
}
Write-Warn 'Important: leave this PC plugged in at the shop.'
Write-Warn 'If Windows still sleeps (Modern Standby), turn Sleep off in Settings > System > Power.'

# -- 7. Final verification -------------------------------------------
Write-Step 'Final check'
Get-Service $ProxySvc, $TunnelSvc | Format-Table Name, Status, StartType -AutoSize
try {
  $h = Invoke-WebRequest "http://127.0.0.1:$ProxyPort/fieldapp/health" -UseBasicParsing -TimeoutSec 5
  Write-Ok "Local proxy: $($h.Content)"
} catch {
  Write-Warn "Local proxy check failed: $($_.Exception.Message)"
}
if ($publicUrl) {
  Write-Host ''
  Write-Host "  Public camera link: $publicUrl" -ForegroundColor Cyan
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host '  DONE - easiest setup is complete' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  What you do from now on:' -ForegroundColor White
Write-Host '    1. Leave THIS computer at the shop, plugged in, powered on.'
Write-Host '    2. After reboot, services start automatically (wait about 1 min).'
Write-Host '    3. Hard-refresh Security cameras in the Field App.'
Write-Host ''
Write-Host '  You do NOT need a personal laptop online for cameras.'
Write-Host '  This NUC/shop PC is the bridge to the NVR.'
Write-Host ''
Write-Host '  Check status anytime:'
Write-Host "    Get-Service $ProxySvc, $TunnelSvc"
Write-Host "    Get-Content $InstallDir\current-url.txt"
Write-Host "    Invoke-WebRequest http://127.0.0.1:$ProxyPort/fieldapp/health"
Write-Host ''
