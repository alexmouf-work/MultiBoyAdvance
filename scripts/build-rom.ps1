# Build the netcode ROM from Windows by delegating to WSL2 (see docs/SETUP-WINDOWS.md).
#   powershell -ExecutionPolicy Bypass -File scripts\build-rom.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Write-Error 'WSL not found. Run "wsl --install -d Ubuntu" first (docs/SETUP-WINDOWS.md §2).'
}

$romDir = (Join-Path $root 'rom') -replace '\\', '/'
# Translate C:\... to /mnt/c/... for WSL
if ($romDir -match '^([A-Za-z]):/(.*)$') {
    $romDir = '/mnt/' + $Matches[1].ToLower() + '/' + $Matches[2]
}

wsl bash -c "cd '$romDir' && ./setup.sh"
Write-Host '[mba] ROM at rom\build\mba.gba' -ForegroundColor Green
