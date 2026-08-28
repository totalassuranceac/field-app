# Sync trycloudflare OR named-tunnel public URL into Field App D1.
# Runs as scheduled task TA-NVR-UrlSync-User — also safe to run manually.
$ErrorActionPreference = "Continue"
$InstallDir = "C:\ProgramData\TotalAssurance\nvr-tunnel"
$ProxyPort = 8791
$ProxySvc = "TA-NVR-MediaProxy"
$TunnelSvc = "TA-NVR-Tunnel"
$logPath = Join-Path $InstallDir "tunnel.log"
$repo = "C:\grok\fueltracker"
$AccountId = "f6da342467e60df683731c55dfc0e7b4"
$watchLog = Join-Path $InstallDir "watch.log"
$curFile = Join-Path $InstallDir "current-url.txt"
$configYml = Join-Path $InstallDir "config.yml"

function Log($m) {
  try { Add-Content $watchLog "$(Get-Date -Format o) $m" -ErrorAction SilentlyContinue } catch {}
}

# Keep proxy/tunnel services up
try {
  $r = Invoke-WebRequest "http://127.0.0.1:$ProxyPort/fieldapp/health" -UseBasicParsing -TimeoutSec 4
  if ($r.StatusCode -ne 200) { throw "bad status" }
} catch {
  Log "proxy down - restarting"
  try { Restart-Service $ProxySvc -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep 3
}

$ts = Get-Service $TunnelSvc -ErrorAction SilentlyContinue
if ($ts -and $ts.Status -ne "Running") {
  Log "tunnel service not running - starting"
  try { Start-Service $TunnelSvc -ErrorAction SilentlyContinue } catch {}
  Start-Sleep 5
}

# Prefer stable hostname from named tunnel config.yml
$url = $null
if (Test-Path $configYml) {
  $m = Select-String -Path $configYml -Pattern "^\s*hostname:\s*(\S+)" | Select-Object -First 1
  if ($m) {
    $hostName = $m.Matches[0].Groups[1].Value.Trim()
    if ($hostName -and $hostName -notmatch "http") {
      $url = "https://$hostName"
    }
  }
}

# Else scrape quick-tunnel URL from cloudflared log
if (-not $url -and (Test-Path $logPath)) {
  $m = Select-String -Path $logPath -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" |
    Select-Object -Last 1
  if ($m) { $url = $m.Matches[0].Value }
}

if (-not $url) {
  Log "no tunnel URL found yet"
  exit 0
}

$prev = ""
try {
  if (Test-Path $curFile) { $prev = (Get-Content $curFile -Raw -ErrorAction SilentlyContinue).Trim() }
} catch {}

# Always verify public health; if current D1 URL is dead, force sync
$needSync = ($url -ne $prev)
if (-not $needSync -and $prev) {
  try {
    $h = Invoke-WebRequest "$prev/fieldapp/health" -UseBasicParsing -TimeoutSec 8
    if ($h.StatusCode -ne 200) { $needSync = $true }
  } catch {
    $needSync = $true
    Log "previous URL unhealthy: $prev"
  }
}

if (-not $needSync) {
  exit 0
}

try {
  Set-Content $curFile $url -Encoding ascii -Force -ErrorAction SilentlyContinue
} catch {
  Log "could not write current-url.txt: $_"
}

if (Test-Path (Join-Path $repo "wrangler.toml")) {
  try {
    Push-Location $repo
    $env:CLOUDFLARE_ACCOUNT_ID = $AccountId
    $esc = $url.Replace("'", "''")
    npx wrangler d1 execute fleet_db --remote --command "UPDATE settings SET value='$esc' WHERE key='warehouse_nvr_url'" 2>$null | Out-Null
    Pop-Location
    Log "synced url $url"
  } catch {
    Log "D1 sync failed: $_"
    try { Pop-Location } catch {}
  }
} else {
  Log "repo missing, skipped D1 sync for $url"
}
