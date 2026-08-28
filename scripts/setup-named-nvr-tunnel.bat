@echo off
:: Named Cloudflare tunnel for stable camera URL: nvr.totalassuranceac.com
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0\.."
if not exist "scripts\setup-named-nvr-tunnel.ps1" cd /d C:\grok\fueltracker
if not exist "scripts\setup-named-nvr-tunnel.ps1" cd /d C:\Grok\FuelTracker

echo.
echo ============================================================
echo  Named camera tunnel - nvr.totalassuranceac.com
echo ============================================================
echo.
echo  STEP 1: Cloudflare login
echo  A browser will open. Sign in and click ALLOW.
echo  If a cert.pem downloads, move it to:
echo    %USERPROFILE%\.cloudflared\cert.pem
echo.
pause

set CF=C:\ProgramData\TotalAssurance\nvr-tunnel\cloudflared.exe
if not exist "%USERPROFILE%\.cloudflared" mkdir "%USERPROFILE%\.cloudflared"
"%CF%" tunnel login
if not exist "%USERPROFILE%\.cloudflared\cert.pem" (
  echo.
  echo cert.pem still missing.
  echo If your browser downloaded cert.pem, copy it now:
  echo   copy %%USERPROFILE%%\Downloads\cert.pem %%USERPROFILE%%\.cloudflared\cert.pem
  echo Then run this bat again.
  pause
  exit /b 1
)

echo.
echo  STEP 2: Create tunnel + DNS + Windows service
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\setup-named-nvr-tunnel.ps1" -Hostname "nvr.totalassuranceac.com" -TunnelName "ta-nvr"
echo.
echo EXIT=%ERRORLEVEL%
pause
