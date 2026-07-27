#!/usr/bin/env bash
# Runs ON the box, on a timer (see mba-update.timer). Fetches origin/main and,
# if it has moved, fast-forwards /opt/mba and restarts the world server.
#
# Safe because everything that must survive an update is gitignored and so is
# never touched by a pull:
#   rom/build/, *.gba   the ROM (built on your PC, never committed)
#   server/data/        the live world state
#   node_modules/       installed deps
#   web/vendor/         the vendored mGBA-WASM core
#
# Restarts only when code that actually runs has changed, so a docs-only commit
# doesn't kick players out of the world.
set -euo pipefail

# MBA_DIR / MBA_LOCK are overridable so deploy/test-update.sh can exercise this
# against a scratch repo. In production the defaults are what run.
DIR="${MBA_DIR:-/opt/mba}"
LOCK="${MBA_LOCK:-/var/lock/mba-update.lock}"
BRANCH=main
LOG_TAG=mba-update

log() { logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true; echo "[$LOG_TAG] $*"; }

# Two timer firings must never overlap a pull.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another update is already running; skipping"
  exit 0
fi

cd "$DIR"

# Root operating on the mba user's checkout.
git config --global --add safe.directory "$DIR" 2>/dev/null || true

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  log "ERROR: $DIR is not a git checkout — run deploy/setup-autoupdate.sh first"
  exit 1
fi

if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  log "fetch failed (network or credentials) — will retry next tick"
  exit 0
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
log "update $(git rev-parse --short HEAD) -> $(git rev-parse --short "origin/$BRANCH") ($(echo "$CHANGED" | wc -l) files)"

# --ff-only: if the box has somehow diverged, stop and say so rather than
# silently discarding whatever is here.
if ! git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
  log "ERROR: $DIR has diverged from origin/$BRANCH — not updating. Resolve by hand."
  exit 1
fi

# The `if` form matters: an `id && chown` one-liner returns non-zero when the
# user is absent, and set -e would abort the update half-done.
own() {
  if id -u mba >/dev/null 2>&1; then chown -R mba:mba "$1"; fi
}
own "$DIR"

if echo "$CHANGED" | grep -qE '^server/package(-lock)?\.json$'; then
  log "server dependencies changed — npm install"
  (cd "$DIR/server" && npm install --omit=dev --no-audit --no-fund >/dev/null)
  own "$DIR/server"
fi

# web/ is served straight off disk, so a web-only change needs no restart —
# but the server also reads from it at boot, and restarting is cheap and
# predictable, so anything under server/ or web/ counts as runtime.
if echo "$CHANGED" | grep -qE '^(server/|web/|package\.json)'; then
  log "runtime changed — restarting mba"
  systemctl restart mba
  sleep 2
  if systemctl is-active --quiet mba; then
    log "mba is up on $(git rev-parse --short HEAD)"
  else
    log "ERROR: mba failed to start after update"
    exit 1
  fi
else
  log "no runtime changes — not restarting"
fi
