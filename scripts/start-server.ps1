# Start the MultiBoyAdvance server on Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root 'server')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js not found. Install the LTS from https://nodejs.org first.'
}
if (-not (Test-Path 'node_modules')) {
    Write-Host '[mba] installing server dependencies…'
    npm install --no-audit --no-fund
    Push-Location (Join-Path $root 'web')
    npm install --no-audit --no-fund   # also vendors the mGBA WASM core
    Pop-Location
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress
Write-Host "[mba] LAN players join at:   https://${ip}:8443   (accept the one-time certificate warning)" -ForegroundColor Green
Write-Host "[mba] on this machine only:  http://localhost:8484"
Write-Host '[mba] plain-http on the LAN IP works for DEMO MODE only - real-ROM play needs the https address'
Write-Host '[mba] desktop mGBA bridges connect to TCP port 8485'

npm start
