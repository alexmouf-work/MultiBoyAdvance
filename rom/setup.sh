#!/usr/bin/env bash
# MultiBoyAdvance ROM build: clone pret/pokeemerald, drop in the netcode
# overlay, apply the three integration hooks, build with the modern toolchain.
# Run under Linux or WSL2 (see docs/SETUP-WINDOWS.md). Idempotent.
set -euo pipefail
cd "$(dirname "$0")"

PKE=pokeemerald
OUT=build

say() { printf '\n\033[1m[mba-rom]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[mba-rom] %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. prerequisites ---------------------------------------------------------
command -v git >/dev/null || die "git not found"
command -v arm-none-eabi-gcc >/dev/null || die "arm-none-eabi-gcc not found (apt install gcc-arm-none-eabi binutils-arm-none-eabi)"

# --- 1. sources ----------------------------------------------------------------
if [ ! -d "$PKE" ]; then
  say "cloning pret/pokeemerald…"
  git clone https://github.com/pret/pokeemerald.git "$PKE"
fi

# --- 2. overlay ------------------------------------------------------------------
say "copying overlay (src/net_*.c, include/net/)…"
cp overlay/src/net_*.c "$PKE/src/"
mkdir -p "$PKE/include/net"
cp overlay/include/net/*.h "$PKE/include/net/"

# --- 3. hooks ---------------------------------------------------------------------
# Each hook is a small, verified insertion. If an anchor is missing (upstream
# drift), we fail loudly with the manual instruction from rom/README.md.
hook() { # file, grep-anchor, description
  local file=$1 anchor=$2 desc=$3
  grep -qF "$anchor" "$PKE/$file" || die "anchor not found in $file for: $desc — apply manually (rom/README.md §Hooks)"
}
applied() { grep -qF "$1" "$PKE/$2"; }

say "applying hooks…"

# 3a. main.c: per-frame NetTick() after ReadKeys() in the main loop
if ! applied 'NetTick();' src/main.c; then
  hook src/main.c 'ReadKeys();' "NetTick() in main loop"
  sed -i '0,/^#include/s//#include "net\/net.h"\n&/' "$PKE/src/main.c"
  sed -i '0,/ReadKeys();/s//ReadKeys();\n        NetTick();/' "$PKE/src/main.c"
fi
applied 'NetTick();' src/main.c && say "  ✅ main.c: NetTick()"

# 3b. event_data.c: report FlagSet / VarSet
if ! applied 'NetOnFlagSet' src/event_data.c; then
  hook src/event_data.c 'u8 FlagSet(u16 id)' "FlagSet hook"
  sed -i '0,/^#include/s//#include "net\/net.h"\n&/' "$PKE/src/event_data.c"
  # insert before the return of FlagSet
  perl -0pi -e 's/(u8 FlagSet\(u16 id\)\n\{.*?)(\n    return 0;\n\})/$1\n    NetOnFlagSet(id);$2/s' "$PKE/src/event_data.c"
  # insert after VarSet stores the value
  perl -0pi -e 's/(bool8 VarSet\(u16 id, u16 value\)\n\{.*?\n    \*ptr = value;)/$1\n    NetOnVarSet(id, value);/s' "$PKE/src/event_data.c"
fi
applied 'NetOnFlagSet(id);' src/event_data.c && say "  ✅ event_data.c: NetOnFlagSet()"
applied 'NetOnVarSet(id, value);' src/event_data.c && say "  ✅ event_data.c: NetOnVarSet()" \
  || die "VarSet hook did not apply — add manually (rom/README.md §Hooks)"

# --- 4. build -----------------------------------------------------------------------
say "building (make modern)…"
make -C "$PKE" modern -j"$(nproc)"

mkdir -p "$OUT"
cp "$PKE/pokeemerald_modern.gba" "$OUT/mba.gba"
say "done → rom/$OUT/mba.gba"
say "load it in the web client, or in desktop mGBA with rom/lua/mba-bridge.lua"
