@echo off
setlocal
cd /d "%~dp0"
echo.
echo This starts the tracker and uses its Test Connection endpoint.
echo Start start.bat first, then run this file in another window.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $r = Invoke-RestMethod 'http://127.0.0.1:3030/api/test' -TimeoutSec 15; $r | ConvertTo-Json -Depth 8 } catch { Write-Host $_ -ForegroundColor Red; exit 1 }"
echo.
pause
