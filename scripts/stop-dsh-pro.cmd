@echo off
rem DSH PRO - stop bridge (graceful via /shutdown) and clean up leftover dsh headless processes
setlocal
set "ROOT=%~dp0.."

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$cfgPath = Join-Path (Split-Path -Parent '%~dp0') 'bridge\config.json';" ^
  "try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json; $port = if ($cfg.port) { $cfg.port } else { 8765 }; Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $port + '/shutdown') -Headers @{ Authorization = ('Bearer ' + $cfg.token) } -TimeoutSec 5 | Out-Null; Write-Host '[DSH PRO] bridge stopped.' } catch { Write-Host '[DSH PRO] bridge not reachable (already stopped?)' };" ^
  "$dsh = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*@deepseek-ai*dsh*bin.js*--profile headless*' };" ^
  "foreach ($p in $dsh) { Write-Host ('[DSH PRO] killing leftover dsh headless pid ' + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }"

endlocal
