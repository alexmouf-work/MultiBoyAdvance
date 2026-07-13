// Shared story state: report local flag/var writes; apply remote ones.
// Hooked from event_data.c (FlagSet / VarSet) — see rom/README.md.

#include "global.h"
#include "event_data.h"
#include "net/mailbox.h"
#include "net/net.h"

// Mirror of the server's synced ranges (server/src/config.js). The server
// filters authoritatively; this local filter just keeps ring traffic down.
#define SYNCED_FLAG_MIN 0x020
#define SYNCED_FLAG_MAX 0x97F
#define SYNCED_VAR_MIN 0x4000
#define SYNCED_VAR_MAX 0x40FF

// Reentrancy guard: applying a remote flag calls FlagSet, whose hook calls
// NetOnFlagSet — which must not echo it back to the server.
static bool8 sApplyingRemote = FALSE;

void NetOnFlagSet(u16 flagId)
{
    u8 p[2];

    if (sApplyingRemote || !NetIsOnline())
        return;
    if (flagId < SYNCED_FLAG_MIN || flagId > SYNCED_FLAG_MAX)
        return;
    p[0] = flagId & 0xFF;
    p[1] = flagId >> 8;
    NetOutWrite(NET_MSG_FLAG_SET, p, 2);
}

void NetOnVarSet(u16 varId, u16 value)
{
    u8 p[4];

    if (sApplyingRemote || !NetIsOnline())
        return;
    if (varId < SYNCED_VAR_MIN || varId > SYNCED_VAR_MAX)
        return;
    p[0] = varId & 0xFF;
    p[1] = varId >> 8;
    p[2] = value & 0xFF;
    p[3] = value >> 8;
    NetOutWrite(NET_MSG_VAR_SET, p, 4);
}

void NetApplyRemoteFlag(u16 flagId)
{
    sApplyingRemote = TRUE;
    FlagSet(flagId);
    sApplyingRemote = FALSE;
}

void NetApplyRemoteVar(u16 varId, u16 value)
{
    sApplyingRemote = TRUE;
    VarSet(varId, value);
    sApplyingRemote = FALSE;
}
