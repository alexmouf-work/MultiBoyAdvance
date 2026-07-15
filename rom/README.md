# rom/ — the netcode ROM

This directory turns [pret/pokeemerald](https://github.com/pret/pokeemerald)
into the MultiBoyAdvance game. Nothing of Nintendo's is stored here: `setup.sh`
clones the decompilation at build time (the clone and any built ROM are
gitignored), copies our **overlay** in, applies five small **hooks**, and
builds. Personal use only; never distribute the ROM.

```
rom/
├── setup.sh            # clone + overlay + hooks + make modern   → build/mba.gba
├── overlay/
│   ├── include/net/    # mailbox.h (protocol-normative), net.h (public hooks)
│   └── src/            # net_mailbox.c, net_incoming.c, net_overworld.c,
│                       # net_flags.c, net_warp.c, net_battle.c, net_admin.c
└── lua/mba-bridge.lua  # desktop-mGBA bridge (same protocol as the browser)
```

## Build

Linux / WSL2 (see `docs/SETUP-WINDOWS.md` for the Windows path):

```bash
sudo apt install -y build-essential git libpng-dev gcc-arm-none-eabi binutils-arm-none-eabi
./setup.sh
```

Output: `rom/build/mba.gba`.

## Hooks

`setup.sh` inserts these automatically and verifies each; if upstream
pokeemerald drifts and an anchor is missing, apply by hand:

1. **`src/main.c`** — add `#include "net/net.h"`, and call `NetTick();`
   immediately after the first `ReadKeys();` in the `AgbMain` main loop. This
   is the entire per-frame integration: `NetTick()` self-initializes the
   mailbox, pumps both rings, reports presence, and applies queued warps.
2. **`src/event_data.c`** — add `#include "net/net.h"`; call `NetOnFlagSet(id);`
   just before `FlagSet` returns, and `NetOnVarSet(id, value);` right after
   `VarSet` stores the value. (Remote applies are reentrancy-guarded in
   `net_flags.c`.)
3. **`src/battle_setup.c`** — add `#include "net/net.h"`; call
   `NetOnBattleOpen(0, GetMonData(&gEnemyParty[0], MON_DATA_SPECIES, NULL));`
   at the top of `DoStandardWildBattle`, and
   `NetOnBattleOpen(1, gTrainerBattleOpponent_A);` at the top of
   `BattleSetup_StartTrainerBattle` — these open the co-op join window on
   peers' screens when a battle begins.
4. **`src/battle_main.c`** — add `#include "net/net.h"`; call
   `NetOnTurnFinalized();` at the top of
   `CheckFocusPunch_ClearVarsBeforeTurnStarts` (runs once per turn after all
   action/move choices are locked; the hook is emit-only).
5. **`src/new_game.c`** — add `#include "net/net.h"`; in `WarpToTruck`, replace
   the `SetWarpDestination(MAP_GROUP(MAP_INSIDE_OF_TRUCK), …, -1, -1)` line
   with `NetQuickStart();` followed by
   `SetWarpDestination(MAP_GROUP(MAP_LITTLEROOT_TOWN), MAP_NUM(MAP_LITTLEROOT_TOWN), WARP_ID_NONE, 10, 12);`
   — new games skip the truck intro and spawn in Littleroot with the story
   machine pre-completed (default name, running shoes, Pokédex); the starter
   arrives through the web picker (ADMIN `GIVE_MON`).

Everything else lives in overlay files that compile standalone (pokeemerald's
Makefile globs `src/*.c`).

## What works vs. what's next

| Piece | Status |
|---|---|
| Mailbox struct + rings + discovery magic | ✅ complete (`net_mailbox.c`) |
| Presence reporting (map/x/y/facing, change-detected, throttled) | ✅ complete (`net_overworld.c`) |
| Flag/var report + remote apply with reentrancy guard | ✅ complete (`net_flags.c`) |
| Server-driven warps (teleport, regroup) applied on safe frames | ✅ complete (`net_warp.c`) |
| Party summaries, battle session bookkeeping, shared-seed RNG on start | ✅ complete (`net_battle.c`) |
| **Full-party transfer & merged-party injection** — 32-byte wire mons (PROTOCOL §1.5) sent on change; server-merged party staged via BATTLE_CMD PARTY, injected into `gPlayerParty` at co-op START (original party backed up), restored at END | ✅ complete (`net_battle.c`) |
| **Ghost rendering** — a sprite per remote player in the overworld | ✅ complete (`net_overworld.c`): camera-tracked player sprites (Brendan/May by slot), facing anims, map-scoped spawn/despawn, stale-id invalidation across map loads. Tile-snapped; movement interpolation is Phase-1 polish |
| **Battle join window** — encounters announce to peers | ✅ hooks in `DoStandardWildBattle` (wild) and `BattleSetup_StartTrainerBattle` (trainer) via setup.sh |
| **Admin/console commands** — give item/mon, set level/xp, wild battle, trainer reset (PROTOCOL §1.6) | ✅ complete (`net_admin.c`) |
| **Multiplayer quick start** — new games skip the intro, spawn battle-ready in Littleroot | ✅ complete (`net_admin.c` + new_game.c hook) |
| **Battle lockstep** — relayed turn inputs into battle controllers, bag scoping | 🚧 Phase 3 (`docs/ROADMAP.md`); messages, session state, seeding, and party injection are already in place |

## Symbol-drift note

The overlay was written against current pokeemerald conventions
(`gObjectEvents`, `gPlayerAvatar`, `gSaveBlock1Ptr->location`,
`GetPlayerFacingDirection`, `SetWarpDestination`/`DoWarp`, `SeedRng`/`SeedRng2`,
`GetMonData`). If `make modern` reports an undeclared symbol after an upstream
update, these are one-line renames — check the corresponding header named in
the `#include` list of the failing file.

## Desktop bridge

`lua/mba-bridge.lua` runs in stock mGBA (0.10+; dev build recommended):
*Tools → Scripting → Load script*. Configure via environment variables
`MBA_HOST`, `MBA_PORT` (default 8485), `MBA_NAME`, `MBA_AUTOJOIN=1`
(auto-accept co-op battle offers), or edit the CONFIG block. It speaks the
same mailbox + wire protocol as the browser bridge, over mGBA's built-in TCP
sockets to the server's JSON-lines port.
