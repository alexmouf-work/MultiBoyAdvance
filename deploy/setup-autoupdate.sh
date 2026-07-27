#!/usr/bin/env bash
# Turn /opt/mba into a git checkout and install the update timer.
# Run ON the box:
#   sudo bash deploy/setup-autoupdate.sh
#
# Idempotent — safe to re-run. If the repo is private this exits once to let
# you paste a deploy key into GitHub, then does the rest on the second run.
set -euo pipefail

DIR=/opt/mba
BRANCH=main
OWNER=alexmouf-work
REPO=MultiBoyAdvance
REPO_HTTPS="https://github.com/$OWNER/$REPO.git"
REPO_SSH="git@github.com:$OWNER/$REPO.git"
KEY=/root/.ssh/mba_deploy_ed25519
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
command -v git >/dev/null || { echo "==> installing git"; apt-get update -qq && apt-get install -y -qq git; }

[ -d "$DIR" ] || { echo "ERROR: $DIR does not exist — run deploy/setup-vps.sh first" >&2; exit 1; }

git config --global --add safe.directory "$DIR" 2>/dev/null || true

# --- how does this box reach the repo? --------------------------------------
echo "==> checking repository access"
SSH_CMD="ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -i $KEY"

if git ls-remote --quiet "$REPO_HTTPS" HEAD >/dev/null 2>&1; then
  URL="$REPO_HTTPS"
  USE_KEY=0
  echo "    repo is reachable anonymously over HTTPS — no deploy key needed"
else
  URL="$REPO_SSH"
  USE_KEY=1
  if [ ! -f "$KEY" ]; then
    echo "==> generating a read-only deploy key for this box"
    install -d -m 0700 /root/.ssh
    ssh-keygen -t ed25519 -N '' -C "mba-autoupdate@$(hostname)" -f "$KEY" >/dev/null
  fi

  if ! GIT_SSH_COMMAND="$SSH_CMD" git ls-remote --quiet "$REPO_SSH" HEAD >/dev/null 2>&1; then
    cat <<KEYMSG

──────────────────────────────────────────────────────────────────────────
The repo is private and this box can't read it yet. Add its public key as a
deploy key (read-only is enough):

  https://github.com/$OWNER/$REPO/settings/keys/new

$(cat "$KEY.pub")

Then re-run this script. Nothing has been changed yet.
──────────────────────────────────────────────────────────────────────────

KEYMSG
    exit 2
  fi
  echo "    deploy key works"
fi

# --- adopt /opt/mba into git -------------------------------------------------
# Everything that must survive is gitignored (rom/build, server/data,
# node_modules, web/vendor), so checkout leaves it alone.
if [ ! -d "$DIR/.git" ]; then
  echo "==> adopting $DIR as a git checkout (ignored files are left alone)"
  git -C "$DIR" init -q -b "$BRANCH"
  git -C "$DIR" remote add origin "$URL"
else
  echo "==> $DIR is already a checkout — pointing it at $URL"
  git -C "$DIR" remote set-url origin "$URL"
fi

if [ "$USE_KEY" = 1 ]; then
  git -C "$DIR" config core.sshCommand "$SSH_CMD"
fi

echo "==> fetching $BRANCH"
git -C "$DIR" fetch --quiet origin "$BRANCH"
# -f because the box already holds these files from previous tar deploys.
git -C "$DIR" checkout -f -B "$BRANCH" "origin/$BRANCH" >/dev/null 2>&1
git -C "$DIR" branch --quiet --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true

if [ ! -d "$DIR/server/node_modules" ]; then
  echo "==> installing server dependencies"
  (cd "$DIR/server" && npm install --omit=dev --no-audit --no-fund >/dev/null)
fi

chown -R mba:mba "$DIR"
chmod +x "$DIR/deploy/mba-update.sh"

# --- timer -------------------------------------------------------------------
echo "==> installing the update timer"
cp "$HERE/mba-update.service" /etc/systemd/system/mba-update.service
cp "$HERE/mba-update.timer"   /etc/systemd/system/mba-update.timer
systemctl daemon-reload
systemctl enable --now mba-update.timer

cat <<DONE

Auto-update is live. The box checks origin/$BRANCH every 5 minutes and
fast-forwards itself; push to main and it lands within ~5 minutes.

  next check   systemctl list-timers mba-update
  what it did  journalctl -t mba-update -n 50
  force now    sudo systemctl start mba-update.service

It restarts the world server only when server/, web/ or package.json changed,
so a docs-only commit won't kick players out. The ROM, server/data, and
node_modules are gitignored and are never touched by an update.

DONE
