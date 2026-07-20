# Deploy/update MultiBoyAdvance on a provisioned VPS from Windows.
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-mba.ps1 -HostAddr <ip-or-domain> [-User ubuntu]
# Uses Windows' built-in OpenSSH (ssh/scp) and bsdtar. Ships server/ + web/
# (with the vendored emulator) + the current ROM build. Never touches
# server/data on the box, so world state survives deploys.
param(
    [Parameter(Mandatory = $true)] [string]$HostAddr,
    [string]$User = 'ubuntu'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

foreach ($tool in 'ssh', 'scp', 'tar') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "$tool not found - install Windows' OpenSSH Client optional feature."
    }
}

$items = @('server', 'web')
if (Test-Path 'rom\build\mba.gba') {
    $items += 'rom/build/mba.gba'
} else {
    Write-Warning 'rom\build\mba.gba missing - deploying without a ROM (join stays disabled for players).'
}

$bundle = Join-Path $env:TEMP 'mba-deploy.tgz'
tar -czf $bundle --exclude=server/node_modules --exclude=server/data --exclude=web/node_modules @items
if ($LASTEXITCODE -ne 0) { Write-Error 'tar failed' }

# accept-new: auto-trust a first-seen host key (so a fresh connect — e.g. by
# domain instead of IP — never hangs on an interactive prompt when this runs
# from setup-windows.bat), while still rejecting a CHANGED key.
Write-Host "[mba] uploading to ${User}@${HostAddr}..."
scp -o StrictHostKeyChecking=accept-new $bundle "${User}@${HostAddr}:/tmp/mba-deploy.tgz"
if ($LASTEXITCODE -ne 0) { Write-Error 'scp failed' }
Remove-Item $bundle

$remote = 'set -e; sudo tar xzf /tmp/mba-deploy.tgz -C /opt/mba; ' +
    'cd /opt/mba/server && sudo npm install --omit=dev --no-audit --no-fund; ' +
    'sudo chown -R mba:mba /opt/mba; sudo systemctl restart mba; ' +
    'rm -f /tmp/mba-deploy.tgz; sleep 1; systemctl is-active mba'
ssh -o StrictHostKeyChecking=accept-new "${User}@${HostAddr}" $remote
if ($LASTEXITCODE -ne 0) { Write-Error 'remote deploy failed - check: ssh the box, journalctl -u mba -n 30' }

Write-Host '[mba] deployed. Players: https://your-domain (rebuild the ROM anytime and re-run this script).' -ForegroundColor Green
