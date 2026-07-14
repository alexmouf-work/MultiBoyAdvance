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

# Run a CR-stripped copy of setup.sh (Windows checkouts may be CRLF, which
# bash rejects); MBA_ROM_DIR keeps it operating on the real rom/ directory.
wsl bash -c "cd '$romDir' && mkdir -p build && sed -e 's/\r\$//' setup.sh > build/setup-lf.sh && MBA_ROM_DIR='$romDir' bash build/setup-lf.sh"
Write-Host '[mba] ROM at rom\build\mba.gba' -ForegroundColor Green
