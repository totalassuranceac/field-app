# Sync public camera tunnel URL into Field App (D1).
# Works with trycloudflare quick tunnels AND named tunnels (config.yml hostname).
$ErrorActionPreference = "Continue"
$InstallDir = "C:\ProgramData\TotalAssurance\nvr-tunnel"
$ProxyPort = 8791
$ProxySvc = "TA-NVR-MediaProxy"
$TunnelSvc = "TA-NVR-Tunnel"
$logPath = Join-Path $InstallDir "tunnel.log"
$configYml = Join-Path $InstallDir "config.yml"
$curFile = Join-Path $InstallDir "current-url.txt"
$watchLog = Join-Path $InstallDir "watch.log"
$repo = "C:\grok\fueltracker"
$AccountId = "f6da342467e60df683731c55dfc0e7b4"

function Log([string]$m) {
  $line = "{0} {1}" -f (Get-Date -Format o), $m
  try { Add-Content -Path $watchLog -Value $line -ErrorAction SilentlyContinue } catch {}
  Write-Host $line
}

function Get-PublicTunnelUrl {
  if (Test-Path $configYml) {
    $m = Select-String -Path $configYml -Pattern "hostname:\s*(\S+)" | Select-Object -First 1
    if ($m) {
      $h = $m.Matches[0].Groups[1].Value.Trim().Trim([char]34).Trim([char]39)
      if ($h -match "^https?://") { return $h.TrimEnd("/") }
      if ($h) { return "https://$h" }
    }
  }
  if (Test-Path $logPath) {
    $m = Select-String -Path $logPath -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" |
      Select-Object -Last 1
    if ($m) { return $m.Matches[0].Value }
  }
  return $null
}

function Test-UrlHealth([string]$u) {
  try {
    $r = Invoke-WebRequest ("{0}/fieldapp/health" -f $u) -UseBasicParsing -TimeoutSec 12
    return ($r.StatusCode -eq 200 -and $r.Content -match '"ok"')
  } catch {
    return $false
  }
}

try {
  $null = Invoke-WebRequest ("http://127.0.0.1:{0}/fieldapp/health" -f $ProxyPort) -UseBasicParsing -TimeoutSec 4
} catch {
  Log "proxy down - restarting service"
  try { Restart-Service $ProxySvc -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep 4
}

$ts = Get-Service $TunnelSvc -ErrorAction SilentlyContinue
if ($ts -and $ts.Status -ne "Running") {
  Log "tunnel service down - starting"
  try { Start-Service $TunnelSvc -ErrorAction SilentlyContinue } catch {}
  Start-Sleep 8
}

$url = $null
for ($i = 0; $i -lt 18; $i++) {
  $url = Get-PublicTunnelUrl
  if ($url) { break }
  Start-Sleep 5
}
if (-not $url) {
  Log "no public tunnel URL found yet"
  exit 1
}

$prev = ""
try {
  if (Test-Path $curFile) { $prev = (Get-Content $curFile -Raw).Trim() }
} catch {}

if (-not (Test-UrlHealth $url)) {
  Log ("URL not healthy yet: " + $url)
  Start-Sleep 10
}

$need = $true
if ($prev -eq $url -and (Test-UrlHealth $prev)) { $need = $false }
if (-not $need) {
  Log ("ok unchanged " + $url)
  exit 0
}

try {
  Set-Content -Path $curFile -Value $url -Encoding ascii -Force -ErrorAction SilentlyContinue
} catch {
  Log ("warn write current-url: " + $_.Exception.Message)
}

if (-not (Test-Path (Join-Path $repo "wrangler.toml"))) {
  Log "repo missing"
  exit 1
}

try {
  Push-Location $repo
  $env:CLOUDFLARE_ACCOUNT_ID = $AccountId
  $sql = "UPDATE settings SET value='$url' WHERE key='warehouse_nvr_url'"
  $out = npx wrangler d1 execute fleet_db --remote --command $sql 2>&1 | Out-String
  Pop-Location
  Log ("synced " + $url)
  if ($out -match "(?i)error") { Log ("wrangler out: " + $out.Substring(0, [Math]::Min(200, $out.Length))) }
  Write-Host ("SYNCED " + $url)
  exit 0
} catch {
  try { Pop-Location } catch {}
  Log ("D1 sync failed: " + $_.Exception.Message)
  exit 1
}
