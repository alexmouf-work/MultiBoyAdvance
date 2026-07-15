// Overworld presence: report our position; render remote players as ghosts.
//
// Ghosts are plain sprites using the player-character overworld graphics —
// deliberately NOT full object events, so they can never collide with the
// local player, trigger scripts, or occupy object-event slots the maps need.
// Position updates snap to tiles (interpolation is Phase-1 polish).

#include "global.h"
#include "constants/event_objects.h"
#include "event_object_movement.h"
#include "field_player_avatar.h"
#include "main.h"
#include "overworld.h"
#include "sprite.h"
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

// NOTE: the modern ld script discards .data — statics here must be
// zero-initialized (.bss) or const.
static u8 sGhostFacing[NET_MAX_PLAYERS];
static bool8 sMapTracked;
static u8 sLastMapGroup;
static u8 sLastMapNum;

static void GhostDespawn(struct NetGhost *g)
{
    if (g->spriteId != SPRITE_NONE)
    {
        DestroySprite(&gSprites[g->spriteId]);
        g->spriteId = SPRITE_NONE;
    }
}

static void GhostPlaceSprite(struct Sprite *sprite, s16 tileX, s16 tileY)
{
    // Same placement idiom the object-event system uses.
    SetSpritePosToMapCoords(tileX, tileY, &sprite->x, &sprite->y);
    sprite->x += 8;
    sprite->y += 16 + sprite->centerToCornerVecY;
}

// Destroy every ghost sprite now (before a warp/map teardown) and force a
// clean re-track on the next overworld frame.
void NetGhostsHideAll(void)
{
    u32 i;

    for (i = 0; i < NET_MAX_PLAYERS; i++)
        GhostDespawn(&gNetGhosts[i]);
    sMapTracked = FALSE;
}

// One sprite per active ghost on the local player's current map.
static void RenderGhosts(void)
{
    u8 localGroup = gSaveBlock1Ptr->location.mapGroup;
    u8 localNum = gSaveBlock1Ptr->location.mapNum;
    u32 i;

    // A map load frees every sprite, so our cached ids are stale, not live —
    // forget them without destroying. Also runs on the very first frame,
    // clearing the zero-initialized (and therefore aliasing) sprite ids.
    if (!sMapTracked || localGroup != sLastMapGroup || localNum != sLastMapNum)
    {
        for (i = 0; i < NET_MAX_PLAYERS; i++)
            gNetGhosts[i].spriteId = SPRITE_NONE;
        sMapTracked = TRUE;
        sLastMapGroup = localGroup;
        sLastMapNum = localNum;
    }

    for (i = 0; i < NET_MAX_PLAYERS; i++)
    {
        struct NetGhost *g = &gNetGhosts[i];
        bool8 visible = g->active && g->mapGroup == localGroup && g->mapNum == localNum;

        if (!visible)
        {
            GhostDespawn(g);
            continue;
        }

        if (g->spriteId == SPRITE_NONE)
        {
            u16 gfx = (i & 1) ? OBJ_EVENT_GFX_MAY_NORMAL : OBJ_EVENT_GFX_BRENDAN_NORMAL;
            u8 spriteId = CreateObjectGraphicsSprite(gfx, SpriteCallbackDummy, 0, 0, 102);

            if (spriteId >= MAX_SPRITES)
                continue; // sprite pool exhausted this frame; retry next frame
            g->spriteId = spriteId;
            gSprites[spriteId].coordOffsetEnabled = TRUE; // follow the camera
            gSprites[spriteId].oam.priority = 2;          // same layer as NPCs
            sGhostFacing[i] = 0;
        }

        GhostPlaceSprite(&gSprites[g->spriteId], g->x, g->y);
        if (g->facing != sGhostFacing[i] && g->facing >= 1 && g->facing <= 4)
        {
            StartSpriteAnim(&gSprites[g->spriteId], GetFaceDirectionAnimNum(g->facing));
            sGhostFacing[i] = g->facing;
        }
    }
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
