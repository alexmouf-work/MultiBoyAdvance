// Autosave + save reporting — two mechanisms, one goal: never lose progress,
// never freeze the game for it.
//
// 1. FREEZE-FREE SYNC (every ~10s): a flash save's bytes are a pure function
//    of SaveBlock1/SaveBlock2/PokemonStorage, so instead of running the ~2s
//    flash ceremony we refresh those blocks (CopyPartyAndObjectsToSave — a
//    plain memcpy, microseconds) and publish their addresses + the save
//    counters via NET_MSG_SAVEBLOCKS. The bridge snapshots the bytes between
//    frames and the SERVER forges a byte-exact .sav from them
//    (server/src/saveforge.js mirrors save.c's sector format).
// 2. REAL FLASH SAVES: the player's manual START-menu save, a first save
//    (~15s after joining — creates the emulator-side .sav baseline), and one
//    shortly after each map change (the ~2s pause blends into the door
//    transition). Every success is reported as NET_MSG_SAVED via the save.c
//    hook so the bridge mirrors the .sav to IndexedDB + server.

#include <stddef.h>

#include "global.h"
#include "load_save.h" // CopyPartyAndObjectsToSave
#include "main.h"
#include "overworld.h"
#include "pokemon_storage_system.h" // gPokemonStoragePtr
#include "save.h"
#include "script.h"
#include "net/mailbox.h"
#include "net/net.h"

#define FORGE_INTERVAL_FRAMES (10 * 60) // ~10s between save-block snapshots
#define FIRST_SAVE_FRAMES (15 * 60)     // ~15s after coming online
#define MAP_CHANGE_MIN_FRAMES (15 * 60) // min spacing for map-change saves

static u32 sSinceSave;
static u16 sSinceForge;
static bool8 sSavedOnce;
static bool8 sMapTracked;
static u8 sLastMapGroup;
static u8 sLastMapNum;

#define WR_U32(p, i, v)                        \
    do                                         \
    {                                          \
        (p)[i] = (v)&0xFF;                     \
        (p)[(i) + 1] = ((u32)(v) >> 8) & 0xFF; \
        (p)[(i) + 2] = ((u32)(v) >> 16) & 0xFF; \
        (p)[(i) + 3] = ((u32)(v) >> 24) & 0xFF; \
    } while (0)

// save.c hook: called from TrySavingData's success path only.
void NetOnGameSaved(void)
{
    sSinceSave = 0;
    sSavedOnce = TRUE;
    NetOutWrite(NET_MSG_SAVED, NULL, 0);
    NetLog("saved");
}

// Freshen the save blocks and hand the host everything it needs to forge a
// real .sav without the game freezing: addresses/sizes of the three blocks,
// plus the counter + sector rotation a real save would use next.
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

// Called once per frame from NetTick.
void NetSaveTick(void)
{
    bool8 due;

    if (!NetIsOnline())
    {
        sSinceSave = 0; // offline play (incl. desktop without a bridge): no autosave
        sSinceForge = 0;
        return;
    }
    if (sSinceSave < 0xFFFFFF)
        sSinceSave++;
    sSinceForge++;

    if (gMain.callback2 != CB2_Overworld)
        return; // battles/menus/title: injected co-op parties and half-built
                // saves must never leak into a snapshot or a flash save

    // Freeze-free path: snapshot for the server-side forge.
    if (sSinceForge >= FORGE_INTERVAL_FRAMES)
    {
        sSinceForge = 0;
        EmitSaveBlocks();
    }

    if (ArePlayerFieldControlsLocked())
        return; // flash saves also wait for scripts/dialogs to finish

    due = !sSavedOnce && sSinceSave >= FIRST_SAVE_FRAMES;

    // Map change: save soon after arriving somewhere new.
    if (!sMapTracked || gSaveBlock1Ptr->location.mapGroup != sLastMapGroup
        || gSaveBlock1Ptr->location.mapNum != sLastMapNum)
    {
        if (sMapTracked && sSinceSave >= MAP_CHANGE_MIN_FRAMES)
            due = TRUE;
        sMapTracked = TRUE;
        sLastMapGroup = gSaveBlock1Ptr->location.mapGroup;
        sLastMapNum = gSaveBlock1Ptr->location.mapNum;
    }

    if (due)
        TrySavingData(SAVE_NORMAL); // success resets sSinceSave via the hook
}
