#!/usr/bin/env bash
# Deploys the whole mouftools server stack to the box, from a cold start.
# The bash twin of scripts/deploy-stack.ps1 — for WSL, macOS or Linux.
#
#   deploy/deploy-stack.sh <host-or-ip> [ssh-user]
#
# Clones (or updates) the repos it needs into ~/mouftools-stack, then over SSH:
#   1. installs MultiBoyAdvance auto-update (box polls git every 5 minutes)
#   2. provisions and starts the always-on Bermuda OSINT worker
#
# Idempotent — re-running is safe, and is how you ship changes.
# Panoculus is not handled here; it deploys to Vercel from a git push.
set -euo pipefail

SERVER="${1:?usage: deploy/deploy-stack.sh <host-or-ip> [ssh-user]}"
SSH_USER="${2:-root}"
TARGET="${SSH_USER}@${SERVER}"
WORKDIR="${MOUFTOOLS_WORKDIR:-$HOME/mouftools-stack}"

MBA_URL=https://github.com/alexmouf-work/MultiBoyAdvance.git
OSINT_URL=https://github.com/alexmouf-work/mouftools-osint.git

step() { printf '\n\033[36m=== %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- 0. preflight

step 'Preflight'
for tool in git ssh scp; do
  command -v "$tool" >/dev/null || die "'$tool' is not installed."
done
ok 'git, ssh and scp are available'

info "testing SSH to $TARGET ..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" true \
  || die "cannot SSH to $TARGET. Check the address, your key, and that the box is up."
ok "SSH to $TARGET works"

ssh "$TARGET" 'sudo -n true' 2>/dev/null \
  || warn 'passwordless sudo is unavailable — you may be prompted for a password.'

# ----------------------------------------------------------- 1. local repos

step "Syncing repos into $WORKDIR"
mkdir -p "$WORKDIR"

sync_repo() {
  local name="$1" url="$2" path="$WORKDIR/$1"
  if [ -d "$path/.git" ]; then
    info "$name — pulling"
    git -C "$path" fetch --quiet origin main
    git -C "$path" checkout --quiet main
    git -C "$path" merge --ff-only --quiet origin/main
  else
    info "$name — cloning"
    git clone --quiet --branch main "$url" "$path"
  fi
  ok "$name at $(git -C "$path" rev-parse --short HEAD)"
}

sync_repo MultiBoyAdvance "$MBA_URL"
sync_repo mouftools-osint "$OSINT_URL"

# ------------------------------------------ 2. MultiBoyAdvance auto-update

step 'MultiBoyAdvance — installing auto-update'
info 'uploading deploy scripts'
ssh "$TARGET" 'rm -rf /tmp/mba-deploy && mkdir -p /tmp/mba-deploy'
scp -q -r "$WORKDIR/MultiBoyAdvance/deploy/." "$TARGET:/tmp/mba-deploy/"

info 'running setup (this converts /opt/mba into a git checkout)'
set +e
ssh -t "$TARGET" 'sudo bash /tmp/mba-deploy/setup-autoupdate.sh'
CODE=$?
set -e

if [ "$CODE" = 2 ]; then
  echo
  warn 'The box needs read access to the MultiBoyAdvance repo.'
  warn 'Add the deploy key printed above at:'
  warn '  https://github.com/alexmouf-work/MultiBoyAdvance/settings/keys/new'
  warn 'then re-run this script. Nothing on the box was changed.'
  exit 2
fi
[ "$CODE" = 0 ] || die "MBA auto-update setup failed (exit $CODE)"
ok 'auto-update timer installed and running'

# ---------------------------------------------------------- 3. Bermuda worker

step 'Bermuda — provisioning the always-on worker'
info 'uploading the worker'
ssh "$TARGET" 'rm -rf /tmp/bermuda-worker && mkdir -p /tmp/bermuda-worker'
scp -q -r "$WORKDIR/mouftools-osint/worker/." "$TARGET:/tmp/bermuda-worker/"

info 'running setup (first Docker build takes a few minutes)'
ssh -t "$TARGET" 'sudo bash /tmp/bermuda-worker/deploy/setup-worker.sh' \
  || die 'Bermuda worker setup failed'

if ssh "$TARGET" 'sudo grep -q "^SUPABASE_SERVICE_ROLE_KEY=.\+" /opt/bermuda-worker/.env' 2>/dev/null; then
  ok 'Supabase key already present'
  ssh "$TARGET" 'sudo systemctl restart bermuda-worker'
else
  echo
  warn 'The worker needs the Supabase service-role key before it can start.'
  warn 'Find it in Supabase > Project Settings > API > service_role.'
  echo
  read -rsp '    Paste the key (leave blank to skip): ' KEY
  echo
  if [ -n "$KEY" ]; then
    # Piped over stdin so the secret never lands in a command line or the
    # remote process list.
    printf '%s\n' "$KEY" | ssh "$TARGET" 'sudo bash -c '"'"'read -r K; sed -i "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$K|" /opt/bermuda-worker/.env; chmod 600 /opt/bermuda-worker/.env'"'"''
    unset KEY
    ok 'key stored at /opt/bermuda-worker/.env (mode 0600)'
    info 'starting the worker'
    ssh "$TARGET" 'sudo systemctl restart bermuda-worker'
  else
    warn 'Skipped. Add it later, then: sudo systemctl restart bermuda-worker'
  fi
fi

# ---------------------------------------------------------------- 4. verify

step 'Status'
ssh "$TARGET" '
  echo "--- mba (world server)";     systemctl is-active mba || true
  echo "--- mba auto-update timer";  systemctl list-timers --no-pager mba-update 2>/dev/null | head -3 || true
  echo "--- bermuda worker";         systemctl is-active bermuda-worker || true
' || true

ssh "$TARGET" 'rm -rf /tmp/mba-deploy /tmp/bermuda-worker' || true

cat <<DONE

Done.

  MultiBoyAdvance   polls git every 5 minutes and fast-forwards itself.
                    Push to main and it lands within ~5 minutes.
                      journalctl -t mba-update -n 50
                      sudo systemctl start mba-update.service   # force now

  Bermuda worker    always on; restarts after crashes and reboots.
                      sudo docker compose -f /opt/bermuda-worker/docker-compose.yml logs -f worker

  NOTE  auto-update ships code, not the ROM. rom/build/mba.gba is gitignored
        and never committed, so after rebuilding it run the old path:
          deploy/deploy-mba.sh $SERVER $SSH_USER

  Panoculus is on Vercel, not this box:
    1. Import the panoculus repo at https://vercel.com/new
    2. Framework preset: Other. Confirm Output Directory is 'web'.
    3. Add TMDB_API_KEY under Environment Variables.
    4. Add the domain panoculus.mouftools.com and create the CNAME it shows.

DONE
