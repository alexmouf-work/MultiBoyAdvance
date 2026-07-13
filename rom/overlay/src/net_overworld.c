// Overworld presence: report our position; own the ghost render slots.
//
// Phase 1 status: PRESENCE reporting is complete. Ghost *rendering* (spawning
// a sprite per remote player) is the designated Phase-1 build task — the state
// arrives in gNetGhosts (net_incoming.c); RenderGhosts() below is the seam,
// with the recommended approach documented in rom/README.md.

#include "global.h"
#include "event_object_movement.h"
#include "field_player_avatar.h"
#include "main.h"
#include "overworld.h"
#include "net/mailbox.h"
#include "net/net.h"

static u8 sLast[8]; // last PRESENCE payload we sent
static bool8 sHaveLast = FALSE;
static u8 sThrottle = 0;

#define WR_S16(p, i, v)         \
    do                          \
    {                           \
        (p)[i] = (v)&0xFF;      \
        (p)[(i) + 1] = ((u16)(v) >> 8) & 0xFF; \
    } while (0)

static bool8 InOverworld(void)
{
    return gMain.callback2 == CB2_Overworld;
}

static void SendPresenceIfChanged(void)
{
    u8 p[8];
    struct ObjectEvent *player;
    u32 i;

    if (gPlayerAvatar.objectEventId >= OBJECT_EVENTS_COUNT)
        return;
    player = &gObjectEvents[gPlayerAvatar.objectEventId];

    p[0] = gSaveBlock1Ptr->location.mapGroup;
    p[1] = gSaveBlock1Ptr->location.mapNum;
    WR_S16(p, 2, player->currentCoords.x);
    WR_S16(p, 4, player->currentCoords.y);
    p[6] = GetPlayerFacingDirection();
    p[7] = 0; // moveState: reserved for run/bike/surf animation hints

    if (sHaveLast)
    {
        for (i = 0; i < sizeof(p); i++)
            if (p[i] != sLast[i])
                break;
        if (i == sizeof(p))
            return; // unchanged
    }

    // ~10/s cap; the bridge throttles too, this just avoids ring churn.
    if (sThrottle != 0)
        return;
    sThrottle = 6;

    if (NetOutWrite(NET_MSG_PRESENCE, p, sizeof(p)))
    {
        for (i = 0; i < sizeof(p); i++)
            sLast[i] = p[i];
        sHaveLast = TRUE;
    }
}

// Phase-1 seam: draw/update one sprite per active ghost on the current map.
// Recommended: CreateObjectGraphicsSprite(OBJ_EVENT_GFX_RIVAL_BRENDAN_NORMAL,
// ...) per ghost, repositioned via sprite->x/y from ghost tile coords — see
// rom/README.md ("Ghost rendering").
static void RenderGhosts(void)
{
}

void NetOverworldTick(void)
{
    if (sThrottle)
        sThrottle--;

    if (!InOverworld())
    {
        gNetMailbox.gameState = NET_GSTATE_OTHER;
        return;
    }
    gNetMailbox.gameState = NET_GSTATE_OVERWORLD;

    if (!NetIsOnline())
        return;

    SendPresenceIfChanged();
    RenderGhosts();
}
