// Server-driven warps (teleport-to-player, battle regroup, PvP staging).
// Warps arrive mid-frame from the bridge; we queue and apply only from a safe
// overworld frame, using the same primitives field scripts use.

#include "global.h"
#include "main.h"
#include "overworld.h"
#include "net/mailbox.h"
#include "net/net.h"

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
    if (gMain.callback2 != CB2_Overworld)
        return; // wait for a safe frame (not in battle/menu/script transition)

    sWarp.pending = FALSE;
    SetWarpDestination(sWarp.mapGroup, sWarp.mapNum, WARP_ID_NONE, sWarp.x, sWarp.y);
    DoWarp();
}
