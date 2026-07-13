// Co-op / PvP battle netcode — Phase 3 scaffolding.
//
// Plumbing implemented now: encounter reporting (join-window trigger), session
// bookkeeping from BATTLE_CMD START/INPUT/END, party summaries for the
// server's merge, and the outbound turn-input/outcome writers. What Phase 3
// adds on top: injecting the merged party into gPlayerParty for the session,
// feeding relayed inputs into the battle controllers, seeding gRngValue from
// the shared seed at battle start, and bag scoping. See docs/ROADMAP.md.

#include <stddef.h>

#include "global.h"
#include "pokemon.h"
#include "random.h"
#include "net/mailbox.h"
#include "net/net.h"

struct NetBattleSession
{
    bool8 active;
    u32 seed;
    u8 playerCount;
    u8 order[4];
    u8 mode; // 0=coop 1=pvp
    u8 turnNo;
};

static struct NetBattleSession sSession;

#define RD_U16(p, i) ((u16)((p)[i] | ((p)[(i) + 1] << 8)))

void NetOnBattleOpen(u8 kind, u16 opponent)
{
    u8 p[4];

    if (!NetIsOnline())
        return;
    p[0] = NET_BSUB_START_OR_ENCOUNTER;
    p[1] = kind;
    p[2] = opponent & 0xFF;
    p[3] = opponent >> 8;
    NetOutWrite(NET_MSG_BATTLE_EVENT, p, 4);
}

void NetSendPartySummary(void)
{
    u8 p[1 + 6 * 4];
    u8 count = 0;
    u32 i;

    if (!NetIsOnline())
        return;
    for (i = 0; i < PARTY_SIZE; i++)
    {
        u16 species = GetMonData(&gPlayerParty[i], MON_DATA_SPECIES_OR_EGG, NULL);
        u8 level;
        u8 hpPct;
        u16 hp, maxHp;

        if (species == SPECIES_NONE || species == SPECIES_EGG)
            continue;
        level = GetMonData(&gPlayerParty[i], MON_DATA_LEVEL, NULL);
        hp = GetMonData(&gPlayerParty[i], MON_DATA_HP, NULL);
        maxHp = GetMonData(&gPlayerParty[i], MON_DATA_MAX_HP, NULL);
        hpPct = maxHp ? (u8)((hp * 100) / maxHp) : 0;

        p[1 + count * 4 + 0] = species & 0xFF;
        p[1 + count * 4 + 1] = species >> 8;
        p[1 + count * 4 + 2] = level;
        p[1 + count * 4 + 3] = hpPct;
        count++;
    }
    p[0] = count;
    NetOutWrite(NET_MSG_PARTY_SUMMARY, p, 1 + count * 4);
}

void NetSendTurnInput(u8 action, u8 moveSlot, u8 target, u16 extra)
{
    u8 p[7];

    if (!sSession.active)
        return;
    p[0] = NET_BSUB_TURN_INPUT;
    p[1] = sSession.turnNo;
    p[2] = action;
    p[3] = moveSlot;
    p[4] = target;
    p[5] = extra & 0xFF;
    p[6] = extra >> 8;
    NetOutWrite(NET_MSG_BATTLE_EVENT, p, 7);
}

void NetSendBattleOutcome(u8 result)
{
    u8 p[2];

    if (!sSession.active)
        return;
    p[0] = NET_BSUB_END_OR_OUTCOME;
    p[1] = result;
    NetOutWrite(NET_MSG_BATTLE_EVENT, p, 2);
    sSession.active = FALSE;
}

void NetOnBattleCmd(const u8 *payload, u8 len)
{
    if (len < 1)
        return;

    switch (payload[0])
    {
    case NET_BSUB_START_OR_ENCOUNTER: // START {seed u32, count u8, order[4], mode u8}
        if (len < 11)
            return;
        sSession.active = TRUE;
        sSession.seed = payload[1] | (payload[2] << 8) | ((u32)payload[3] << 16) | ((u32)payload[4] << 24);
        sSession.playerCount = payload[5];
        sSession.order[0] = payload[6];
        sSession.order[1] = payload[7];
        sSession.order[2] = payload[8];
        sSession.order[3] = payload[9];
        sSession.mode = payload[10];
        sSession.turnNo = 0;
        // Deterministic lockstep starts here: every participant seeds the
        // same RNG before the battle engine draws from it.
        SeedRng((u16)sSession.seed);
        SeedRng2((u16)(sSession.seed >> 16));
        break;

    case NET_BSUB_TURN_INPUT: // relayed {turn u8, fromSlot u8, action u8, move u8, tgt u8, extra u16}
        if (len < 8 || !sSession.active)
            return;
        // Phase 3: feed into the battle controller for the acting battler.
        sSession.turnNo = payload[1];
        break;

    case NET_BSUB_END_OR_OUTCOME:
        sSession.active = FALSE;
        break;
    }
}
