#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Named Cloudflare Tunnel for Field App cameras (stable URL across reboots).

.EXAMPLE
  .\setup-named-nvr-tunnel.ps1 -Hostname nvr.totalassuranceac.com
#>
param(
  [string]$Hostname = "nvr.totalassuranceac.com",
  [string]$TunnelName = "ta-nvr",
  [int]$ProxyPort = 8791,
  [string]$InstallDir = "C:\ProgramData\TotalAssurance\nvr-tunnel",
  [string]$Repo = "",
  [string]$AccountId = "f6da342467e60df683731c55dfc0e7b4"
)

$ErrorActionPreference = "Stop"
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Info($m) { Write-Host "  ..  $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }

if (-not $Repo) {
  foreach ($c in @("C:\grok\fueltracker", "C:\Grok\FuelTracker")) {
    if (Test-Path (Join-Path $c "wrangler.toml")) { $Repo = $c; break }
  }
}
if (-not $Repo) { $Repo = "C:\grok\fueltracker" }

$cf = Join-Path $InstallDir "cloudflared.exe"
if (-not (Test-Path $cf)) { throw "Missing $cf" }

$cloudDir = Join-Path $env:USERPROFILE ".cloudflared"
$cert = Join-Path $cloudDir "cert.pem"
# Also check Downloads if browser saved it there
if (-not (Test-Path $cert)) {
  $dl = Join-Path $env:USERPROFILE "Downloads\cert.pem"
  if (Test-Path $dl) {
    New-Item -ItemType Directory -Force -Path $cloudDir | Out-Null
    Copy-Item -Force $dl $cert
    Ok "Copied cert.pem from Downloads"
  }
}
if (-not (Test-Path $cert)) {
  throw "Missing $cert — run cloudflared tunnel login first and Allow in browser."
}
Ok "Origin cert found"
$env:TUNNEL_ORIGIN_CERT = $cert

# Create tunnel if needed
$list = & $cf tunnel list 2>&1 | Out-String
if ($list -notmatch [regex]::Escape($TunnelName)) {
  Info "Creating tunnel $TunnelName ..."
  & $cf tunnel create $TunnelName 2>&1 | ForEach-Object { Write-Host "    $_" }
  Ok "Tunnel created"
} else {
  Ok "Tunnel $TunnelName exists"
}

# Credentials file is <UUID>.json in ~/.cloudflared
$credFile = $null
$tunnelId = $null
foreach ($f in Get-ChildItem $cloudDir -Filter "*.json" -ErrorAction SilentlyContinue) {
  try {
    $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
    # file is usually just AccountTag / TunnelID / TunnelSecret
    if ($j.TunnelID -or $j.tunnelID -or $j.AccountTag) {
      $tid = if ($j.TunnelID) { $j.TunnelID } elseif ($j.tunnelID) { $j.tunnelID } else { $f.BaseName }
      # Prefer file whose name matches a tunnel id from list, or newest
      if (-not $credFile) {
        $credFile = $f.FullName
        $tunnelId = $f.BaseName
      }
      # If list contains this id next to our name, prefer it
      if ($list -match [regex]::Escape($f.BaseName) -and $list -match [regex]::Escape($TunnelName)) {
        $credFile = $f.FullName
        $tunnelId = $f.BaseName
        break
      }
    }
  } catch {}
}
if (-not $credFile) {
  $newest = Get-ChildItem $cloudDir -Filter "*.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest) {
    $credFile = $newest.FullName
    $tunnelId = $newest.BaseName
  }
}
if (-not $credFile -or -not (Test-Path $credFile)) {
  throw "No tunnel credentials JSON in $cloudDir"
}
Ok "Credentials: $credFile (id $tunnelId)"

# Copy creds into ProgramData so LocalSystem service can read them
$svcCloud = Join-Path $InstallDir ".cloudflared"
New-Item -ItemType Directory -Force -Path $svcCloud | Out-Null
$svcCert = Join-Path $svcCloud "cert.pem"
$svcCred = Join-Path $svcCloud "$tunnelId.json"
Copy-Item -Force $cert $svcCert
Copy-Item -Force $credFile $svcCred
# Grant SYSTEM read
icacls $svcCloud /grant "SYSTEM:(OI)(CI)R" /T 2>$null | Out-Null
Ok "Copied cert+creds for service under $svcCloud"

$configPath = Join-Path $InstallDir "config.yml"
$credPathYaml = ($svcCred -replace "\\", "/")
$config = @"
tunnel: $tunnelId
credentials-file: $credPathYaml

ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:$ProxyPort
  - service: http_status:404
"@
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText($configPath, ($config -replace "`r`n", "`n"), $utf8)
Ok "Wrote $configPath"

Info "Routing DNS $Hostname -> tunnel..."
$routeOut = & $cf tunnel route dns $TunnelName $Hostname 2>&1 | Out-String
Write-Host $routeOut
if ($routeOut -match "(?i)error|failed" -and $routeOut -notmatch "(?i)already|success|added|record") {
  Warn "DNS route may need manual CNAME in Cloudflare:"
  Warn "  Type CNAME  Name nvr  Target $tunnelId.cfargotunnel.com  Proxy ON"
} else {
  Ok "DNS route OK (or already existed)"
}

# Point service at named tunnel
$svc = "TA-NVR-Tunnel"
$logPath = Join-Path $InstallDir "tunnel.log"
$binPath = "`"$cf`" tunnel --config `"$configPath`" run --logfile `"$logPath`" --loglevel info"
Info "Updating Windows service $svc ..."
Stop-Service $svc -Force -ErrorAction SilentlyContinue
Start-Sleep 2
# sc.exe needs careful spacing: binPath= value
cmd /c "sc.exe config $svc binPath= $binPath start= auto" | Out-Null
cmd /c "sc.exe failure $svc reset= 86400 actions= restart/5000/restart/10000/restart/30000" | Out-Null
Start-Service $svc
Start-Sleep 5
$st = (Get-Service $svc -ErrorAction SilentlyContinue).Status
Ok "Service $svc status: $st"

$publicUrl = "https://$Hostname"
if (Test-Path (Join-Path $Repo "wrangler.toml")) {
  Push-Location $Repo
  $env:CLOUDFLARE_ACCOUNT_ID = $AccountId
  $sql = "UPDATE settings SET value='$publicUrl' WHERE key='warehouse_nvr_url'"
  npx wrangler d1 execute fleet_db --remote --command $sql 2>&1 | Out-String | Write-Host
  Pop-Location
  Ok "Field App warehouse_nvr_url = $publicUrl"
} else {
  Warn "Repo not found — set warehouse_nvr_url manually to $publicUrl"
}

try { Set-Content (Join-Path $InstallDir "current-url.txt") $publicUrl -Encoding ascii -Force } catch {}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Named tunnel configured" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Public URL:  $publicUrl"
Write-Host " Tunnel ID:   $tunnelId"
Write-Host " Local proxy: http://127.0.0.1:$ProxyPort"
Write-Host ""
Write-Host " Wait ~30 seconds for DNS, then hard-refresh Security cameras."
Write-Host " After reboot this URL stays the same."
Write-Host ""
