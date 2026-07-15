#!/usr/bin/env bash
# MultiBoyAdvance ROM build: clone pret/pokeemerald, drop in the netcode
# overlay, apply the three integration hooks, build with the modern toolchain.
# Run under Linux or WSL2 (see docs/SETUP-WINDOWS.md). Idempotent.
set -euo pipefail
# MBA_ROM_DIR lets Windows launchers run a CR-stripped copy of this script
# from elsewhere while still operating on the real rom/ directory.
cd "${MBA_ROM_DIR:-$(dirname "$0")}"

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

# 3c. battle_setup.c: open the co-op join window when battles start
if ! applied 'NetOnBattleOpen' src/battle_setup.c; then
  hook src/battle_setup.c 'static void DoStandardWildBattle(void)' "battle open hooks"
  sed -i '0,/^#include/s//#include "net\/net.h"\n&/' "$PKE/src/battle_setup.c"
  perl -0pi -e 's/(static void DoStandardWildBattle\(void\)\n\{\n    LockPlayerFieldControls\(\);)/$1\n    NetOnBattleOpen(0, GetMonData(&gEnemyParty[0], MON_DATA_SPECIES, NULL));/' "$PKE/src/battle_setup.c"
  perl -0pi -e 's/(void BattleSetup_StartTrainerBattle\(void\)\n\{)/$1\n    NetOnBattleOpen(1, gTrainerBattleOpponent_A);/' "$PKE/src/battle_setup.c"
fi
applied 'NetOnBattleOpen(0,' src/battle_setup.c && say "  ✅ battle_setup.c: wild battle hook"
applied 'NetOnBattleOpen(1,' src/battle_setup.c && say "  ✅ battle_setup.c: trainer battle hook" \
  || die "trainer battle hook did not apply — add manually (rom/README.md §Hooks)"

# 3d. battle_main.c: report finalized turn choices (emit-only)
if ! applied 'NetOnTurnFinalized' src/battle_main.c; then
  hook src/battle_main.c 'static void CheckFocusPunch_ClearVarsBeforeTurnStarts(void)' "turn-finalized hook"
  sed -i '0,/^#include/s//#include "net\/net.h"\n&/' "$PKE/src/battle_main.c"
  perl -0pi -e 's/(static void CheckFocusPunch_ClearVarsBeforeTurnStarts\(void\)\n\{)/$1\n    NetOnTurnFinalized();/' "$PKE/src/battle_main.c"
fi
applied 'NetOnTurnFinalized();' src/battle_main.c && say "  ✅ battle_main.c: turn-finalized hook" \
  || die "turn hook did not apply — add manually (rom/README.md §Hooks)"

# 3f. new_game.c: multiplayer quick start — new games spawn in Oldale Town
# outside the Pokémon Center, story machine marked post-rescue. Two pieces:
# the truck warp is redirected, and NetQuickStart() runs at the END of
# NewGameInitData (after EventScript_ResetAllMapFlags, which would otherwise
# re-clobber the flags it sets). Starter comes via the web picker.
# Migrate the v1 hook (Littleroot spawn, NetQuickStart before the warp):
if applied 'MAP_LITTLEROOT_TOWN), MAP_NUM(MAP_LITTLEROOT_TOWN), WARP_ID_NONE, 10, 12' src/new_game.c; then
  perl -0pi -e 's/    NetQuickStart\(\);\n    SetWarpDestination\(MAP_GROUP\(MAP_LITTLEROOT_TOWN\), MAP_NUM\(MAP_LITTLEROOT_TOWN\), WARP_ID_NONE, 10, 12\);/    SetWarpDestination(MAP_GROUP(MAP_OLDALE_TOWN), MAP_NUM(MAP_OLDALE_TOWN), WARP_ID_NONE, 6, 17);/' "$PKE/src/new_game.c"
fi
if ! applied 'MAP_OLDALE_TOWN' src/new_game.c; then
  hook src/new_game.c 'MAP_INSIDE_OF_TRUCK' "multiplayer quick start (spawn warp)"
  perl -0pi -e 's/    SetWarpDestination\(MAP_GROUP\(MAP_INSIDE_OF_TRUCK\), MAP_NUM\(MAP_INSIDE_OF_TRUCK\), WARP_ID_NONE, -1, -1\);/    SetWarpDestination(MAP_GROUP(MAP_OLDALE_TOWN), MAP_NUM(MAP_OLDALE_TOWN), WARP_ID_NONE, 6, 17);/' "$PKE/src/new_game.c"
fi
if ! applied '#include "net/net.h"' src/new_game.c; then
  sed -i '0,/^#include/s//#include "net\/net.h"\n&/' "$PKE/src/new_game.c"
fi
if ! applied 'NetQuickStart();' src/new_game.c; then
  hook src/new_game.c 'RunScriptImmediately(EventScript_ResetAllMapFlags);' "multiplayer quick start (init)"
  perl -0pi -e 's/(    RunScriptImmediately\(EventScript_ResetAllMapFlags\);)/$1\n    NetQuickStart();/' "$PKE/src/new_game.c"
fi
applied 'MAP_OLDALE_TOWN), MAP_NUM(MAP_OLDALE_TOWN), WARP_ID_NONE, 6, 17' src/new_game.c \
  && applied 'NetQuickStart();' src/new_game.c && say "  ✅ new_game.c: multiplayer quick start (Oldale spawn)" \
  || die "quick start hook did not apply — add manually (rom/README.md §Hooks)"

# 3g. main_menu.c: NEW GAME goes straight to the world — no Birch speech, no
# naming screen (the server sets the registered name via ADMIN SET_NAME).
# Mirrors the ACTION_CONTINUE arm two cases below. NB: the applied marker must
# be the comment — a bare SetMainCallback2(CB2_NewGame) already exists in the
# Birch cleanup task.
if ! applied '// MBA: skip Birch intro' src/main_menu.c; then
  hook src/main_menu.c 'gTasks[taskId].func = Task_NewGameBirchSpeech_Init;' "skip Birch intro"
  perl -0pi -e 's/                gTasks\[taskId\]\.func = Task_NewGameBirchSpeech_Init;\n                break;/                SetMainCallback2(CB2_NewGame); \/\/ MBA: skip Birch intro\n                DestroyTask(taskId);\n                break;/' "$PKE/src/main_menu.c"
fi
applied '// MBA: skip Birch intro' src/main_menu.c && say "  ✅ main_menu.c: skip Birch intro" \
  || die "Birch-skip hook did not apply — add manually (rom/README.md §Hooks)"

# 3h. overworld.c: CB2_NewGame must not run the truck cutscene on our spawn
# map — its script drives truck-interior objects that don't exist there.
if ! applied 'gFieldCallback = NULL; // MBA quickstart' src/overworld.c; then
  hook src/overworld.c 'gFieldCallback = ExecuteTruckSequence;' "no truck cutscene"
  perl -0pi -e 's/    gFieldCallback = ExecuteTruckSequence;/    gFieldCallback = NULL; \/\/ MBA quickstart: no truck cutscene/' "$PKE/src/overworld.c"
fi
applied 'gFieldCallback = NULL; // MBA quickstart' src/overworld.c && say "  ✅ overworld.c: no truck cutscene" \
  || die "truck-cutscene hook did not apply — add manually (rom/README.md §Hooks)"

# --- 4. build -----------------------------------------------------------------------
say "building (make modern)…"
make -C "$PKE" modern -j"$(nproc)"

mkdir -p "$OUT"
cp "$PKE/pokeemerald_modern.gba" "$OUT/mba.gba"
say "done → rom/$OUT/mba.gba"
say "load it in the web client, or in desktop mGBA with rom/lua/mba-bridge.lua"
