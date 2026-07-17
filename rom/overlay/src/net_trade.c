// Player-to-player trading — the ROM's receiving half (docs/plans/TRADING.md).
//
// The server is the authority: it validates both sides and then routes the
// legs of an accepted trade. Items ride the existing ADMIN GIVE_ITEM/TAKE_ITEM
// path; the giver's side of a Pokémon leg is ADMIN TAKE_MON (net_admin.c).
// This file handles the taker's side: NET_MSG_TRADE_DELIVER carries one
// 32-byte wire mon (§1.5) which we rebuild and hand to GiveMonToPlayer — the
// vanilla party-add that routes to the first free PC box slot when the party
// is full, which is exactly the owner's "overflow goes to the PC" rule.
//
// Discipline (same as net_admin.c): the inbound dispatch only ENQUEUES; the
// party is mutated only from a safe overworld frame. Applied anywhere else
// the mon could be wiped by NewGameInitData or corrupt in-flight state.

#include <stddef.h>
#include <string.h>

#include "global.h"
#include "main.h"
#include "overworld.h"
#include "pokemon.h"
#include "net/mailbox.h"
#include "net/net.h"

#define TRADE_INBOX 6 // one full party's worth of pending deliveries

static EWRAM_DATA u8 sInbox[TRADE_INBOX][NET_MON_WIRE_SIZE] = {0};
static u8 sInboxCount;

// net_incoming.c dispatch: enqueue only; NetTradeTick applies when safe.
void NetOnTradeDeliver(const u8 *payload, u8 len)
{
    if (len < NET_MON_WIRE_SIZE || sInboxCount >= TRADE_INBOX)
        return;
    memcpy(sInbox[sInboxCount], payload, NET_MON_WIRE_SIZE);
    sInboxCount++;
}

// Called once per frame from NetTick.
void NetTradeTick(void)
{
    while (sInboxCount)
    {
        struct Pokemon mon;

        if (gMain.callback2 != CB2_Overworld)
            return; // not safe yet (title, intro, battle, menus)

        MonFromWire(sInbox[0], &mon);
        GiveMonToPlayer(&mon); // party, or the PC when the party is full
        NetLog("trade: mon received");

        sInboxCount--;
        memmove(sInbox[0], sInbox[1], (size_t)sInboxCount * NET_MON_WIRE_SIZE);

        NetSendFullParty(); // re-report so the server's copy stays current
        NetSendPartySummary();
    }
}
