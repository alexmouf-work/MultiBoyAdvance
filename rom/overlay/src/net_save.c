// Autosave + save reporting — freeze-free by construction.
//
// A flash save's bytes are a pure function of SaveBlock1/SaveBlock2/
// PokemonStorage, so instead of running pokeemerald's ~2s flash ceremony (which
// hard-freezes the overworld and eats input) we refresh those blocks
// (CopyPartyAndObjectsToSave — a plain memcpy, microseconds) and publish their
// addresses + the save counters via NET_MSG_SAVEBLOCKS every ~10s. The bridge
// snapshots the bytes between frames and the SERVER forges a byte-exact .sav
// from them (server/src/saveforge.js mirrors save.c's sector format).
//
// That means the game NEVER runs a flash save on its own for networking — no
// periodic freeze, and no jarring 1-2s pause when you walk through a door or
// into a new area (which is exactly when a real save used to fire). The only
// flash saves left are the ones the player asks for from the START menu; those
// still report NET_MSG_SAVED (via the save.c hook) so the bridge mirrors the
// resulting .sav to IndexedDB + server too.

#include <stddef.h>

#include "global.h"
#include "load_save.h" // CopyPartyAndObjectsToSave
#include "main.h"
#include "overworld.h" // CB2_Overworld
#include "pokemon_storage_system.h" // gPokemonStoragePtr
#include "save.h" // gSaveCounter, gLastWrittenSector
#include "net/mailbox.h"
#include "net/net.h"

#define FORGE_INTERVAL_FRAMES (10 * 60) // ~10s between save-block snapshots
#define FIRST_FORGE_FRAMES (3 * 60)     // first snapshot ~3s after coming online

// Zero-init (.bss): pokeemerald's modern ld script DISCARDS .data, so a
// non-zero static initializer would fail to link. The offline branch of
// NetSaveTick pre-charges this every frame before the player is ever online,
// so the first snapshot after joining still lands ~3s in (not ~10s).
static u16 sSinceForge;

#define WR_U32(p, i, v)                        \
    do                                         \
    {                                          \
        (p)[i] = (v)&0xFF;                     \
        (p)[(i) + 1] = ((u32)(v) >> 8) & 0xFF; \
        (p)[(i) + 2] = ((u32)(v) >> 16) & 0xFF; \
        (p)[(i) + 3] = ((u32)(v) >> 24) & 0xFF; \
    } while (0)

// save.c hook: called from TrySavingData's success path (a player's manual
// START-menu save). Reports it so the bridge mirrors the fresh .sav out too.
void NetOnGameSaved(void)
{
    NetOutWrite(NET_MSG_SAVED, NULL, 0);
    NetLog("saved");
}

// Freshen the save blocks and hand the host everything it needs to forge a real
// .sav without the game freezing: addresses/sizes of the three blocks, plus the
// counter + sector rotation a real save would use next.
static void EmitSaveBlocks(void)
{
    u8 p[33];

    CopyPartyAndObjectsToSave(); // party + object events -> SaveBlock1 (memcpy-fast)

    WR_U32(p, 0, (u32)&gNetMailbox);
    WR_U32(p, 4, gSaveCounter);
    p[8] = (u8)gLastWrittenSector;
    WR_U32(p, 9, (u32)gSaveBlock2Ptr);
    WR_U32(p, 13, sizeof(struct SaveBlock2));
    WR_U32(p, 17, (u32)gSaveBlock1Ptr);
    WR_U32(p, 21, sizeof(struct SaveBlock1));
    WR_U32(p, 25, (u32)gPokemonStoragePtr);
    WR_U32(p, 29, sizeof(struct PokemonStorage));
    NetOutWrite(NET_MSG_SAVEBLOCKS, p, sizeof(p));
}

// Called once per frame from NetTick. Freeze-free: it only ever memcpys the
// save blocks and emits their addresses; it never calls TrySavingData.
void NetSaveTick(void)
{
    if (!NetIsOnline())
    {
        // Offline play (incl. desktop without a bridge): no autosave. Reset the
        // counter pre-charged so the first snapshot after (re)joining is prompt.
        sSinceForge = FORGE_INTERVAL_FRAMES - FIRST_FORGE_FRAMES;
        return;
    }

    if (gMain.callback2 != CB2_Overworld)
        return; // battles/menus/title: injected co-op parties and half-built
                // saves must never leak into a snapshot

    if (++sSinceForge >= FORGE_INTERVAL_FRAMES)
    {
        sSinceForge = 0;
        EmitSaveBlocks();
    }
}
