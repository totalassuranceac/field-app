# Fix Security cameras so they stay online after reboot.
# ROOT CAUSE: Windows service TA-NVR-Tunnel was pointing at the NVR
# (192.168.1.111) instead of the local media proxy (127.0.0.1:8791).
# Also: quick tunnels get a NEW public URL every restart — this script
# rewrites Field App warehouse_nvr_url after each start.
#
# RUN AS ADMINISTRATOR:
#   cd C:\grok\fueltracker\scripts
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\fix-nvr-always-on.ps1

$ErrorActionPreference = 'Stop'
$InstallDir = 'C:\ProgramData\TotalAssurance\nvr-tunnel'
$ProxyPort = 8791
$ServiceName = 'TA-NVR-Tunnel'
$ProxyServiceName = 'TA-NVR-MediaProxy'
$Repo = 'C:\grok\fueltracker'
$RepoProxy = Join-Path $Repo 'scripts\nvr-media-proxy.mjs'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host 'ERROR: Right-click PowerShell -> Run as administrator, then re-run this script.' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $InstallDir)) {
  Write-Host "Missing $InstallDir — run install-nvr-tunnel-service.ps1 first." -ForegroundColor Red
  exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
if (-not $node) { throw 'Node.js required' }
$cloudflared = Join-Path $InstallDir 'cloudflared.exe'
if (-not (Test-Path $cloudflared)) { throw "Missing $cloudflared" }

# Refresh proxy script from repo
if (Test-Path $RepoProxy) {
  Copy-Item -Force $RepoProxy (Join-Path $InstallDir 'nvr-media-proxy.mjs')
}

function Install-Or-Update-Service($name, $binPath, $display) {
  $existing = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-Service $name -Force -ErrorAction SilentlyContinue
    Start-Sleep 1
    sc.exe config $name binPath= $binPath start= auto | Out-Null
  } else {
    sc.exe create $name binPath= $binPath start= auto DisplayName= $display | Out-Null
  }
  sc.exe failure $name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
}

# Stop everything
Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
Stop-Service $ProxyServiceName -Force -ErrorAction SilentlyContinue
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
    if ($c -and $c -match 'nvr-media-proxy') { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  } catch {}
}
Start-Sleep 2

# Media proxy service (must be up BEFORE tunnel)
$proxyBin = 'cmd.exe /c ""' + $node + '" "' + $InstallDir + '\nvr-media-proxy.mjs""'
Write-Host "Installing/updating $ProxyServiceName ..."
Install-Or-Update-Service $ProxyServiceName $proxyBin 'Total Assurance NVR Media Proxy'
Start-Service $ProxyServiceName
Start-Sleep 2

$ok = $false
try {
  $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ProxyPort/fieldapp/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "Media proxy: $($h.Content)" -ForegroundColor Green
  $ok = $true
} catch {
  Write-Host "Media proxy health failed: $($_.Exception.Message)" -ForegroundColor Yellow
}
if (-not $ok) { throw 'Media proxy not healthy on 8791' }

# Tunnel MUST target media proxy, not the NVR
$logPath = Join-Path $InstallDir 'tunnel.log'
if (Test-Path $logPath) { Clear-Content $logPath -ErrorAction SilentlyContinue }
$tunnelBin = "`"$cloudflared`" tunnel --url http://127.0.0.1:$ProxyPort --protocol http2 --logfile `"$logPath`" --loglevel info"
Write-Host "Installing/updating $ServiceName (target=127.0.0.1:$ProxyPort) ..."
Install-Or-Update-Service $ServiceName $tunnelBin 'Total Assurance NVR Tunnel'
Start-Service $ServiceName

Write-Host 'Waiting for public trycloudflare URL...'
$publicUrl = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep 2
  if (Test-Path $logPath) {
    $m = Select-String -Path $logPath -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
    if ($m) { $publicUrl = $m.Matches[0].Value; break }
  }
}

if (-not $publicUrl) {
  Write-Host "Tunnel started but no public URL yet. Check: $logPath" -ForegroundColor Yellow
  exit 1
}

Write-Host ''
Write-Host "PUBLIC URL: $publicUrl" -ForegroundColor Cyan
Set-Content -Path (Join-Path $InstallDir 'current-url.txt') -Value $publicUrl -Encoding ascii

# Update Field App D1
if (Test-Path (Join-Path $Repo 'wrangler.toml')) {
  Push-Location $Repo
  try {
    $esc = $publicUrl.Replace("'", "''")
    npx wrangler d1 execute fleet_db --remote --command "UPDATE settings SET value='$esc' WHERE key='warehouse_nvr_url'" | Out-Null
    Write-Host 'Field App warehouse_nvr_url updated.' -ForegroundColor Green
  } catch {
    Write-Host "Could not update D1 automatically: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Paste this URL into Field App Admin NVR settings: $publicUrl"
  }
  Pop-Location
}

# Scheduled task: re-sync URL every 5 minutes (quick tunnel may rotate)
$watchScript = Join-Path $InstallDir 'watch-tunnel-url.ps1'
@'
$InstallDir = "C:\ProgramData\TotalAssurance\nvr-tunnel"
$logPath = Join-Path $InstallDir "tunnel.log"
$repo = "C:\grok\fueltracker"
if (-not (Test-Path $logPath)) { exit 0 }
$m = Select-String -Path $logPath -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches | Select-Object -Last 1
if (-not $m) { exit 0 }
$url = $m.Matches[0].Value
$curFile = Join-Path $InstallDir "current-url.txt"
$prev = if (Test-Path $curFile) { (Get-Content $curFile -Raw).Trim() } else { "" }
if ($url -eq $prev) { exit 0 }
Set-Content $curFile $url -Encoding ascii
if (Test-Path (Join-Path $repo "wrangler.toml")) {
  Push-Location $repo
  $esc = $url.Replace("'", "''")
  npx wrangler d1 execute fleet_db --remote --command "UPDATE settings SET value='$esc' WHERE key='warehouse_nvr_url'" 2>$null | Out-Null
  Pop-Location
}
# Ensure media proxy is up
try {
  Invoke-WebRequest "http://127.0.0.1:8791/fieldapp/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
} catch {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) {
    Start-Process $node -ArgumentList "`"$InstallDir\nvr-media-proxy.mjs`"" -WorkingDirectory $InstallDir -WindowStyle Hidden
  }
}
'@ | Set-Content -Path $watchScript -Encoding UTF8

$taskName = 'TA-NVR-TunnelUrlWatch'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watchScript`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Write-Host "Scheduled task $taskName registered (every 5 min URL sync)." -ForegroundColor Green

Write-Host ''
Write-Host 'Done. Services auto-start at boot and point at the media proxy.' -ForegroundColor Green
Write-Host 'Hard-refresh Security cameras in the Field App.'
Write-Host "  Get-Service $ServiceName,$ProxyServiceName"
Write-Host "  Get-Content $InstallDir\current-url.txt"
