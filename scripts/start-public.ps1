# Expose the MultiBoyAdvance server on the public internet under a real
# domain with a trusted certificate (no browser warnings).
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1 -Domain mba.mouftools.com
#
# One-time prerequisites (see docs/SETUP-WINDOWS.md §5):
#   1. DNS: an A record for the domain pointing at your public IP
#      (Vercel dashboard -> your domain -> DNS records).
#   2. Router: forward TCP ports 80 and 443 to this PC.
#   3. The game server running (scripts\start-server.ps1).
#
# Caddy fetches/renews Let's Encrypt certificates automatically and proxies
# HTTP+WebSocket to the local server; our COOP/COEP headers pass through, so
# cross-origin isolation (required by the mGBA core) works with zero warnings.
param(
    [Parameter(Mandatory = $true)] [string]$Domain,
    [int]$UpstreamPort = 8484
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command caddy -ErrorAction SilentlyContinue)) {
    Write-Host '[mba] installing Caddy via winget...'
    winget install --id CaddyServer.Caddy -e --accept-source-agreements --accept-package-agreements
    if (-not (Get-Command caddy -ErrorAction SilentlyContinue)) {
        Write-Error 'Caddy installed but not on PATH yet - close this window and run the script again.'
    }
}

foreach ($rule in @(@('MultiBoyAdvance Public 80', 80), @('MultiBoyAdvance Public 443', 443))) {
    if (-not (Get-NetFirewallRule -DisplayName $rule[0] -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $rule[0] -Direction Inbound -Protocol TCP -LocalPort $rule[1] -Action Allow | Out-Null
    }
}

Write-Host "[mba] players anywhere can join at:  https://$Domain" -ForegroundColor Green
Write-Host '[mba] keep scripts\start-server.ps1 running in another window. Ctrl+C stops the proxy.'
caddy reverse-proxy --from $Domain --to "localhost:$UpstreamPort"
