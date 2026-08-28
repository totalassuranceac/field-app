@echo off
:: Double-click - requests Admin, installs auto-sync so cameras survive reboot URL changes.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0\.."
if not exist "scripts\install-tunnel-url-sync.ps1" cd /d C:\grok\fueltracker
if not exist "scripts\install-tunnel-url-sync.ps1" cd /d C:\Grok\FuelTracker
echo Installing from %CD%
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\install-tunnel-url-sync.ps1"
echo.
echo EXIT=%ERRORLEVEL%
pause
