@echo off
:: Double-click this file — it will ask for Admin, then unstick NVR cameras.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo === Fix camera proxy (kill hung Wyze ffmpeg + restart) ===
echo.

copy /Y "C:\grok\fueltracker\scripts\nvr-media-proxy.mjs" "C:\ProgramData\TotalAssurance\nvr-tunnel\nvr-media-proxy.mjs" >nul
echo Updated nvr-media-proxy.mjs

powershell -NoProfile -Command ^
  "$p='C:\ProgramData\TotalAssurance\nvr-tunnel\proxy-config.json';" ^
  "$r=Get-Content $p -Raw; if($r.Length -gt 0 -and [int][char]$r[0] -eq 0xFEFF){$r=$r.Substring(1)};" ^
  "$c=$r|ConvertFrom-Json; $c.wyzeRecord=$false;" ^
  "$u=New-Object System.Text.UTF8Encoding $false;" ^
  "[IO.File]::WriteAllText($p,(($c|ConvertTo-Json -Depth 6)+\"`n\"),$u);" ^
  "Write-Host 'wyzeRecord=false'"

taskkill /F /IM ffmpeg.exe >nul 2>&1
echo Killed ffmpeg

nssm stop TA-NVR-MediaProxy >nul 2>&1
"C:\ProgramData\TotalAssurance\nvr-tunnel\nssm.exe" stop TA-NVR-MediaProxy >nul 2>&1
timeout /t 2 /nobreak >nul
"C:\ProgramData\TotalAssurance\nvr-tunnel\nssm.exe" start TA-NVR-MediaProxy
net start TA-NVR-MediaProxy >nul 2>&1
timeout /t 3 /nobreak >nul

echo.
echo Health check:
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:8791/fieldapp/health -TimeoutSec 5 | ConvertTo-Json -Depth 5 } catch { $_.Exception.Message }"
echo.
echo ffmpeg left: 
powershell -NoProfile -Command "(Get-Process ffmpeg -ea SilentlyContinue | Measure-Object).Count"
echo.
echo Done. Hard-refresh Field App Security cameras.
echo Playback now lists motion clips near the time you pick — tap the clip you need.
echo NVR should work. Wyze stays offline until Docker + install-wyze-bridge.ps1.
echo.
pause
