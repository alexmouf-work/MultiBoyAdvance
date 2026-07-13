// MultiBoyAdvance netcode — public hooks. Integration points: rom/README.md.
#ifndef GUARD_NET_NET_H
#define GUARD_NET_NET_H

#include "global.h"

// Call once per frame from the main loop (after ReadKeys() in AgbMain).
// Self-initializes on first call; safe to call before anything else runs.
void NetTick(void);

// event_data.c hooks — call at the end of FlagSet / VarSet.
void NetOnFlagSet(u16 flagId);
void NetOnVarSet(u16 varId, u16 value);

// battle_setup.c hook (Phase 1.5+) — call when a battle is being set up,
// before the transition starts, so peers get a join window.
void NetOnBattleOpen(u8 kind, u16 opponent);

// Ghost state for other players (net_overworld.c owns rendering in Phase 1).
struct NetGhost
{
    u8 active;
    u8 mapGroup;
    u8 mapNum;
    s16 x;
    s16 y;
    u8 facing;
    u8 moveState;
    u8 spriteId; // SPRITE_NONE when not rendered
};

#define NET_MAX_PLAYERS 8
extern struct NetGhost gNetGhosts[NET_MAX_PLAYERS];

// True while a host bridge is attached (drives online UI affordances).
bool8 NetIsOnline(void);

#endif // GUARD_NET_NET_H
