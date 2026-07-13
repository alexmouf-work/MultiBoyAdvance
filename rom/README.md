# rom/ — the netcode ROM

This directory turns [pret/pokeemerald](https://github.com/pret/pokeemerald)
into the MultiBoyAdvance game. Nothing of Nintendo's is stored here: `setup.sh`
clones the decompilation at build time (the clone and any built ROM are
gitignored), copies our **overlay** in, applies three small **hooks**, and
builds. Personal use only; never distribute the ROM.

```
rom/
├── setup.sh            # clone + overlay + hooks + make modern   → build/mba.gba
├── overlay/
│   ├── include/net/    # mailbox.h (protocol-normative), net.h (public hooks)
│   └── src/            # net_mailbox.c, net_incoming.c, net_overworld.c,
│                       # net_flags.c, net_warp.c, net_battle.c
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
3. *(Phase 1.5, optional now)* **`src/battle_setup.c`** — call
   `NetOnBattleOpen(kind, trainerOrSpecies);` where wild/trainer battles are
   set up, to open the co-op join window.

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
| **Ghost rendering** — a sprite per remote player in the overworld | 🚧 Phase 1: implement `RenderGhosts()` in `net_overworld.c`. Recommended: one `CreateObjectGraphicsSprite(OBJ_EVENT_GFX_RIVAL_BRENDAN_NORMAL, …)` per active ghost on the current map, positioned from tile coords ×16 minus camera offset; despawn via `DestroySprite` when `active` drops. `gNetGhosts[]` is already live data |
| **Battle lockstep** — merged-party injection, relayed turn inputs into battle controllers, bag scoping | 🚧 Phase 3 (`docs/ROADMAP.md`); the messages and session state are already plumbed |

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
