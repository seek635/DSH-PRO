@echo off
rem DSH PRO - idempotent bridge starter
setlocal
set "ROOT=%~dp0.."

if not exist "%ROOT%\bridge\config.json" (
  echo [DSH PRO] bridge\config.json not found. Run scripts\pair.ps1 first.
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo [DSH PRO] bridge already running on port 8765.
) else (
  echo [DSH PRO] starting bridge...
  start "DSH PRO bridge" /D "%ROOT%" cmd /c "title DSH PRO bridge && node bridge\server.js & pause"
  ping -n 3 127.0.0.1 >nul
  powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) { Write-Host '[DSH PRO] bridge started.' } else { Write-Host '[DSH PRO] bridge NOT started. Is node in PATH? Check the bridge window.' }"
)
endlocal
