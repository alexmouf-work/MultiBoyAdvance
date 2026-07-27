#!/usr/bin/env bash
# Exercises deploy/mba-update.sh against a scratch repo — no box required.
#
#   deploy/test-update.sh
#
# Builds a fake origin and a fake /opt/mba, stubs systemctl and npm, then
# checks the behaviour that matters: what triggers a restart, what triggers an
# npm install, and that gitignored files (the ROM, the world state) survive.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE="$HERE/mba-update.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  FAIL %s — expected %q, got %q\n' "$1" "$3" "$2"; fail=$((fail + 1))
  fi
}

# --- stubs ------------------------------------------------------------------
mkdir -p "$TMP/bin"
cat > "$TMP/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$TMP/systemctl.log"
[ "\$1" = "is-active" ] && exit 0
exit 0
EOF
cat > "$TMP/bin/npm" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$TMP/npm.log"
exit 0
EOF
chmod +x "$TMP/bin/systemctl" "$TMP/bin/npm"
export PATH="$TMP/bin:$PATH"

export MBA_DIR="$TMP/mba"
export MBA_LOCK="$TMP/lock"

run_update() {
  : > "$TMP/systemctl.log"
  : > "$TMP/npm.log"
  bash "$UPDATE" > "$TMP/out.log" 2>&1
}
restarted() { grep -q '^restart mba$' "$TMP/systemctl.log" && echo yes || echo no; }
installed() { [ -s "$TMP/npm.log" ] && echo yes || echo no; }

# --- a fake origin ----------------------------------------------------------
ORIGIN="$TMP/origin"
mkdir -p "$ORIGIN"
git -C "$ORIGIN" init -q -b main
git -C "$ORIGIN" config user.email t@t; git -C "$ORIGIN" config user.name t
mkdir -p "$ORIGIN/server" "$ORIGIN/web" "$ORIGIN/docs"
cat > "$ORIGIN/.gitignore" <<'GI'
server/data/
rom/build/
*.gba
node_modules/
GI
echo 'v1'          > "$ORIGIN/server/index.js"
echo '{"v":1}'     > "$ORIGIN/server/package.json"
echo 'hello'       > "$ORIGIN/web/index.html"
echo 'notes'       > "$ORIGIN/docs/README.md"
git -C "$ORIGIN" add -A >/dev/null
git -C "$ORIGIN" commit -qm init

# --- the box's checkout, plus files that must survive -----------------------
git clone -q "$ORIGIN" "$MBA_DIR"
git -C "$MBA_DIR" config user.email t@t; git -C "$MBA_DIR" config user.name t
mkdir -p "$MBA_DIR/rom/build" "$MBA_DIR/server/data" "$MBA_DIR/server/node_modules"
echo 'ROMDATA'  > "$MBA_DIR/rom/build/mba.gba"
echo 'WORLD'    > "$MBA_DIR/server/data/world.json"
echo 'dep'      > "$MBA_DIR/server/node_modules/marker"

commit_to_origin() {
  git -C "$ORIGIN" add -A >/dev/null
  git -C "$ORIGIN" commit -qm "$1"
}

echo
echo 'already up to date'
run_update
check 'no restart when nothing changed'      "$(restarted)" no
check 'no npm install when nothing changed'  "$(installed)" no

echo
echo 'docs-only change'
echo 'more notes' >> "$ORIGIN/docs/README.md"
commit_to_origin docs
run_update
check 'pulled the commit' \
  "$(git -C "$MBA_DIR" rev-parse HEAD)" "$(git -C "$ORIGIN" rev-parse HEAD)"
check 'does NOT restart for docs'            "$(restarted)" no

echo
echo 'server code change'
echo 'v2' > "$ORIGIN/server/index.js"
commit_to_origin server
run_update
check 'restarts for server/ changes'         "$(restarted)" yes
check 'no npm install without a manifest change' "$(installed)" no
check 'new code is on the box'               "$(cat "$MBA_DIR/server/index.js")" v2

echo
echo 'dependency change'
echo '{"v":2}' > "$ORIGIN/server/package.json"
commit_to_origin deps
run_update
check 'runs npm install when package.json moves' "$(installed)" yes
check 'restarts too'                             "$(restarted)" yes

echo
echo 'web-only change'
echo 'bye' > "$ORIGIN/web/index.html"
commit_to_origin web
run_update
check 'restarts for web/ changes'            "$(restarted)" yes

echo
echo 'files that must survive every update'
check 'ROM survived'          "$(cat "$MBA_DIR/rom/build/mba.gba")" ROMDATA
check 'world state survived'  "$(cat "$MBA_DIR/server/data/world.json")" WORLD
check 'node_modules survived' "$(cat "$MBA_DIR/server/node_modules/marker")" dep

echo
echo 'a diverged box is left alone'
echo 'local hack' > "$MBA_DIR/server/index.js"
git -C "$MBA_DIR" commit -qam 'local commit'
DIVERGED=$(git -C "$MBA_DIR" rev-parse HEAD)
echo 'v3' > "$ORIGIN/server/index.js"
commit_to_origin upstream
set +e
run_update
code=$?
set -e
check 'refuses to update'          "$code" 1
check 'says so'                    "$(grep -c diverged "$TMP/out.log")" 1
check 'leaves the checkout intact' "$(git -C "$MBA_DIR" rev-parse HEAD)" "$DIVERGED"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
