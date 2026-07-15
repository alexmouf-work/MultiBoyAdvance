// Autosave + save reporting.
//
// Every ~10s of play the game writes its own flash save — but only from a
// quiet overworld frame (never at the title, in a battle, in a menu, or while
// a script holds the field); when it isn't possible the save stays due and
// retries next frame. Every SUCCESSFUL save — this autosave or the player's
// manual START-menu save — is reported as NET_MSG_SAVED via the save.c hook,
// so the bridge can mirror the .sav to the browser's IndexedDB and the server.

#include <stddef.h>

#include "global.h"
#include "main.h"
#include "overworld.h"
#include "save.h"
#include "script.h"
#include "net/mailbox.h"
#include "net/net.h"

// A flash save halts the game for ~2s (the real hardware "SAVING…" pause),
// so cadence matters: a quick first save captures the fresh starter, map
// changes save shortly after the transition (the pause blends into having
// just walked through a door), and a heartbeat covers long stretches on one
// map. All deferred until a quiet overworld frame.
#define FIRST_SAVE_FRAMES (15 * 60)     // ~15s after coming online
#define HEARTBEAT_FRAMES (60 * 60)      // ~60s between timed saves
#define MAP_CHANGE_MIN_FRAMES (15 * 60) // min spacing for map-change saves

static u32 sSinceSave;
static bool8 sSavedOnce;
static bool8 sMapTracked;
static u8 sLastMapGroup;
static u8 sLastMapNum;

// save.c hook: called from TrySavingData's success path only.
void NetOnGameSaved(void)
{
    sSinceSave = 0;
    sSavedOnce = TRUE;
    NetOutWrite(NET_MSG_SAVED, NULL, 0);
    NetLog("saved");
}

// Called once per frame from NetTick.
void NetSaveTick(void)
{
    bool8 due;

    if (!NetIsOnline())
    {
        sSinceSave = 0; // offline play (incl. desktop without a bridge): no autosave
        return;
    }
    if (sSinceSave < HEARTBEAT_FRAMES)
        sSinceSave++;

    if (gMain.callback2 != CB2_Overworld || ArePlayerFieldControlsLocked())
        return; // not possible right now — anything due keeps waiting

    due = sSinceSave >= (sSavedOnce ? HEARTBEAT_FRAMES : FIRST_SAVE_FRAMES);

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
