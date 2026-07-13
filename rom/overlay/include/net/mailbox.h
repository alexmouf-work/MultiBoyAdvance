// MultiBoyAdvance EWRAM mailbox — the game/bridge contract.
// NORMATIVE layout: docs/PROTOCOL.md §1. The JS (web/js/bridge/mailbox.js)
// and Lua (rom/lua/mba-bridge.lua) codecs mirror this file byte-for-byte.
#ifndef GUARD_NET_MAILBOX_H
#define GUARD_NET_MAILBOX_H

#include "global.h"

#define NET_PROTO_VERSION 1
#define NET_RING_SIZE 512

// header.gameState
enum {
    NET_GSTATE_BOOT = 0,
    NET_GSTATE_OVERWORLD = 1,
    NET_GSTATE_BATTLE = 2,
    NET_GSTATE_MENU = 3,
    NET_GSTATE_OTHER = 4,
};

// game -> host TLV types (0x01-0x7F)
enum {
    NET_MSG_PRESENCE = 0x01,      // mapGroup u8, mapNum u8, x s16, y s16, facing u8, moveState u8
    NET_MSG_FLAG_SET = 0x02,      // flagId u16
    NET_MSG_VAR_SET = 0x03,       // varId u16, value u16
    NET_MSG_PARTY_SUMMARY = 0x05, // count u8, {species u16, level u8, hpPct u8} * count
    NET_MSG_REQUEST = 0x06,       // sub u8 (1=tp 2=pvp 3=pvp-accept), arg u8
    NET_MSG_BATTLE_EVENT = 0x10,  // sub u8: 1=encounter{kind u8,opp u16} 2=input 3=outcome{result u8}
    NET_MSG_HELLO = 0x7F,         // version u8
};

// host -> game TLV types (0x80-0xFF)
enum {
    NET_MSG_GHOST = 0x81,      // slot u8, active u8, mapGroup u8, mapNum u8, x s16, y s16, facing u8, moveState u8
    NET_MSG_FLAG_APPLY = 0x82, // flagId u16
    NET_MSG_VAR_APPLY = 0x83,  // varId u16, value u16
    NET_MSG_WARP = 0x85,       // mapGroup u8, mapNum u8, x s16, y s16
    NET_MSG_ASSIGN = 0x86,     // slot u8
    NET_MSG_BATTLE_CMD = 0x90, // sub u8: 1=start{seed u32,count u8,order[4],mode u8} 2=input 3=end{result u8}
};

// battle sub-messages
enum {
    NET_BSUB_START_OR_ENCOUNTER = 1,
    NET_BSUB_TURN_INPUT = 2,
    NET_BSUB_END_OR_OUTCOME = 3,
};

struct NetRing
{
    u16 head; // next write index (owned by producer)
    u16 tail; // next read index (owned by consumer)
    u8 buf[NET_RING_SIZE];
};

struct NetMailbox
{
    u8 magic[4];   // 'M','B','A','0'
    u8 version;    // NET_PROTO_VERSION
    u8 gameState;  // NET_GSTATE_*
    u16 frameCounter;
    u8 playerSlot;   // 0xFF until assigned by the host bridge
    u8 hostAttached; // bridge writes 1 when it finds us
    u8 reserved[6];
    struct NetRing out; // game -> host
    struct NetRing in;  // host -> game
};

// 16-byte header + 2 * (4 + 512) = 1048; the codecs hard-code these offsets.
STATIC_ASSERT(sizeof(struct NetRing) == 516, NetRingSize);
STATIC_ASSERT(sizeof(struct NetMailbox) == 1048, NetMailboxSize);

extern volatile struct NetMailbox gNetMailbox;

// ring ops (net_mailbox.c)
bool8 NetOutWrite(u8 type, const u8 *payload, u8 len);
bool8 NetInRead(u8 *type, u8 *payload, u8 *len); // payload buffer must hold 255 bytes

#endif // GUARD_NET_MAILBOX_H
