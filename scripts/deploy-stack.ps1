<#
.SYNOPSIS
  Deploys the whole mouftools server stack to the box, from a cold start.

.DESCRIPTION
  Run this in a fresh PowerShell window. It clones (or updates) the repos it
  needs into a working folder, then over SSH:

    1. installs MultiBoyAdvance auto-update — the box polls git every 5
       minutes and fast-forwards itself
    2. provisions and starts the always-on Bermuda OSINT worker

  Everything is idempotent: re-running is safe and is how you ship changes.

  Panoculus is NOT handled here — it deploys to Vercel from a git push. The
  script prints what's left to do there at the end.

.PARAMETER Server
  Hostname or IP of the box.

.PARAMETER User
  SSH user. Must be able to sudo. Defaults to root.

.PARAMETER WorkDir
  Where to keep the local clones. Defaults to %USERPROFILE%\mouftools-stack.

.EXAMPLE
  .\deploy-stack.ps1 -Server 203.0.113.10

.EXAMPLE
  .\deploy-stack.ps1 -Server mba.mouftools.com -User ubuntu -OnlyWorker
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Server,
  [string] $User    = 'root',
  [string] $WorkDir = (Join-Path $env:USERPROFILE 'mouftools-stack'),
  [switch] $OnlyWorker,
  [switch] $OnlyMba
)

$ErrorActionPreference = 'Stop'
$Target = "$User@$Server"

$Repos = @{
  'MultiBoyAdvance' = 'https://github.com/alexmouf-work/MultiBoyAdvance.git'
  'mouftools-osint' = 'https://github.com/alexmouf-work/mouftools-osint.git'
}

# ---------------------------------------------------------------- utilities

function Step  ($m) { Write-Host "`n=== $m" -ForegroundColor Cyan }
function Info  ($m) { Write-Host "    $m" -ForegroundColor Gray }
function Ok    ($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn  ($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Die   ($m) { Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

# Native commands don't throw on failure, so every call is checked explicitly.
function Run ($exe, [string[]] $arguments, [switch] $AllowFail) {
  & $exe @arguments
  if (-not $AllowFail -and $LASTEXITCODE -ne 0) {
    Die "$exe $($arguments -join ' ') failed (exit $LASTEXITCODE)"
  }
  return $LASTEXITCODE
}

function Remote ([string] $command, [switch] $AllowFail) {
  return (Run 'ssh' @($Target, $command) -AllowFail:$AllowFail)
}

# ------------------------------------------------------------- 0. preflight

Step 'Preflight'

foreach ($tool in 'git', 'ssh', 'scp') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Die "'$tool' is not on PATH. Install Git for Windows, and enable the built-in OpenSSH client (Settings > Apps > Optional Features)."
  }
}
Ok 'git, ssh and scp are available'

Info "testing SSH to $Target ..."
if ((Remote 'true' -AllowFail) -ne 0) {
  Die "cannot SSH to $Target. Check the address, your key, and that the box is up."
}
Ok "SSH to $Target works"

if ((Remote 'sudo -n true' -AllowFail) -ne 0) {
  Warn 'passwordless sudo is unavailable — you may be prompted for a password.'
}

# ------------------------------------------------------------ 1. local repos

Step "Syncing repos into $WorkDir"

if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir | Out-Null }

foreach ($name in $Repos.Keys) {
  $path = Join-Path $WorkDir $name
  if (Test-Path (Join-Path $path '.git')) {
    Info "$name — pulling"
    Run 'git' @('-C', $path, 'fetch', '--quiet', 'origin', 'main')
    Run 'git' @('-C', $path, 'checkout', '--quiet', 'main')
    Run 'git' @('-C', $path, 'merge', '--ff-only', '--quiet', 'origin/main')
  } else {
    Info "$name — cloning"
    Run 'git' @('clone', '--quiet', '--branch', 'main', $Repos[$name], $path)
  }
  Ok "$name at $(git -C $path rev-parse --short HEAD)"
}

# --------------------------------------------------- 2. MultiBoyAdvance auto-update

if (-not $OnlyWorker) {
  Step 'MultiBoyAdvance — installing auto-update'

  $mba = Join-Path $WorkDir 'MultiBoyAdvance'

  Info 'uploading deploy scripts'
  Remote 'rm -rf /tmp/mba-deploy && mkdir -p /tmp/mba-deploy' | Out-Null
  Run 'scp' @('-q', '-r', (Join-Path $mba 'deploy\*'), "${Target}:/tmp/mba-deploy/")

  Info 'running setup (this converts /opt/mba into a git checkout)'
  $code = Remote 'sudo bash /tmp/mba-deploy/setup-autoupdate.sh' -AllowFail

  if ($code -eq 2) {
    Write-Host ''
    Warn 'The box needs read access to the MultiBoyAdvance repo.'
    Warn 'Add the deploy key printed above at:'
    Warn '  https://github.com/alexmouf-work/MultiBoyAdvance/settings/keys/new'
    Warn 'then re-run this script. Nothing on the box was changed.'
    exit 2
  }
  if ($code -ne 0) { Die "MBA auto-update setup failed (exit $code)" }
  Ok 'auto-update timer installed and running'
}

# ------------------------------------------------------- 3. Bermuda worker

if (-not $OnlyMba) {
  Step 'Bermuda — provisioning the always-on worker'

  $worker = Join-Path (Join-Path $WorkDir 'mouftools-osint') 'worker'

  Info 'uploading the worker'
  Remote 'rm -rf /tmp/bermuda-worker && mkdir -p /tmp/bermuda-worker' | Out-Null
  Run 'scp' @('-q', '-r', (Join-Path $worker '*'), "${Target}:/tmp/bermuda-worker/")

  Info 'running setup (first Docker build takes a few minutes)'
  $code = Remote 'sudo bash /tmp/bermuda-worker/deploy/setup-worker.sh' -AllowFail
  if ($code -ne 0) { Die "Bermuda worker setup failed (exit $code)" }

  # The worker can't start without the Supabase service-role key.
  $hasKey = (Remote 'sudo grep -q "^SUPABASE_SERVICE_ROLE_KEY=.\+" /opt/bermuda-worker/.env' -AllowFail) -eq 0

  if (-not $hasKey) {
    Write-Host ''
    Warn 'The worker needs the Supabase service-role key before it can start.'
    Warn 'Find it in Supabase > Project Settings > API > service_role.'
    Write-Host ''
    $secure = Read-Host 'Paste the key (leave blank to skip)' -AsSecureString
    $plain  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

    if ($plain) {
      # Piped over stdin so the secret never lands in a command line or the
      # remote process list.
      $remoteCmd = 'sudo bash -c ''read -r K; ' +
                   'sed -i "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$K|" /opt/bermuda-worker/.env; ' +
                   'chmod 600 /opt/bermuda-worker/.env'''
      $plain | & ssh $Target $remoteCmd
      if ($LASTEXITCODE -ne 0) { Die 'failed to write the key' }
      Ok 'key stored at /opt/bermuda-worker/.env (mode 0600)'

      Info 'starting the worker'
      Remote 'sudo systemctl restart bermuda-worker' | Out-Null
    } else {
      Warn 'Skipped. Add it later, then: sudo systemctl restart bermuda-worker'
    }
  } else {
    Ok 'Supabase key already present'
    Remote 'sudo systemctl restart bermuda-worker' | Out-Null
  }
}

# ------------------------------------------------------------- 4. verify

Step 'Status'

Remote 'echo "--- mba (world server)"; systemctl is-active mba || true; echo "--- mba auto-update timer"; systemctl list-timers --no-pager mba-update 2>/dev/null | head -3 || true; echo "--- bermuda worker"; systemctl is-active bermuda-worker || true' -AllowFail | Out-Null

Remote 'rm -rf /tmp/mba-deploy /tmp/bermuda-worker' -AllowFail | Out-Null

Write-Host @"

Done.

  MultiBoyAdvance   polls git every 5 minutes and fast-forwards itself.
                    Push to main and it lands within ~5 minutes.
                      journalctl -t mba-update -n 50
                      sudo systemctl start mba-update.service   # force now

  Bermuda worker    always on; restarts after crashes and reboots.
                      sudo docker compose -f /opt/bermuda-worker/docker-compose.yml logs -f worker

  NOTE  auto-update ships code, not the ROM. rom/build/mba.gba is gitignored
        and never committed, so after rebuilding it run the old path:
          .\deploy-mba.ps1 -HostAddr $Server

  Panoculus is on Vercel, not this box:
    1. Import the panoculus repo at https://vercel.com/new
    2. Framework preset: Other. Confirm Output Directory is 'web'.
    3. Add TMDB_API_KEY under Environment Variables.
    4. Add the domain panoculus.mouftools.com and create the CNAME it shows.

"@ -ForegroundColor Green
