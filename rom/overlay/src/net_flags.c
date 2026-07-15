// Shared story state: report local flag/var writes; apply remote ones.
// Hooked from event_data.c (FlagSet / VarSet) — see rom/README.md.
//
// Reports are DIRTY-TRACKED, not written straight to the ring: bursts like
// new-game init set 159 flags in one frame (~640 bytes of reports into a
// 511-byte ring), which used to silently drop everything written afterwards.
// Instead each set marks a dirty bit and NetFlagsTick drains as much as fits
// per frame, re-reading the live value at send time — drops are impossible,
// reports just arrive a frame or two later.

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

#define FLAG_SPAN (SYNCED_FLAG_MAX - SYNCED_FLAG_MIN + 1)
#define VAR_SPAN (SYNCED_VAR_MAX - SYNCED_VAR_MIN + 1)

// Reentrancy guard: applying a remote flag calls FlagSet, whose hook calls
// NetOnFlagSet — which must not echo it back to the server.
static bool8 sApplyingRemote = FALSE;

static u8 sDirtyFlags[(FLAG_SPAN + 7) / 8]; // ~300B .bss
static u8 sDirtyVars[(VAR_SPAN + 7) / 8];   // 32B .bss
static bool8 sAnyDirty;

void NetOnFlagSet(u16 flagId)
{
    if (sApplyingRemote || !NetIsOnline())
        return;
    if (flagId < SYNCED_FLAG_MIN || flagId > SYNCED_FLAG_MAX)
        return;
    sDirtyFlags[(flagId - SYNCED_FLAG_MIN) >> 3] |= 1 << ((flagId - SYNCED_FLAG_MIN) & 7);
    sAnyDirty = TRUE;
}

void NetOnVarSet(u16 varId, u16 value)
{
    if (sApplyingRemote || !NetIsOnline())
        return;
    if (varId < SYNCED_VAR_MIN || varId > SYNCED_VAR_MAX)
        return;
    sDirtyVars[(varId - SYNCED_VAR_MIN) >> 3] |= 1 << ((varId - SYNCED_VAR_MIN) & 7);
    sAnyDirty = TRUE;
    (void)value; // the live value is re-read at send time
}

// Called once per frame from NetTick: drain dirty reports while the ring has
// room. Bits stay set on a full ring and retry next frame.
void NetFlagsTick(void)
{
    u32 i;
    u8 p[4];

    if (!sAnyDirty || !NetIsOnline())
        return;

    for (i = 0; i < FLAG_SPAN; i++)
    {
        if (sDirtyFlags[i >> 3] & (1 << (i & 7)))
        {
            u16 id = SYNCED_FLAG_MIN + i;

            p[0] = id & 0xFF;
            p[1] = id >> 8;
            if (!NetOutWrite(NET_MSG_FLAG_SET, p, 2))
                return; // ring full — retry next frame
            sDirtyFlags[i >> 3] &= ~(1 << (i & 7));
        }
    }
    for (i = 0; i < VAR_SPAN; i++)
    {
        if (sDirtyVars[i >> 3] & (1 << (i & 7)))
        {
            u16 id = SYNCED_VAR_MIN + i;
            u16 value = VarGet(id);

            p[0] = id & 0xFF;
            p[1] = id >> 8;
            p[2] = value & 0xFF;
            p[3] = value >> 8;
            if (!NetOutWrite(NET_MSG_VAR_SET, p, 4))
                return;
            sDirtyVars[i >> 3] &= ~(1 << (i & 7));
        }
    }
    sAnyDirty = FALSE;
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
