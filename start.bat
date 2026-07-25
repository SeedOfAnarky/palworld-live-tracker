@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 18 or newer is required.
  echo Install Node.js from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODEMAJOR=%%V
if %NODEMAJOR% LSS 18 (
  echo Node.js 18 or newer is required. Detected major version %NODEMAJOR%.
  pause
  exit /b 1
)

echo Starting Palworld Live Tracker...
node server.mjs
echo.
echo Tracker stopped.
pause
