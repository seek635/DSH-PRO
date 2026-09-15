# DSH PRO pair script
# Generates a random 64-hex token, writes it into bridge/config.json,
# copies it to the clipboard, and starts the bridge if not running.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File pair.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$cfgPath = Join-Path $root 'bridge\config.json'

# Load or create config
if (Test-Path $cfgPath) {
    $raw = Get-Content $cfgPath -Raw -Encoding UTF8
    $cfg = $raw | ConvertFrom-Json
} else {
    Write-Host "[DSH PRO] config.json not found, creating defaults."
    $cfg = [pscustomobject]@{
        token = ''
        port = 8765
        allowedRoots = @('D:\DeepSeek Harness', 'D:\HiSpark_Studio')
        bashTimeoutMs = 20000
        bashTimeoutMaxMs = 120000
        handoffTimeoutMs = 300000
        handoffTimeoutMaxMs = 1800000
        dailySendLimit = 200
    }
}

# Generate 32 random bytes -> 64 hex chars
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$rng.Dispose()

$cfg.token = $token
if (-not $cfg.allowedRoots -or $cfg.allowedRoots.Count -eq 0) {
    $cfg | Add-Member -NotePropertyName allowedRoots -NotePropertyValue @('D:\DeepSeek Harness', 'D:\HiSpark_Studio') -Force
}
$cfg | ConvertTo-Json -Depth 5 | Set-Content $cfgPath -Encoding UTF8
Write-Host "[DSH PRO] token written to $cfgPath"

# Copy token to clipboard
try {
    Set-Clipboard -Value $token
    Write-Host "[DSH PRO] token copied to clipboard. Paste it into the DSH PRO panel."
} catch {
    Write-Host "[DSH PRO] Could not access clipboard. Token value:"
    Write-Host $token
}

# Start bridge if not already listening
$port = if ($cfg.port) { [int]$cfg.port } else { 8765 }
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "[DSH PRO] bridge already running on port $port."
} else {
    Write-Host "[DSH PRO] starting bridge on port $port ..."
    $serverJs = Join-Path $root 'bridge\server.js'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "title DSH PRO bridge && node `"$serverJs`" & pause" -WorkingDirectory $root
    Start-Sleep -Seconds 2
    $check = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($check) {
        Write-Host "[DSH PRO] bridge started."
    } else {
        Write-Host "[DSH PRO] bridge may have failed to start. Is node in PATH? Check the bridge window for errors."
    }
}
