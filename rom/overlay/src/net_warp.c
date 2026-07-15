// Server-driven warps (teleport-to-player, battle regroup, PvP staging).
// Warps arrive mid-frame from the bridge; we queue and apply only from a safe
// overworld frame, using the same primitives field scripts use.

#include "global.h"
#include "field_player_avatar.h" // StopPlayerAvatar
#include "field_screen_effect.h" // DoWarp
#include "main.h"
#include "overworld.h"
#include "script.h" // ArePlayerFieldControlsLocked
#include "net/mailbox.h"
#include "net/net.h"

// net_overworld.c: drop ghost sprites before the map tears down.
void NetGhostsHideAll(void);

static struct
{
    bool8 pending;
    u8 mapGroup;
    u8 mapNum;
    s16 x;
    s16 y;
} sWarp;

void NetQueueWarp(u8 mapGroup, u8 mapNum, s16 x, s16 y)
{
    sWarp.pending = TRUE;
    sWarp.mapGroup = mapGroup;
    sWarp.mapNum = mapNum;
    sWarp.x = x;
    sWarp.y = y;
}

void NetWarpTick(void)
{
    if (!sWarp.pending)
        return;
    // Only fire from a quiet overworld frame: not in battle/menus, and not
    // while a script/dialog/another warp holds the field controls — warping
    // mid-script tears the map state (symptom: corrupted "flashing" tiles).
    if (gMain.callback2 != CB2_Overworld || ArePlayerFieldControlsLocked())
        return;

    sWarp.pending = FALSE;
    NetGhostsHideAll(); // our sprites must not outlive the map they're on
    StopPlayerAvatar();
    SetWarpDestination(sWarp.mapGroup, sWarp.mapNum, WARP_ID_NONE, sWarp.x, sWarp.y);
    DoWarp(); // locks field controls itself; the warp-exit callback unlocks
}
