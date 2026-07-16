# Start the MultiBoyAdvance server on Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root 'server')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js not found. Install the LTS from https://nodejs.org first.'
}

# Ensure the firewall lets LAN devices in. A missing 8443 rule makes Windows
# silently DROP inbound packets -> phones "buffer endlessly" while the PC (local
# traffic, not filtered) works fine. Best-effort: needs admin, so warn if denied.
try {
    if (-not (Get-NetFirewallRule -DisplayName 'MultiBoyAdvance' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName 'MultiBoyAdvance' -Direction Inbound -Protocol TCP `
            -LocalPort 8484, 8443, 8485 -Action Allow -Profile Any -ErrorAction Stop | Out-Null
        Write-Host '[mba] firewall rule created (TCP 8484/8443/8485, all profiles).' -ForegroundColor Green
    }
} catch {
    Write-Warning 'Could not create the firewall rule (run PowerShell as Administrator once, or run setup-windows.bat).'
    Write-Warning 'Until then, phones on the LAN will hang/buffer. Command to run as admin:'
    Write-Warning '  New-NetFirewallRule -DisplayName "MultiBoyAdvance" -Direction Inbound -Protocol TCP -LocalPort 8484,8443,8485 -Action Allow -Profile Any'
}
if (-not (Test-Path 'node_modules')) {
    Write-Host '[mba] installing server dependencies…'
    npm install --no-audit --no-fund
    Push-Location (Join-Path $root 'web')
    npm install --no-audit --no-fund   # also vendors the mGBA WASM core
    Pop-Location
}

# Pick the adapter that owns the DEFAULT ROUTE - that's the real WiFi/Ethernet
# card the phone shares the network with. Selecting "first IPv4" instead grabs
# WSL/Docker/Hyper-V virtual adapters (172.x) that only exist inside this PC
# and are unreachable from phones - the classic "works on my computer, not my
# phone" trap.
$ip = $null
$ifIndex = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric, ifMetric | Select-Object -First 1).ifIndex
if ($ifIndex) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -First 1).IPAddress
}
if (-not $ip) { $ip = '<your-LAN-IP>' } # server prints the full candidate list below

Write-Host "[mba] LAN players join at:   https://${ip}:8443   (accept the one-time certificate warning)" -ForegroundColor Green
Write-Host "[mba] on this machine only:  http://localhost:8484"
Write-Host '[mba] on phones, use Safari and tap through the certificate warning (Chrome-iOS may refuse it).'
Write-Host '[mba] if that IP does not load on your phone, use one of the https:// URLs the server lists next.'
Write-Host '[mba] desktop mGBA bridges connect to TCP port 8485'

npm start
