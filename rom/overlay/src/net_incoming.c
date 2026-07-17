// Dispatch of host -> game TLVs into game state.

#include "global.h"
#include "event_data.h"
#include "net/mailbox.h"
#include "net/net.h"

struct NetGhost gNetGhosts[NET_MAX_PLAYERS];

// net_flags.c
void NetApplyRemoteFlag(u16 flagId);
void NetApplyRemoteVar(u16 varId, u16 value);
// net_warp.c
void NetQueueWarp(u8 mapGroup, u8 mapNum, s16 x, s16 y);
// net_battle.c
void NetOnBattleCmd(const u8 *payload, u8 len);
// net_admin.c
void NetOnAdminCmd(const u8 *payload, u8 len);

#define RD_S16(p, i) ((s16)((p)[i] | ((p)[(i) + 1] << 8)))
#define RD_U16(p, i) ((u16)((p)[i] | ((p)[(i) + 1] << 8)))

static void ApplyGhost(const u8 *p, u8 len)
{
    u8 slot;
    struct NetGhost *g;

    if (len < 10)
        return;
    slot = p[0];
    if (slot >= NET_MAX_PLAYERS)
        return;
    g = &gNetGhosts[slot];
    g->active = p[1];
    g->mapGroup = p[2];
    g->mapNum = p[3];
    g->x = RD_S16(p, 4);
    g->y = RD_S16(p, 6);
    g->facing = p[8];
    g->moveState = p[9];
    if (g->moveState == 255)
        g->active = FALSE;
}

void NetApplyIncoming(void)
{
    u8 type;
    u8 len;
    u8 payload[255];
    u8 budget = 32; // bound per-frame work; the ring carries the backlog

    while (budget-- && NetInRead(&type, payload, &len))
    {
        switch (type)
        {
        case NET_MSG_GHOST:
            ApplyGhost(payload, len);
            break;
        case NET_MSG_FLAG_APPLY:
            if (len >= 2)
                NetApplyRemoteFlag(RD_U16(payload, 0));
            break;
        case NET_MSG_VAR_APPLY:
            if (len >= 4)
                NetApplyRemoteVar(RD_U16(payload, 0), RD_U16(payload, 2));
            break;
        case NET_MSG_WARP:
            if (len >= 6)
                NetQueueWarp(payload[0], payload[1], RD_S16(payload, 2), RD_S16(payload, 4));
            break;
        case NET_MSG_ASSIGN:
            if (len >= 1)
                gNetMailbox.playerSlot = payload[0];
            break;
        case NET_MSG_BATTLE_CMD:
            NetOnBattleCmd(payload, len);
            break;
        case NET_MSG_ADMIN:
            NetOnAdminCmd(payload, len);
            break;
        case NET_MSG_TRADE_DELIVER:
            NetOnTradeDeliver(payload, len);
            break;
        default:
            break; // forward-compatible: skip unknown types
        }
    }
}
