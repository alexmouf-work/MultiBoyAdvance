#!/usr/bin/env bash
# Deploy/update MultiBoyAdvance on a provisioned VPS (see setup-vps.sh).
# Run from the repo root on WSL/macOS/Linux:
#   deploy/deploy-mba.sh <host-or-ip> [ssh-user]
# Ships server/ + web/ (with the vendored emulator) + the current ROM build.
# Never touches server/data on the box (world state survives deploys).
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${1:?usage: deploy/deploy-mba.sh <host-or-ip> [ssh-user]}"
USER="${2:-ubuntu}"

[ -f rom/build/mba.gba ] || echo "WARNING: rom/build/mba.gba missing - deploying without a ROM (players get demo/join disabled)"

BUNDLE=$(mktemp /tmp/mba-deploy-XXXX.tgz)
tar czf "$BUNDLE" \
  --exclude='server/node_modules' --exclude='server/data' \
  --exclude='web/node_modules' \
  server web $( [ -f rom/build/mba.gba ] && echo rom/build/mba.gba )

scp "$BUNDLE" "${USER}@${HOST}:/tmp/mba-deploy.tgz"
rm -f "$BUNDLE"

ssh "${USER}@${HOST}" '
  set -e
  sudo tar xzf /tmp/mba-deploy.tgz -C /opt/mba
  cd /opt/mba/server && sudo npm install --omit=dev --no-audit --no-fund
  sudo chown -R mba:mba /opt/mba
  sudo systemctl restart mba
  rm -f /tmp/mba-deploy.tgz
  sleep 1 && systemctl is-active mba
'
echo "deployed - check https://your-domain (or the server logs: ssh ${USER}@${HOST} journalctl -u mba -n 20)"
